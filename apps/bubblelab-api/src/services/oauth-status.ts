/**
 * OAuth access-token health from the stored expiry (S6). Single source of
 * truth for the 'active' | 'expired' | 'needs_refresh' classification that
 * GET /credentials has always computed inline; the S6 credential-state
 * endpoint (GET /bubble-flow/:id/credential-state) reports the same value so
 * the fixer's triage and the studio can never disagree on a credential's
 * health.
 *
 * NOTE: 'expired' means the ACCESS token lapsed. A live refresh token
 * recovers it silently at next use, so 'expired' alone never proves a dead
 * grant — only combined with a runtime auth failure does it imply one
 * (S6 brief, risk 2). Callers encode that combination; this helper only
 * states the expiry math.
 */

export type OauthStatus = 'active' | 'expired' | 'needs_refresh';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export function computeOauthStatus(
  isOauth: boolean | null | undefined,
  oauthExpiresAt: Date | null | undefined,
  now: Date = new Date()
): OauthStatus | undefined {
  if (!isOauth || !oauthExpiresAt) return undefined;
  const expiresAt = new Date(oauthExpiresAt);
  if (expiresAt < now) return 'expired';
  if (expiresAt < new Date(now.getTime() + REFRESH_WINDOW_MS)) {
    return 'needs_refresh';
  }
  return 'active';
}
