/**
 * Structured server-side telemetry (project principle: programmatic telemetry
 * for testability). Mirrors the studio's `[bl:telemetry]` console format so an
 * automated agent reading server logs asserts on behavior deterministically.
 *
 * Event names emitted by the API:
 * - `setup.account_email_backfilled` — an existing Google OAuth credential that
 *   predated the callback's identity write (metadata.email = null) had its
 *   account email probed via the OIDC UserInfo endpoint and persisted.
 */
export const TELEMETRY_PREFIX = '[bl:telemetry]';

/** Emit one structured telemetry event to the server console. */
export function emitServerTelemetry(
  event: string,
  data: Record<string, unknown> = {}
): void {
  console.info(TELEMETRY_PREFIX, JSON.stringify({ event, ...data }));
}
