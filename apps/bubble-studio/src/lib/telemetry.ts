/**
 * Structured telemetry emitter for programmatic observation.
 *
 * Every meaningful UI action / state change logs a single machine-readable
 * console line so a Playwright or agent harness can assert on app behavior
 * deterministically (via console message capture) without reading pixels.
 *
 * Contract: one console.info line per event, payload is
 *   JSON.stringify({ t: 'telemetry', event, ts, ...payload })
 * `t: 'telemetry'` is the stable discriminator; `event` is a stable
 * dot-namespaced name (e.g. 'pearl.stream_complete', 'ui.toast').
 */
import { toast, type ToastItem } from 'react-toastify';

export type TelemetryPayload = Record<string, unknown>;

export function emitTelemetry(
  event: string,
  payload: TelemetryPayload = {}
): void {
  try {
    console.info(
      JSON.stringify({ t: 'telemetry', event, ts: Date.now(), ...payload })
    );
  } catch {
    // Telemetry must never break the app (e.g. circular payloads).
    try {
      console.info(JSON.stringify({ t: 'telemetry', event, ts: Date.now() }));
    } catch {
      /* no-op */
    }
  }
}

let toastTelemetryInstalled = false;

/**
 * Subscribes to react-toastify's global onChange feed and emits a
 * `ui.toast` telemetry event for every toast lifecycle change
 * (added / updated / removed). Covers every toast call site with one hook.
 */
export function installToastTelemetry(): void {
  if (toastTelemetryInstalled) return;
  toastTelemetryInstalled = true;
  toast.onChange((item: ToastItem) => {
    emitTelemetry('ui.toast', {
      status: item.status,
      toastType: item.type,
      toastId: item.id,
      content: typeof item.content === 'string' ? item.content : undefined,
    });
  });
}
