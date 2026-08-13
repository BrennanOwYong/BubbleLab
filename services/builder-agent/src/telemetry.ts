/**
 * Fire-and-forget event into the API's /telemetry ring buffer so sidecar
 * activity is assertable (DISPATCH-CONTRACT Pillar 2) without an SSE consumer.
 * .catch() attached at creation — an unhandled fetch rejection must never
 * take the process down (the ipify lesson).
 *
 * Extracted from index.ts (FE1) so tools.ts/memory.ts can emit events without
 * an import cycle (index.ts imports tools.ts).
 */
import { config } from './config.ts';

export function postBuilderTelemetry(
  event: string,
  data: Record<string, unknown>
): void {
  void fetch(`${config.gluuApiUrl}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ts: new Date().toISOString(), ...data }),
    signal: AbortSignal.timeout(5000),
  }).catch((error: unknown) => {
    console.warn(
      `[builder-agent] telemetry post failed (${event}): ${error instanceof Error ? error.message : String(error)}`
    );
  });
}
