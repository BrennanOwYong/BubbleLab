/**
 * FE1 credential-gap auto-run: notify the builder-agent sidecar that a
 * credential was written (created, OAuth-connected, or scope-widened by
 * re-consent) so it can scan blocked_on_credential build threads and run
 * their persisted deferred setup headless — no user chat message required.
 *
 * Receiving end: POST /internal/credentials-changed in
 * services/builder-agent/src/index.ts (responds 202 and kicks in background).
 *
 * Fire-and-forget by contract: the caller's response path never awaits this,
 * and the .catch() is attached at promise creation — an unhandled fetch
 * rejection crashes the Bun process (the api.ipify.org lesson, see
 * src/index.ts history). A lost notify is safe: the turn-start resolution in
 * the sidecar's builder.ts still closes the gap on the next user message.
 *
 * Pillar 2: emits `credentials.builder_notify` (attempt) and
 * `credentials.builder_notify_result` (delivery outcome) into both the
 * console telemetry line and the queryable /telemetry ring buffer.
 */
import { emitServerTelemetry } from '../utils/telemetry.js';
import { recordServerTelemetryEvent } from '../routes/telemetry.js';
import { getBuilderTarget } from './builder-runtime.js';

function record(event: string, data: Record<string, unknown>): void {
  emitServerTelemetry(event, data);
  recordServerTelemetryEvent({ event, ...data });
}

/** Notify the sidecar that a credential write may have closed a gap. */
export function notifyBuilderCredentialsChanged(
  userId: string,
  credentialType: string
): void {
  record('credentials.builder_notify', { credentialType });
  // FE5: the builder runtime manager owns the target; with the builder off
  // there is nothing to notify — the turn-start resolver covers the gap when
  // the builder comes back.
  const target = getBuilderTarget();
  if (target === null) {
    record('credentials.builder_notify_result', {
      credentialType,
      ok: false,
      skipped: 'builder_off',
    });
    return;
  }
  void fetch(`${target}/internal/credentials-changed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, credentialType }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (res) => {
      const body: unknown = await res.json().catch(() => null);
      const kicked =
        typeof body === 'object' && body !== null && 'kicked' in body
          ? body.kicked
          : null;
      record('credentials.builder_notify_result', {
        credentialType,
        ok: res.ok,
        status: res.status,
        kicked,
      });
    })
    .catch((error: unknown) => {
      // Sidecar down or unreachable: log and move on — the turn-start
      // resolver is the durable fallback.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[builder-notify] sidecar notify failed: ${message}`);
      record('credentials.builder_notify_result', {
        credentialType,
        ok: false,
        error: message,
      });
    });
}
