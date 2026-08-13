/**
 * Stateless OAuth CSRF state (S7, PLAN-DOCS/discovery/S7.md).
 *
 * The state parameter sent to the provider IS the authorize-time context,
 * sealed with AES-256-GCM via CredentialEncryption and base64url-encoded.
 * Any API process holding CREDENTIAL_ENCRYPTION_KEY validates a callback
 * statelessly: decrypt (the GCM auth tag is the CSRF guarantee — a state not
 * sealed by a key holder fails decryption), zod-parse, then check provider
 * match and TTL from the authenticated `iat`. Replaces the per-process
 * in-memory `stateStore` Map that broke authorize-on-A / callback-on-B
 * (restart, replica, supervisor respawn).
 *
 * The sealed payload carries the authorize-time `redirectUri`, so the token
 * exchange reuses the exact value the provider saw (exact-match requirement)
 * even when env drifts between the issuing and validating process.
 *
 * Single-use is intentionally NOT enforced (the Map deleted state on first
 * use): replay of the state alone is harmless because the authorization code
 * is single-use at the provider; the CSRF guarantee rides the GCM tag + TTL.
 * If a provider ever rejects long state values (~700-1100 chars with several
 * scope URLs), the documented fallback is a shared `oauth_states` DB table —
 * RFC 6749 sets no state length limit (`state = 1*VSCHAR`) and neither Google
 * nor FollowUpBoss document one.
 *
 * ## Sources (verified 2026-08-01)
 * - RFC 6749 §4.1.1 (`state` syntax `1*VSCHAR`, no length limit) and §10.12
 *   (CSRF binding): https://datatracker.ietf.org/doc/html/rfc6749#section-4.1.1
 *   https://datatracker.ietf.org/doc/html/rfc6749#section-10.12
 * - Google web-server flow (state round-trip; redirect_uri exact match at the
 *   token exchange): https://developers.google.com/identity/protocols/oauth2/web-server
 * - FollowUpBoss OAuth ("follows the OAuth 2.0 Authorization Code Grant Flow",
 *   no state restrictions documented):
 *   https://docs.followupboss.com/docs/getting-started-with-oauth
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import { CredentialType } from '@bubblelab/shared-schemas';
import { CredentialEncryption } from './encryption.js';
import { env } from '../config/env.js';

/** Verbatim error strings the studio + BACKLOG accept clause key on. */
export const OAUTH_STATE_INVALID_ERROR = 'Invalid or expired state parameter';
export const OAUTH_STATE_EXPIRED_ERROR = 'State parameter expired';

/** Default TTL matches the old Map behavior (10 minutes). */
export const DEFAULT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** TTL from the authenticated `iat`; `OAUTH_STATE_TTL_MS` env overrides (tests). */
export function oauthStateTtlMs(): number {
  const raw = env.OAUTH_STATE_TTL_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_OAUTH_STATE_TTL_MS;
}

export const oauthStatePayloadSchema = z.object({
  /** Payload format version — bump on shape changes so old states die cleanly. */
  v: z.literal(1),
  userId: z.string(),
  provider: z.string(),
  credentialType: z.nativeEnum(CredentialType),
  credentialName: z.string().optional(),
  scopes: z.array(z.string()),
  /** Incremental re-consent: existing credential row the callback must UPDATE. */
  credentialId: z.number().optional(),
  /** Authorize-time redirect URI, reused verbatim at the token exchange. */
  redirectUri: z.string(),
  /** Issue time (Date.now()); TTL is enforced against this at the callback. */
  iat: z.number(),
});

export type OAuthStatePayload = z.infer<typeof oauthStatePayloadSchema>;

/** base64 → base64url so the value is inert in query strings and form bodies. */
function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(base64url: string): string {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4;
  return padding === 0 ? base64 : base64 + '='.repeat(4 - padding);
}

/** Seal the authorize-time context into the opaque state string. */
export async function sealOAuthState(
  payload: OAuthStatePayload
): Promise<string> {
  const validated = oauthStatePayloadSchema.parse(payload);
  const sealed = await CredentialEncryption.encrypt(JSON.stringify(validated));
  return toBase64Url(sealed);
}

/**
 * Open a sealed state. Throws OAUTH_STATE_INVALID_ERROR on ANY failure
 * (bad encoding, decrypt/auth-tag failure, malformed JSON, schema mismatch) —
 * callers never learn WHY a forged state failed. Provider match and TTL are
 * the caller's checks (they need the payload).
 */
export async function openOAuthState(
  state: string
): Promise<OAuthStatePayload> {
  let json: string;
  try {
    json = await CredentialEncryption.decrypt(fromBase64Url(state));
  } catch {
    throw new Error(OAUTH_STATE_INVALID_ERROR);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(OAUTH_STATE_INVALID_ERROR);
  }
  const parsed = oauthStatePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(OAUTH_STATE_INVALID_ERROR);
  }
  return parsed.data;
}

/**
 * Correlation id for telemetry: first 12 hex chars of sha256(state). Lets the
 * issue event on one process be matched to the validate/reject event on
 * another without ever logging the sealed value.
 */
export function oauthStateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex').slice(0, 12);
}
