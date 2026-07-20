import { OAuth2Client, OAuth2Token } from '@badgateway/oauth2-client';
import {
  CredentialType,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type JiraOAuthMetadata,
  type GoogleOAuthMetadata,
} from '@bubblelab/shared-schemas';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { CredentialEncryption } from '../utils/encryption.js';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';

/**
 * The OAuth account email recorded on a credential's metadata (GoogleOAuthMetadata et al),
 * when present — used as login_hint so incremental re-consent lands on the SAME account.
 */
function extractMetadataEmail(metadata: unknown): string | undefined {
  if (
    metadata !== null &&
    typeof metadata === 'object' &&
    'email' in metadata
  ) {
    const email: unknown = metadata.email;
    if (typeof email === 'string' && email.length > 0) {
      return email;
    }
  }
  return undefined;
}

export interface OAuthAuthorizationUrl {
  authUrl: string;
  state: string;
}

export interface OAuthCallbackResult {
  credentialId: number;
  token: OAuth2Token;
}

export interface StoredOAuthCredential {
  id: number;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
  provider: string;
}

/**
 * OAuth service that handles OAuth flows, token management, and refresh
 * Uses @badgateway/oauth2-client for OAuth 2.0 operations
 *
 * ## References (Google incremental authorization + token introspection)
 * - Incremental authorization (`include_granted_scopes=true` on
 *   https://accounts.google.com/o/oauth2/v2/auth; the returned token also covers
 *   every scope the user previously granted the application):
 *   https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth
 * - tokeninfo introspection (GET https://oauth2.googleapis.com/tokeninfo?access_token=...
 *   returns `scope` as space-delimited case-sensitive strings, plus aud/azp/expires_in):
 *   https://docs.cloud.google.com/docs/authentication/token-types
 * - OIDC userinfo (email identity; OIDC scopes combine with API scopes in one request):
 *   https://developers.google.com/identity/openid-connect/openid-connect
 * Verified against these pages on 2026-07-20.
 */
export class OAuthService {
  private clients: Map<string, OAuth2Client> = new Map();
  private stateStore: Map<
    string,
    {
      userId: string;
      provider: string;
      credentialType: CredentialType;
      credentialName?: string;
      timestamp: number;
      scopes: string[];
      /** Incremental re-consent: existing credential row the callback must UPDATE (no insert). */
      credentialId?: number;
    }
  > = new Map();

  constructor() {
    this.setupOAuthClients();

    // Clean up expired states every 10 minutes
    setInterval(() => this.cleanupExpiredStates(), 10 * 60 * 1000);
  }

  /**
   * Initialize OAuth clients for supported providers
   */
  private setupOAuthClients(): void {
    // Google OAuth 2.0 configuration
    if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
      this.clients.set(
        'google',
        new OAuth2Client({
          server: 'https://oauth2.googleapis.com',
          clientId: env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenEndpoint: '/token',
        })
      );
    } else {
      console.warn(
        'Google OAuth credentials not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET'
      );
    }

    // Follow Up Boss OAuth 2.0 configuration
    if (env.FUB_OAUTH_CLIENT_ID && env.FUB_OAUTH_CLIENT_SECRET) {
      this.clients.set(
        'followupboss',
        new OAuth2Client({
          server: 'https://app.followupboss.com',
          clientId: env.FUB_OAUTH_CLIENT_ID,
          clientSecret: env.FUB_OAUTH_CLIENT_SECRET,
          authorizationEndpoint: '/oauth/authorize',
          tokenEndpoint: '/oauth/token',
        })
      );
    } else {
      console.warn(
        'Follow Up Boss OAuth credentials not configured. Set FUB_OAUTH_CLIENT_ID and FUB_OAUTH_CLIENT_SECRET'
      );
    }

    // Notion OAuth 2.0 configuration
    if (env.NOTION_OAUTH_CLIENT_ID && env.NOTION_OAUTH_CLIENT_SECRET) {
      this.clients.set(
        'notion',
        new OAuth2Client({
          server: 'https://api.notion.com',
          clientId: env.NOTION_OAUTH_CLIENT_ID,
          clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
          authorizationEndpoint: '/v1/oauth/authorize',
          tokenEndpoint: '/v1/oauth/token',
        })
      );
    } else {
      console.warn(
        'Notion OAuth credentials not configured. Set NOTION_OAUTH_CLIENT_ID and NOTION_OAUTH_CLIENT_SECRET'
      );
    }

    // Jira OAuth 2.0 configuration (Atlassian Cloud)
    if (env.JIRA_OAUTH_CLIENT_ID && env.JIRA_OAUTH_CLIENT_SECRET) {
      this.clients.set(
        'jira',
        new OAuth2Client({
          server: 'https://auth.atlassian.com',
          clientId: env.JIRA_OAUTH_CLIENT_ID,
          clientSecret: env.JIRA_OAUTH_CLIENT_SECRET,
          authorizationEndpoint: '/authorize',
          tokenEndpoint: 'https://auth.atlassian.com/oauth/token',
        })
      );
    } else {
      console.warn(
        'Jira OAuth credentials not configured. Set JIRA_OAUTH_CLIENT_ID and JIRA_OAUTH_CLIENT_SECRET'
      );
    }
  }

  /**
   * Initiate OAuth authorization flow for a specific credential type
   */
  async initiateOAuth(
    provider: OAuthProvider,
    userId: string,
    credentialType: CredentialType,
    credentialName?: string,
    scopes?: string[],
    existingCredentialId?: number
  ): Promise<OAuthAuthorizationUrl> {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(
        `OAuth provider '${provider}' not supported, please ensure OAUTH CLIENTS and SECRETS are configured`
      );
    }

    // Generate secure state parameter
    const state = crypto.randomUUID();
    const timestamp = Date.now();

    // Incremental re-consent: the authorization ADDS scopes to an existing grant and the
    // callback updates that credential row in place. Google's include_granted_scopes=true
    // makes the returned token cover previously granted scopes too, so requesting only the
    // missing scopes yields a token for the accumulated set. See ## References above.
    const extraAuthParams: Record<string, string> = {};
    let effectiveCredentialType = credentialType;
    if (existingCredentialId !== undefined) {
      const credential = await db.query.userCredentials.findFirst({
        where: and(
          eq(userCredentials.id, existingCredentialId),
          eq(userCredentials.userId, userId)
        ),
      });
      if (
        !credential ||
        !credential.isOauth ||
        credential.oauthProvider !== provider
      ) {
        throw new Error(
          `Credential ${existingCredentialId} is not an OAuth credential of provider '${provider}' owned by this user`
        );
      }
      // The row keeps its credential type — scopes, not the type, decide capability.
      effectiveCredentialType = credential.credentialType as CredentialType;
      if (provider === 'google') {
        extraAuthParams.include_granted_scopes = 'true';
        const email = extractMetadataEmail(credential.metadata);
        if (email) {
          extraAuthParams.login_hint = email;
        }
      }
    }

    // Validate that the credential type is supported by this provider
    this.getCredentialConfig(provider, effectiveCredentialType);

    const redirectUri = `${env.NODEX_API_URL || 'http://localhost:3001'}/oauth/${provider}/callback`;
    const defaultScopes = this.getDefaultScopes(
      provider,
      effectiveCredentialType
    );
    let requestedScopes = scopes || defaultScopes;

    // Google: always add the OIDC identity scopes so the callback can resolve WHICH account
    // was connected (email) via the UserInfo endpoint. That identity feeds the account
    // dropdowns and setup-field auto-population in the studio. Google documents combining
    // OIDC scopes with API scopes in one authorization request:
    // https://developers.google.com/identity/openid-connect/openid-connect ("your scope
    // argument can also include other scope values", example: "openid profile email
    // https://www.googleapis.com/auth/drive.file").
    if (provider === 'google') {
      requestedScopes = [...new Set([...requestedScopes, 'openid', 'email'])];
    }

    console.log(
      '[OAuthService] Requested redirect URI, default scopes, and requested scopes:',
      redirectUri,
      defaultScopes,
      requestedScopes
    );

    // Store state for CSRF protection with requested scopes (expires in 10 minutes)
    this.stateStore.set(state, {
      userId,
      provider,
      credentialType: effectiveCredentialType,
      credentialName,
      timestamp,
      scopes: requestedScopes,
      credentialId: existingCredentialId,
    });

    try {
      // Get provider-specific authorization parameters from centralized config
      const providerConfig = OAUTH_PROVIDERS[provider];
      const authorizationParams = providerConfig?.authorizationParams || {};

      const authUrl = await client.authorizationCode.getAuthorizeUri({
        redirectUri,
        scope: requestedScopes,
        state,
        ...authorizationParams,
      });

      // Check if our parameters are actually in the URL and manually add if missing
      const urlObj = new URL(authUrl);

      // If parameters are missing or need to be overridden, set them
      if (
        !urlObj.searchParams.has('access_type') &&
        authorizationParams.access_type
      ) {
        urlObj.searchParams.set('access_type', authorizationParams.access_type);
      }
      if (!urlObj.searchParams.has('prompt') && authorizationParams.prompt) {
        urlObj.searchParams.set('prompt', authorizationParams.prompt);
      }
      // FUB uses non-standard 'auth_code' instead of 'code'
      if (authorizationParams.response_type) {
        urlObj.searchParams.set(
          'response_type',
          authorizationParams.response_type
        );
      }
      // Incremental re-consent params (include_granted_scopes, login_hint) — the OAuth2
      // client library does not know them, so set them on the final URL directly.
      for (const [param, value] of Object.entries(extraAuthParams)) {
        urlObj.searchParams.set(param, value);
      }

      const finalAuthUrl = urlObj.toString();

      return { authUrl: finalAuthUrl, state };
    } catch (error) {
      // Clean up state on error
      this.stateStore.delete(state);
      throw new Error(
        `Failed to generate OAuth authorization URL: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Handle OAuth callback and exchange code for tokens
   */
  async handleOAuthCallback(
    provider: string,
    code: string,
    state: string,
    credentialName?: string
  ): Promise<OAuthCallbackResult> {
    // Validate state parameter
    const stateData = this.stateStore.get(state);
    if (!stateData || stateData.provider !== provider) {
      throw new Error('Invalid or expired state parameter');
    }

    // Check state expiration (10 minutes)
    if (Date.now() - stateData.timestamp > 10 * 60 * 1000) {
      this.stateStore.delete(state);
      throw new Error('State parameter expired');
    }

    // Clean up state
    this.stateStore.delete(state);

    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`OAuth provider '${provider}' not supported`);
    }

    const redirectUri = `${env.NODEX_API_URL || 'http://localhost:3001'}/oauth/${provider}/callback`;

    try {
      let token;

      // FUB requires manual token exchange due to non-standard requirements
      if (provider === 'followupboss') {
        const basicAuth = Buffer.from(
          `${env.FUB_OAUTH_CLIENT_ID}:${env.FUB_OAUTH_CLIENT_SECRET}`
        ).toString('base64');

        const tokenResponse = await fetch(
          'https://app.followupboss.com/oauth/token',
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${basicAuth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirectUri,
              state,
            }).toString(),
          }
        );

        const responseText = await tokenResponse.text();
        console.log('[FUB OAuth] Token response status:', tokenResponse.status);
        console.log('[FUB OAuth] Token response body:', responseText);

        if (!tokenResponse.ok) {
          throw new Error(
            `FUB token exchange failed: ${tokenResponse.status} - ${responseText}`
          );
        }

        const tokenData = JSON.parse(responseText);
        token = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_in
            ? Date.now() + tokenData.expires_in * 1000
            : undefined,
        };
      } else {
        // Standard OAuth flow for other providers
        token = await client.authorizationCode.getToken({
          code,
          redirectUri,
        });
      }

      if (!token.refreshToken) {
        console.warn(
          'No refresh token received - user may need to re-authorize'
        );
      }

      // For Jira, fetch accessible resources to get Cloud ID
      let jiraMetadata: JiraOAuthMetadata | undefined;
      if (provider === 'jira') {
        jiraMetadata = await this.fetchJiraCloudId(token.accessToken);
      }

      // For Google, resolve WHICH account was connected (the 'openid email' scopes are
      // always appended in initiateOAuth). The email feeds account dropdowns and
      // setup-field auto-population in the studio.
      let googleMetadata: GoogleOAuthMetadata | undefined;
      if (provider === 'google') {
        googleMetadata = await this.fetchGoogleUserInfo(token.accessToken);
      }

      // Determine which provider metadata to pass
      const providerMetadata = jiraMetadata ?? googleMetadata;

      // Incremental re-consent: UPDATE the existing credential row (token + accumulated
      // scopes) — no new credential row is created.
      if (stateData.credentialId !== undefined) {
        const credentialId = await this.applyIncrementalToken(
          stateData.credentialId,
          provider,
          token,
          stateData.scopes,
          providerMetadata
        );
        return { credentialId, token };
      }

      // Store token in database
      const credentialId = await this.storeOAuthToken(
        stateData.userId,
        provider,
        stateData.credentialType,
        token,
        stateData.scopes,
        stateData.credentialName || credentialName,
        providerMetadata
      );

      return { credentialId, token };
    } catch (error) {
      console.error('OAuth token exchange failed:', error);

      throw new Error(
        `OAuth token exchange failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get a valid access token, always refreshing to ensure freshest credentials
   */
  async getValidToken(credentialId: number): Promise<string | null> {
    const credential = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });

    if (!credential || !credential.isOauth || !credential.oauthAccessToken) {
      return null;
    }

    // Always refresh if we have a refresh token to ensure we use the freshest credentials
    if (credential.oauthRefreshToken) {
      try {
        console.info(
          `[oauthService] Refreshing OAuth token for credential ${credentialId}`
        );
        const newToken = await this.refreshToken(credentialId);
        return newToken;
      } catch (error) {
        console.error(
          'Token refresh failed, falling back to stored token:',
          error
        );
        // Fall through to return stored token if refresh fails
      }
    }

    // Return stored token if no refresh token or refresh failed
    try {
      return await CredentialEncryption.decrypt(credential.oauthAccessToken);
    } catch (error) {
      console.error('Failed to decrypt OAuth token:', error);
      return null;
    }
  }

  /**
   * Refresh an OAuth token using the refresh token
   */
  async refreshToken(credentialId: number): Promise<string> {
    const credential = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });

    if (
      !credential ||
      !credential.isOauth ||
      !credential.oauthRefreshToken ||
      !credential.oauthProvider ||
      !credential.oauthAccessToken ||
      !credential.oauthExpiresAt
    ) {
      throw new Error('OAuth credential not found or missing refresh token');
    }

    const client = this.clients.get(credential.oauthProvider);
    if (!client) {
      throw new Error(
        `OAuth provider '${credential.oauthProvider}' not supported`
      );
    }

    const decryptedRefreshToken = await CredentialEncryption.decrypt(
      credential.oauthRefreshToken
    );

    try {
      const newToken = await client.refreshToken({
        refreshToken: decryptedRefreshToken,
        accessToken: credential.oauthAccessToken,
        expiresAt: credential.oauthExpiresAt.getTime(),
      });

      // Update stored token
      await this.updateStoredToken(credentialId, newToken);

      return newToken.accessToken;
    } catch (error) {
      throw new Error(
        `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch Jira Cloud ID from accessible resources endpoint
   * This must be called after OAuth token exchange to get the Cloud ID needed for API calls
   */
  private async fetchJiraCloudId(
    accessToken: string
  ): Promise<JiraOAuthMetadata> {
    const response = await fetch(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch Jira accessible resources: ${response.status} - ${errorText}`
      );
    }

    const resources = (await response.json()) as Array<{
      id: string;
      url: string;
      name: string;
      scopes: string[];
      avatarUrl?: string;
    }>;

    if (!resources || resources.length === 0) {
      throw new Error(
        'No Jira sites accessible with this account. Please ensure you have access to at least one Jira Cloud site.'
      );
    }

    // Use the first accessible site (most common case)
    // TODO: If user has multiple sites, we could let them choose
    const site = resources[0];
    console.log(
      `[Jira OAuth] Found ${resources.length} accessible site(s). Using: ${site.name} (${site.url})`
    );

    return {
      cloudId: site.id,
      siteUrl: site.url,
      siteName: site.name,
    };
  }

  /**
   * Resolve the connected Google account's identity via the OIDC UserInfo endpoint.
   * Requires the 'openid email' scopes, which initiateOAuth always appends for google.
   *
   * Endpoint and response shape per Google's OpenID Connect reference (the userinfo
   * response carries `email` when the email scope was granted):
   * https://developers.google.com/identity/openid-connect/openid-connect
   *
   * Non-fatal by design: an identity lookup failure must not break the OAuth connect —
   * the credential still works; only auto-population degrades (returns undefined).
   */
  private async fetchGoogleUserInfo(
    accessToken: string
  ): Promise<GoogleOAuthMetadata | undefined> {
    try {
      const response = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        }
      );
      if (!response.ok) {
        console.warn(
          `[Google OAuth] UserInfo lookup failed: ${response.status} — credential stored without account identity`
        );
        return undefined;
      }
      const userInfo = (await response.json()) as {
        email?: string;
        name?: string;
      };
      if (!userInfo.email) {
        console.warn(
          '[Google OAuth] UserInfo response carried no email (email scope withheld?) — credential stored without account identity'
        );
        return undefined;
      }
      return {
        email: userInfo.email,
        displayName: userInfo.email,
      };
    } catch (error) {
      console.warn(
        '[Google OAuth] UserInfo lookup errored — credential stored without account identity:',
        error
      );
      return undefined;
    }
  }

  /**
   * Read the scopes ACTUALLY granted on a Google access token via the tokeninfo
   * introspection endpoint. The stored `oauthScopes` recorded at authorization are the
   * REQUESTED scopes (the token response library surfaces no scope field); the probe is
   * the honest source — Google returns `scope` as space-delimited case-sensitive strings.
   *
   * Endpoint per https://docs.cloud.google.com/docs/authentication/token-types:
   * GET https://oauth2.googleapis.com/tokeninfo?access_token=...
   *
   * Non-fatal by design: a probe failure (network, expired token) returns undefined and
   * callers fall back to the recorded scopes.
   */
  private async fetchGoogleGrantedScopes(
    accessToken: string
  ): Promise<string[] | undefined> {
    try {
      const response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!response.ok) {
        console.warn(
          `[Google OAuth] tokeninfo probe failed: ${response.status} — falling back to recorded scopes`
        );
        return undefined;
      }
      const info = (await response.json()) as { scope?: string };
      if (typeof info.scope !== 'string') {
        console.warn(
          '[Google OAuth] tokeninfo response carried no scope field — falling back to recorded scopes'
        );
        return undefined;
      }
      const scopes = info.scope
        .split(' ')
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0);
      return scopes.length > 0 ? scopes : undefined;
    } catch (error) {
      console.warn(
        '[Google OAuth] tokeninfo probe errored — falling back to recorded scopes:',
        error
      );
      return undefined;
    }
  }

  /**
   * Verify the scopes granted on an OAuth credential. Google credentials are probed live
   * (tokeninfo on a freshly refreshed access token) and the probed set is synced into
   * `user_credentials.oauth_scopes` so the build-time scope audit reads verified grants.
   * Other providers (no introspection wired) return the recorded scopes with
   * source 'stored'. Returns null when the credential is missing, not user-owned, or not
   * an OAuth credential — the scope check never guesses.
   */
  async checkGrantedScopes(
    userId: string,
    credentialId: number
  ): Promise<{ grantedScopes: string[]; source: 'probe' | 'stored' } | null> {
    const credential = await db.query.userCredentials.findFirst({
      where: and(
        eq(userCredentials.id, credentialId),
        eq(userCredentials.userId, userId)
      ),
    });
    if (!credential || !credential.isOauth) {
      return null;
    }

    if (credential.oauthProvider === 'google') {
      const accessToken = await this.getValidToken(credentialId);
      const probed = accessToken
        ? await this.fetchGoogleGrantedScopes(accessToken)
        : undefined;
      if (probed) {
        await db
          .update(userCredentials)
          .set({ oauthScopes: probed, updatedAt: new Date() })
          .where(eq(userCredentials.id, credentialId));
        return { grantedScopes: probed, source: 'probe' };
      }
    }

    return { grantedScopes: credential.oauthScopes ?? [], source: 'stored' };
  }

  /**
   * Incremental re-consent write path: update the existing credential row with the new
   * token and the accumulated scope set. Google tokens issued with
   * include_granted_scopes=true cover previously granted scopes, so the tokeninfo probe
   * yields the full accumulated grant; when the probe is unavailable the union of
   * recorded + newly requested scopes is stored instead.
   */
  private async applyIncrementalToken(
    credentialId: number,
    provider: string,
    token: OAuth2Token,
    requestedScopes: string[],
    providerMetadata?: JiraOAuthMetadata | GoogleOAuthMetadata
  ): Promise<number> {
    const credential = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });
    if (!credential) {
      throw new Error(
        `Incremental consent target credential ${credentialId} no longer exists`
      );
    }

    let scopes = [
      ...new Set([...(credential.oauthScopes ?? []), ...requestedScopes]),
    ];
    if (provider === 'google') {
      const granted = await this.fetchGoogleGrantedScopes(token.accessToken);
      if (granted) {
        scopes = granted;
      }
    }

    const encryptedAccessToken = await CredentialEncryption.encrypt(
      token.accessToken
    );
    const encryptedRefreshToken = token.refreshToken
      ? await CredentialEncryption.encrypt(token.refreshToken)
      : undefined;

    await db
      .update(userCredentials)
      .set({
        oauthAccessToken: encryptedAccessToken,
        oauthRefreshToken: encryptedRefreshToken,
        oauthExpiresAt: token.expiresAt ? new Date(token.expiresAt) : null,
        oauthScopes: scopes,
        metadata: credential.metadata ?? providerMetadata ?? null,
        updatedAt: new Date(),
      })
      .where(eq(userCredentials.id, credentialId));

    return credentialId;
  }

  /**
   * Store OAuth token in database
   */
  private async storeOAuthToken(
    userId: string,
    provider: string,
    credentialType: CredentialType,
    token: OAuth2Token,
    requestedScopes?: string[],
    credentialName?: string,
    providerMetadata?: JiraOAuthMetadata | GoogleOAuthMetadata
  ): Promise<number> {
    // Encrypt tokens
    const encryptedAccessToken = await CredentialEncryption.encrypt(
      token.accessToken
    );
    const encryptedRefreshToken = token.refreshToken
      ? await CredentialEncryption.encrypt(token.refreshToken)
      : null;

    // Use expiration from token (already a timestamp in milliseconds)
    const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;

    // Note: @badgateway/oauth2-client doesn't include scope in token response.
    // Google: probe tokeninfo for the scopes ACTUALLY granted (the user can deselect
    // scopes on the consent screen); fall back to the requested scopes when the probe
    // is unavailable. Other providers: requested scopes remain the best record.
    let scopes =
      requestedScopes ||
      this.getDefaultScopes(provider as OAuthProvider, credentialType);
    if (provider === 'google') {
      const granted = await this.fetchGoogleGrantedScopes(token.accessToken);
      if (granted) {
        scopes = granted;
      }
    }

    const [result] = await db
      .insert(userCredentials)
      .values({
        userId,
        credentialType,
        name:
          credentialName ||
          this.getCredentialConfig(provider as OAuthProvider, credentialType)
            .displayName,
        isOauth: true,
        oauthAccessToken: encryptedAccessToken,
        oauthRefreshToken: encryptedRefreshToken,
        oauthExpiresAt: expiresAt,
        oauthScopes: scopes,
        oauthTokenType: 'Bearer', // OAuth2 tokens are typically Bearer tokens
        oauthProvider: provider,
        metadata: providerMetadata ?? null, // Store provider-specific metadata (e.g., Jira cloudId)
      })
      .returning({ id: userCredentials.id });

    return result.id;
  }

  /**
   * Update stored OAuth token
   */
  private async updateStoredToken(
    credentialId: number,
    token: OAuth2Token
  ): Promise<void> {
    const encryptedAccessToken = await CredentialEncryption.encrypt(
      token.accessToken
    );
    const encryptedRefreshToken = token.refreshToken
      ? await CredentialEncryption.encrypt(token.refreshToken)
      : undefined;

    const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;

    await db
      .update(userCredentials)
      .set({
        oauthAccessToken: encryptedAccessToken,
        oauthRefreshToken: encryptedRefreshToken,
        oauthExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(userCredentials.id, credentialId));
  }

  /**
   * Get default scopes for a specific credential type under a provider
   */
  private getDefaultScopes(
    provider: OAuthProvider,
    credentialType: CredentialType
  ): string[] {
    const providerConfig = OAUTH_PROVIDERS[provider];
    const credentialConfig = providerConfig?.credentialTypes[credentialType];
    return credentialConfig?.defaultScopes || [];
  }

  /**
   * Get credential configuration for a specific credential type
   */
  private getCredentialConfig(
    provider: OAuthProvider,
    credentialType: CredentialType
  ) {
    const providerConfig = OAUTH_PROVIDERS[provider];
    const credentialConfig = providerConfig?.credentialTypes[credentialType];
    if (!credentialConfig) {
      throw new Error(
        `Credential type ${credentialType} not supported by provider ${provider}`
      );
    }
    return credentialConfig;
  }

  /**
   * Clean up expired state parameters
   */
  private cleanupExpiredStates(): void {
    const now = Date.now();
    const expiredStates: string[] = [];

    for (const [state, data] of this.stateStore.entries()) {
      if (now - data.timestamp > 10 * 60 * 1000) {
        // 10 minutes
        expiredStates.push(state);
      }
    }

    for (const state of expiredStates) {
      this.stateStore.delete(state);
    }

    if (expiredStates.length > 0) {
      console.info(
        `[oauthService] Cleaned up ${expiredStates.length} expired OAuth states`
      );
    }
  }

  /**
   * Revoke OAuth token and remove from database
   */
  async revokeCredential(credentialId: number): Promise<void> {
    const credential = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });

    if (!credential || !credential.isOauth) {
      throw new Error('OAuth credential not found');
    }

    // Try to revoke token with provider (best effort)
    if (credential.oauthAccessToken && credential.oauthProvider) {
      try {
        const client = this.clients.get(credential.oauthProvider);
        if (client) {
          // const accessToken = await CredentialEncryption.decrypt(
          //   credential.oauthAccessToken
          // );
          // Note: Not all providers support token revocation via @badgateway/oauth2-client
          // This would need to be implemented per-provider if needed
          console.debug(
            `[oauthService] Would revoke token for ${credential.oauthProvider} (not implemented)`
          );
        }
      } catch (error) {
        console.error(
          'Token revocation failed (continuing with deletion):',
          error
        );
      }
    }

    // Delete credential from database
    await db
      .delete(userCredentials)
      .where(eq(userCredentials.id, credentialId));
  }
}

// Export singleton instance
export const oauthService = new OAuthService();
