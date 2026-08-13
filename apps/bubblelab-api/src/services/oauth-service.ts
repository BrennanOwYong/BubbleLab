import { OAuth2Client, OAuth2Token } from '@badgateway/oauth2-client';
import {
  CredentialType,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type JiraOAuthMetadata,
  type GoogleOAuthMetadata,
} from '@bubblelab/shared-schemas';
import { emitServerTelemetry } from '../utils/telemetry.js';
import { recordServerTelemetryEvent } from '../routes/telemetry.js';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { CredentialEncryption } from '../utils/encryption.js';
import {
  sealOAuthState,
  openOAuthState,
  oauthStateHash,
  oauthStateTtlMs,
  OAUTH_STATE_INVALID_ERROR,
  OAUTH_STATE_EXPIRED_ERROR,
  type OAuthStatePayload,
} from '../utils/oauth-state.js';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { syncDerivedCredentialsById } from './derived-credential-service.js';
import { notifyBuilderCredentialsChanged } from './builder-notify.js';

/**
 * The OAuth account email recorded on a credential's metadata (GoogleOAuthMetadata et al),
 * when present — used as login_hint so incremental re-consent lands on the SAME account,
 * and as the "already identified" check for the lazy email backfill.
 */
export function extractMetadataEmail(metadata: unknown): string | undefined {
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

/** S9: outcome of a provider-side revoke call, distinct from the local row delete. */
export type ProviderRevocationStatus =
  | 'revoked'
  | 'already_invalid'
  | 'unsupported'
  | 'error';

export interface ProviderRevocationResult {
  provider: string;
  status: ProviderRevocationStatus;
  detail?: string;
}

/** S9c: where a no-revoke provider's own connected-apps page lives. */
export interface ProviderManageAppsInfo {
  url: string;
  instructions: string;
}

export interface RevokeCredentialResult {
  revocation: ProviderRevocationResult;
  manageApps?: ProviderManageAppsInfo;
}

/**
 * S9c: providers with NO programmatic revoke endpoint — deleting the local row
 * can't touch the provider-side grant, so the delete response must tell the
 * user where to remove it themselves. Only providers actually wired into
 * `clients` (setupOAuthClients) ever reach revokeCredential, so this only
 * needs an entry for those; any other provider falls through to the generic
 * 'unsupported' status in revokeProviderToken's default case with no link.
 */
const PROVIDER_MANAGE_APPS: Partial<Record<string, ProviderManageAppsInfo>> = {
  jira: {
    url: 'https://id.atlassian.com/manage-profile/apps',
    instructions:
      "Atlassian does not offer a programmatic way to revoke this grant. Remove BubbleLab from your Atlassian account's connected apps to fully disconnect it.",
  },
};

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
 *
 * ## References (token revocation, verified 2026-07-21; re-verified 2026-08-01 for S9)
 * - Google: POST https://oauth2.googleapis.com/revoke with
 *   `Content-Type: application/x-www-form-urlencoded`, body `token=<access-or-refresh>`;
 *   200 on success, 400 when the token is already invalid/expired:
 *   https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke
 * - Google `prompt` param accepts a space-delimited list; `consent` and
 *   `select_account` combine to force both a fresh consent screen and an
 *   account chooser on a brand-new add (S9b):
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 * - Notion: POST https://api.notion.com/v1/oauth/revoke, Basic auth
 *   (client_id:client_secret), JSON `{token}`, `Notion-Version` header:
 *   https://developers.notion.com/reference/revoke-token
 * - Follow Up Boss DOES document a revoke endpoint (found during S9 research —
 *   contradicts the earlier assumption that it had none, alongside Atlassian):
 *   DELETE https://api.followupboss.com/v1/oauthApps/revokeAccess,
 *   `Authorization: Bearer <access_token>` + `X-System`/`X-System-Key`
 *   (same partner headers every other FUB call sends), no body; 200
 *   `{success:true}`, or `{errorMessage:"OAuth application not found or not
 *   connected."}` when the token/grant is already gone:
 *   https://docs.followupboss.com/docs/oauth-authentication-and-authorization
 * - Atlassian OAuth 2.0 (3LO) documents NO programmatic revocation endpoint;
 *   the user revokes via their Atlassian account's connected-apps page
 *   (https://id.atlassian.com/manage-profile/apps — confirmed current 2026-08-01
 *   via Atlassian Support's "Update your profile and visibility settings" docs):
 *   https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
 */
export class OAuthService {
  private clients: Map<string, OAuth2Client> = new Map();

  constructor() {
    this.setupOAuthClients();
  }

  /**
   * S7/S9 observability (Pillar 2): every state issue/validate/reject/revoke
   * lands in BOTH the console telemetry line and the queryable /telemetry
   * ring buffer, so cross-process state (and revoke) validation is assertable
   * per process via curl.
   */
  private emitOAuthStateEvent(
    event:
      | 'oauth.state_issued'
      | 'oauth.state_validated'
      | 'oauth.state_rejected'
      | 'oauth.revoke_attempted',
    data: Record<string, unknown>
  ): void {
    emitServerTelemetry(event, data);
    recordServerTelemetryEvent({ event, ...data });
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

    // Incremental re-consent: the authorization ADDS scopes to an existing grant and the
    // callback updates that credential row in place. Google's include_granted_scopes=true
    // makes the returned token cover previously granted scopes too, so requesting only the
    // missing scopes yields a token for the accumulated set. See ## References above.
    //
    // S9(b): existingCredentialId is undefined ONLY for a genuinely new add (the studio
    // never sends it unless the user is re-authorizing a specific row already on file), so
    // extraAuthParams below stays empty on a new add — no login_hint/include_granted_scopes
    // ever leak in from a prior connection. On top of that, force a fresh account/consent
    // choice: without select_account, Google silently reuses the last-selected account in an
    // active browser session and shows the consent screen with the SAME previously-granted
    // scopes pre-checked, which reads as "reconnecting" rather than a clean new connection
    // even though the user explicitly deleted first. `prompt` accepts a space-delimited list
    // (consent + select_account combine); confirmed against the Web Server Applications guide
    // referenced above (verified 2026-08-01).
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
    } else if (provider === 'google') {
      extraAuthParams.prompt = 'consent select_account';
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

    // S7 stateless CSRF state: the sealed payload IS the store. Any process
    // holding CREDENTIAL_ENCRYPTION_KEY validates it at the callback; nothing
    // is kept in this process's memory. TTL is enforced at the callback from
    // the sealed iat (default 10 minutes, matching the old Map behavior).
    const state = await sealOAuthState({
      v: 1,
      userId,
      provider,
      credentialType: effectiveCredentialType,
      credentialName,
      scopes: requestedScopes,
      credentialId: existingCredentialId,
      redirectUri,
      iat: Date.now(),
    });
    this.emitOAuthStateEvent('oauth.state_issued', {
      provider,
      credentialType: effectiveCredentialType,
      stateHash: oauthStateHash(state),
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
    // S7 stateless validation: decrypt-or-die (the GCM auth tag is the CSRF
    // guarantee), then provider match and TTL from the sealed iat. Works on
    // ANY process holding CREDENTIAL_ENCRYPTION_KEY — no shared memory.
    const stateHash = oauthStateHash(state);
    let stateData: OAuthStatePayload;
    try {
      stateData = await openOAuthState(state);
    } catch {
      this.emitOAuthStateEvent('oauth.state_rejected', {
        provider,
        reason: 'decrypt_failed',
        stateHash,
      });
      throw new Error(OAUTH_STATE_INVALID_ERROR);
    }

    if (stateData.provider !== provider) {
      this.emitOAuthStateEvent('oauth.state_rejected', {
        provider,
        reason: 'provider_mismatch',
        stateHash,
      });
      throw new Error(OAUTH_STATE_INVALID_ERROR);
    }

    const stateAgeMs = Date.now() - stateData.iat;
    const stateTtlMs = oauthStateTtlMs();
    if (stateAgeMs > stateTtlMs) {
      this.emitOAuthStateEvent('oauth.state_rejected', {
        provider,
        reason: 'expired',
        stateHash,
        stateAgeMs,
        stateTtlMs,
      });
      throw new Error(OAUTH_STATE_EXPIRED_ERROR);
    }

    this.emitOAuthStateEvent('oauth.state_validated', {
      provider,
      credentialType: stateData.credentialType,
      stateHash,
      stateAgeMs,
      stateTtlMs,
    });

    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`OAuth provider '${provider}' not supported`);
    }

    // Authorize-time redirect URI from the sealed payload — the token exchange
    // must present the EXACT redirect_uri the provider saw, even if this
    // process's env differs from the issuing process's (S7 drift fix).
    const redirectUri = stateData.redirectUri;

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
    accessToken: string,
    signal?: AbortSignal
  ): Promise<GoogleOAuthMetadata | undefined> {
    try {
      const response = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
          signal,
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
        // Scope-sync: the stored derived-credential records must follow the
        // freshly probed grant (a revoked scope drops its record here).
        await syncDerivedCredentialsById(credentialId);
        return { grantedScopes: probed, source: 'probe' };
      }
    }

    return { grantedScopes: credential.oauthScopes ?? [], source: 'stored' };
  }

  /**
   * Credentials whose identity backfill was attempted this process. A persisted email is
   * the durable cache (the guard below skips identified rows); this set only prevents
   * re-probing a FAILING credential on every list call. A restart retries.
   */
  private googleEmailBackfillAttempts = new Set<number>();

  /**
   * Lazy identity backfill for Google OAuth credentials connected BEFORE the callback
   * started recording the account email (their metadata carries no email, so account
   * dropdowns and setup-field auto-population have nothing to show). Probes the OIDC
   * UserInfo endpoint once with the credential's access token and persists the email.
   *
   * Endpoint per Google's OpenID Connect reference (bearer GET; response carries `email`
   * when the email scope was granted; the discovery document at
   * https://accounts.google.com/.well-known/openid-configuration lists it as
   * userinfo_endpoint): https://developers.google.com/identity/openid-connect/openid-connect
   * Re-verified against that page on 2026-07-21.
   *
   * Non-fatal by design: any failure (network, token without the email scope, expired
   * grant) returns null and the caller serves the row as stored — the backfill never
   * blocks a credentials listing. The probe carries a 5s abort signal so a dead route
   * cannot hang the request.
   */
  async backfillGoogleAccountEmail(
    userId: string,
    credentialId: number
  ): Promise<GoogleOAuthMetadata | null> {
    const credential = await db.query.userCredentials.findFirst({
      where: and(
        eq(userCredentials.id, credentialId),
        eq(userCredentials.userId, userId)
      ),
    });
    if (
      !credential ||
      !credential.isOauth ||
      credential.oauthProvider !== 'google'
    ) {
      return null;
    }
    if (extractMetadataEmail(credential.metadata)) {
      return null; // Already identified — nothing to backfill.
    }
    if (this.googleEmailBackfillAttempts.has(credentialId)) {
      return null;
    }
    this.googleEmailBackfillAttempts.add(credentialId);

    const accessToken = await this.getValidToken(credentialId);
    if (!accessToken) {
      return null;
    }
    const userInfo = await this.fetchGoogleUserInfo(
      accessToken,
      AbortSignal.timeout(5000)
    );
    if (!userInfo) {
      return null;
    }

    const existing = credential.metadata;
    const metadata =
      existing !== null &&
      existing !== undefined &&
      typeof existing === 'object'
        ? { ...existing, ...userInfo }
        : userInfo;
    await db
      .update(userCredentials)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(userCredentials.id, credentialId));
    emitServerTelemetry('setup.account_email_backfilled', {
      credentialId,
      credentialType: credential.credentialType,
      provider: 'google',
    });
    return userInfo;
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

    // Re-consent changed the accumulated grant — keep the stored
    // derived-credential records in lockstep with it.
    await syncDerivedCredentialsById(credentialId);

    // FE1: a scope-widening re-consent can close a gap on an EXISTING row
    // (e.g. adding the sheets scope to a Google credential) — notify the
    // builder sidecar just like a fresh connect.
    notifyBuilderCredentialsChanged(
      credential.userId,
      credential.credentialType
    );

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

    // Connect: materialize which sibling types this grant covers as stored
    // derived-credential records.
    await syncDerivedCredentialsById(result.id);

    // FE1: a fresh OAuth connect may close a blocked build's credential gap —
    // fire-and-forget notify to the builder sidecar.
    notifyBuilderCredentialsChanged(userId, credentialType);

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
   * Revoke the token at the provider (best effort), then remove the credential
   * from the database. Provider unreachable / token already invalid never blocks
   * the delete — the row goes regardless; the revocation outcome is logged AND
   * returned to the caller (S9) so the delete response can tell the user what
   * actually happened at the provider instead of a blanket "deleted".
   */
  async revokeCredential(
    credentialId: number
  ): Promise<RevokeCredentialResult> {
    const credential = await db.query.userCredentials.findFirst({
      where: eq(userCredentials.id, credentialId),
    });

    if (!credential || !credential.isOauth) {
      throw new Error('OAuth credential not found');
    }

    const provider = credential.oauthProvider ?? 'unknown';
    let revocation: ProviderRevocationResult;
    try {
      const accessToken = credential.oauthAccessToken
        ? await CredentialEncryption.decrypt(credential.oauthAccessToken)
        : undefined;
      const refreshToken = credential.oauthRefreshToken
        ? await CredentialEncryption.decrypt(credential.oauthRefreshToken)
        : undefined;
      revocation = await this.revokeProviderToken(provider, {
        accessToken,
        refreshToken,
      });
    } catch (error) {
      // Decrypt failure or an unexpected throw from the provider call — S9(a):
      // never let this block the delete, but never swallow it silently either.
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[oauthService] Token revocation for provider '${provider}' failed (continuing with deletion): ${detail}`
      );
      revocation = { provider, status: 'error', detail };
    }

    this.emitOAuthStateEvent('oauth.revoke_attempted', {
      credentialId,
      provider,
      status: revocation.status,
      detail: revocation.detail,
    });

    // Delete credential from database (derived_credentials rows cascade)
    await db
      .delete(userCredentials)
      .where(eq(userCredentials.id, credentialId));

    const manageApps = PROVIDER_MANAGE_APPS[provider];
    return manageApps ? { revocation, manageApps } : { revocation };
  }

  /**
   * Call the provider's documented revocation endpoint (see the "token
   * revocation" References above). Best effort: the credential row is always
   * deleted by the caller regardless of the result here. Distinguishes WHY a
   * revoke didn't leave the grant revoked (S9a/c) instead of one blanket
   * catch-and-log:
   *  - 'revoked'          the provider confirmed the grant is gone
   *  - 'already_invalid'  the provider says the token was already dead (e.g.
   *                       an expired test-mode grant) — the call still ran,
   *                       it just had nothing left to revoke
   *  - 'unsupported'      the provider documents no programmatic revoke
   *                       endpoint (S9c) — PROVIDER_MANAGE_APPS below carries
   *                       the "remove it yourself" link for these
   *  - 'error'            the call itself failed (missing config, network,
   *                       unexpected status) — logged with detail, not hidden
   */
  private async revokeProviderToken(
    provider: string,
    tokens: { accessToken?: string; refreshToken?: string }
  ): Promise<ProviderRevocationResult> {
    const timeout = AbortSignal.timeout(OAuthService.REVOCATION_TIMEOUT_MS);

    switch (provider) {
      case 'google': {
        // Prefer the refresh token: revoking it invalidates the whole grant
        // (Google revokes the paired access token with it); fall back to the
        // access token when no refresh token was stored.
        const token = tokens.refreshToken ?? tokens.accessToken;
        if (!token) {
          return {
            provider,
            status: 'error',
            detail: 'no stored token to revoke',
          };
        }
        const response = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: timeout,
        });
        if (response.ok) {
          console.info('[oauthService] Revoked google OAuth token');
          return { provider, status: 'revoked' };
        }
        // Google returns 400 for a token that's already invalid/expired (S9a:
        // this is the expected outcome for an expired test-mode grant) — log
        // it plainly rather than assuming the earlier fetch always succeeds.
        const detail = await response.text().catch(() => '');
        console.warn(
          `[oauthService] Google token revocation returned ${response.status} (token likely already invalid): ${detail}`
        );
        return {
          provider,
          status: 'already_invalid',
          detail: `HTTP ${response.status}: ${detail}`,
        };
      }
      case 'notion': {
        if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) {
          console.warn(
            '[oauthService] Notion OAuth client not configured; skipping provider-side revocation'
          );
          return {
            provider,
            status: 'error',
            detail: 'Notion OAuth client not configured',
          };
        }
        const token = tokens.refreshToken ?? tokens.accessToken;
        if (!token) {
          return {
            provider,
            status: 'error',
            detail: 'no stored token to revoke',
          };
        }
        const basicAuth = Buffer.from(
          `${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`
        ).toString('base64');
        const response = await fetch('https://api.notion.com/v1/oauth/revoke', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2025-09-03',
          },
          body: JSON.stringify({ token }),
          signal: timeout,
        });
        if (response.ok) {
          console.info('[oauthService] Revoked notion OAuth token');
          return { provider, status: 'revoked' };
        }
        const detail = await response.text().catch(() => '');
        console.warn(
          `[oauthService] Notion token revocation returned ${response.status}: ${detail}`
        );
        return {
          provider,
          status: 'already_invalid',
          detail: `HTTP ${response.status}: ${detail}`,
        };
      }
      case 'followupboss': {
        // FUB DOES document a revoke endpoint (verified 2026-08-01, see
        // References above) — the access token (not refresh) goes in the
        // Authorization header; X-System/X-System-Key are the same
        // partner-identification headers every other FUB call already sends
        // (packages/bubble-core/src/bubbles/service-bubble/followupboss.ts).
        if (!env.FUB_SYSTEM_NAME || !env.FUB_SYSTEM_KEY) {
          console.warn(
            '[oauthService] FollowUpBoss system credentials not configured; skipping provider-side revocation'
          );
          return {
            provider,
            status: 'error',
            detail: 'FUB_SYSTEM_NAME/FUB_SYSTEM_KEY not configured',
          };
        }
        if (!tokens.accessToken) {
          return {
            provider,
            status: 'error',
            detail: 'no stored access token to revoke',
          };
        }
        const response = await fetch(
          'https://api.followupboss.com/v1/oauthApps/revokeAccess',
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              'X-System': env.FUB_SYSTEM_NAME,
              'X-System-Key': env.FUB_SYSTEM_KEY,
            },
            signal: timeout,
          }
        );
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean;
          errorMessage?: string;
        };
        if (response.ok && body?.success !== false) {
          console.info('[oauthService] Revoked followupboss OAuth access');
          return { provider, status: 'revoked' };
        }
        const detail = JSON.stringify(body).slice(0, 300);
        // FUB documents this exact error shape for a token that's already
        // disconnected — treat it the same as an already-invalid grant.
        const alreadyGone = /not found or not connected/i.test(
          String(body?.errorMessage ?? '')
        );
        console.warn(
          `[oauthService] FollowUpBoss token revocation returned ${response.status}: ${detail}`
        );
        return {
          provider,
          status: alreadyGone ? 'already_invalid' : 'error',
          detail: `HTTP ${response.status}: ${detail}`,
        };
      }
      case 'jira': {
        // Atlassian OAuth 2.0 (3LO) documents no programmatic revocation
        // endpoint (S9c, verified 2026-08-01) — the user must remove the app
        // from their own account's connected-apps page (PROVIDER_MANAGE_APPS).
        console.warn(
          "[oauthService] Provider 'jira' documents no token-revocation endpoint; deleting stored tokens only"
        );
        return { provider, status: 'unsupported' };
      }
      default:
        console.warn(
          `[oauthService] Provider '${provider}' documents no token-revocation endpoint; deleting stored tokens only`
        );
        return { provider, status: 'unsupported' };
    }
  }

  /** Dead outbound routes on this box can hang for 30s+; cap the revoke call. */
  private static readonly REVOCATION_TIMEOUT_MS = 10_000;
}

// Export singleton instance
export const oauthService = new OAuthService();
