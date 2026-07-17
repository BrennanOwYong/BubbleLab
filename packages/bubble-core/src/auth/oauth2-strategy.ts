/**
 * `oauth2` AuthMethod strategy: authorization-code grant with a Connect UI
 * scope picker, bearer injection, refresh-on-expiry and rotation-aware
 * refresh-token persistence.
 *
 * Request/response shapes are grounded on the official specs — re-verify
 * against these before changing:
 * - RFC 6749 §4.1.1 (authorization request), §4.1.3 (token request: POST,
 *   application/x-www-form-urlencoded), §5.1 (token response), §6 (refresh;
 *   the server MAY rotate in a new refresh_token):
 *   https://datatracker.ietf.org/doc/html/rfc6749
 * - RFC 6750 §2.1 (`Authorization: Bearer <token>`):
 *   https://datatracker.ietf.org/doc/html/rfc6750#section-2.1
 * - Google OAuth 2.0 for web server apps (refresh responses normally OMIT
 *   refresh_token — the original stays valid):
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * BubbleLab's product OAuth path (authorize URL construction, code exchange,
 * server-side refresh) lives in apps/bubblelab-api/src/services/oauth-service.ts;
 * this strategy is the per-kind seam the Connect UI spec and credential tests
 * dispatch through, with an injectable transport for deterministic tests.
 */
import { z } from 'zod';
import type {
  AuthCollectScope,
  AuthCollectSpec,
  AuthProbeRequest,
} from '@bubblelab/shared-schemas';
import {
  emptyAuthRequest,
  fetchAuthTransport,
  probeAuth,
  type AuthHttpTransport,
  type AuthMethodStrategy,
  type OutboundAuthRequest,
  type ResolvedAuthCredential,
} from './auth-method-strategy.js';

/** RFC 6749 §5.1 successful token response. */
const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

const REFRESH_TOKEN_KEY = 'refreshToken';

/** Typed read of the refresh token out of a resolved credential's metadata. */
export function refreshTokenOf(
  cred: ResolvedAuthCredential
): string | undefined {
  const value = cred.metadata?.[REFRESH_TOKEN_KEY];
  return typeof value === 'string' ? value : undefined;
}

export interface OAuth2StrategyConfig {
  /** Scope options rendered by the Connect UI scope picker. */
  scopes: AuthCollectScope[];
  testRequest: AuthProbeRequest;
  /** Needed only when this strategy performs the refresh itself. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  transport?: AuthHttpTransport;
}

export class OAuth2AuthMethod implements AuthMethodStrategy {
  readonly kind = 'oauth2' as const;
  readonly #config: OAuth2StrategyConfig;
  readonly #transport: AuthHttpTransport;

  constructor(config: OAuth2StrategyConfig) {
    this.#config = config;
    this.#transport = config.transport ?? fetchAuthTransport;
  }

  /** Connect UI: OAuth scope picker + Connect popup. */
  collect(): AuthCollectSpec {
    return { kind: this.kind, scopes: [...this.#config.scopes] };
  }

  /** RFC 6750 §2.1: `Authorization: Bearer <token>`. */
  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void {
    req.headers['Authorization'] = `Bearer ${cred.secret}`;
  }

  async test(
    cred: ResolvedAuthCredential
  ): Promise<{ ok: boolean; error?: string }> {
    const req = emptyAuthRequest(
      this.#config.testRequest.url,
      this.#config.testRequest.method ?? 'GET'
    );
    this.applyToRequest(cred, req);
    return probeAuth(req, this.#transport);
  }

  /**
   * RFC 6749 §6: refresh the access token. Call only inside the expiry
   * buffer — never unconditionally (IR-5).
   */
  async refresh(cred: ResolvedAuthCredential): Promise<ResolvedAuthCredential> {
    const { tokenUrl, clientId, clientSecret } = this.#config;
    if (!tokenUrl || !clientId || !clientSecret) {
      throw new Error(
        'oauth2 strategy has no token endpoint configured; refresh is owned by the API oauth-service for this app'
      );
    }
    const refreshToken = refreshTokenOf(cred);
    if (refreshToken === undefined) {
      throw new Error(
        'oauth2 credential has no refresh token; the user must re-connect the app'
      );
    }
    // RFC 6749 §6: POST, application/x-www-form-urlencoded entity body.
    const req: OutboundAuthRequest = {
      url: tokenUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      query: {},
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    };
    const response = await this.#transport(req);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `oauth2 token endpoint returned HTTP ${response.status}: ${response.body}`
      );
    }
    const parsed = tokenResponseSchema.parse(JSON.parse(response.body));

    const next: ResolvedAuthCredential = {
      secret: parsed.access_token,
      grantedScopes:
        parsed.scope !== undefined
          ? parsed.scope.split(' ')
          : [...(cred.grantedScopes ?? [])],
    };
    if (parsed.expires_in !== undefined) {
      next.expiresAt = new Date(Date.now() + parsed.expires_in * 1000);
    }
    // Rotation (RFC 6749 §6): the server MAY issue a new refresh_token.
    // Google's refresh responses omit it — the prior token stays valid.
    const rotated = parsed.refresh_token ?? refreshToken;
    next.metadata = { ...(cred.metadata ?? {}), [REFRESH_TOKEN_KEY]: rotated };
    return next;
  }

  /**
   * Granted scopes come from the token response `scope` we stored at
   * connect/refresh time. Empty ⇒ no provider scope metadata ⇒ the scope
   * audit falls back to honest first-run discovery.
   */
  grantedScopes(cred: ResolvedAuthCredential): Promise<string[] | undefined> {
    return Promise.resolve(
      cred.grantedScopes !== undefined && cred.grantedScopes.length > 0
        ? [...cred.grantedScopes]
        : undefined
    );
  }
}
