import { useLayoutEffect, useRef, type RefObject } from 'react';
import { track } from '@/lib/telemetry';

/**
 * U3 layout-containment tripwire (always-on): after every commit, compare the
 * referenced element's rendered content height (scrollHeight) against the
 * height the layout formula reserved for it (clientHeight). A violation of
 * the reserved >= rendered invariant emits one `layout.node_overflow` event
 * through lib/telemetry's track() (console + PostHog + POST /telemetry server
 * ring buffer), so `GET /telemetry` can assert no-overflow without a
 * screenshot.
 *
 * Fires at most once per mounted node to keep the ring buffer signal, not
 * spam; the clip wrappers mean a violation shows as clipped text, and the
 * event is the regression alarm.
 */
export function useOverflowTripwire(
  ref: RefObject<HTMLElement | null>,
  nodeId: string,
  kind: string
): void {
  const fired = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fired.current) return;
    if (el.scrollHeight > el.clientHeight + 1) {
      fired.current = true;
      track('layout.node_overflow', {
        nodeId,
        kind,
        allocated: el.clientHeight,
        rendered: el.scrollHeight,
      });
    }
  });
}
