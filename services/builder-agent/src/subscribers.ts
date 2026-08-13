/**
 * In-process pub/sub so a second connection can rejoin an in-flight build
 * turn instead of only ever seeing the request that started it. `emit()` in
 * index.ts's turn-owning SSE handler broadcasts here in addition to writing
 * its own stream; `/subscribe` registers a listener BEFORE reading the
 * snapshot (never after), so nothing emitted from registration onward can be
 * missed — the only residual risk is a rare duplicate (an entry landing in
 * both the snapshot and a live broadcast), never a gap.
 *
 * Per-process only. If this sidecar ever runs as more than one process
 * serving the same flow (FE5 managed mode allows it), a subscriber connected
 * to a different process than the one running the turn sees nothing live —
 * would need real cross-process pub/sub (Postgres LISTEN/NOTIFY) instead of
 * this in-memory map.
 */

export type BroadcastListener = (event: string, data: unknown) => void;

const registry = new Map<string, Set<BroadcastListener>>();

export function buildKeyFor(kind: string, subjectId: number): string {
  return `${kind}:${subjectId}`;
}

/** Register a listener; call the returned function to unregister it. */
export function subscribe(
  buildKey: string,
  listener: BroadcastListener
): () => void {
  let set = registry.get(buildKey);
  if (!set) {
    set = new Set();
    registry.set(buildKey, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) registry.delete(buildKey);
  };
}

/** Fan out one frame to every listener registered for buildKey, if any. */
export function broadcast(
  buildKey: string,
  event: string,
  data: unknown
): void {
  const set = registry.get(buildKey);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(event, data);
    } catch (error) {
      console.error(
        `[builder-agent] subscriber listener threw for ${buildKey}:`,
        error
      );
    }
  }
}
