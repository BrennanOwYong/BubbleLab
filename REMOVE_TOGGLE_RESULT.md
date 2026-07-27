# Remove toggle-interactivity control — result

status: done
branch: feature/remove-toggle (base: origin/feature/mvp-oneshot @ 9216ef9)

## What the button was

React Flow's built-in interactivity lock toggle, rendered by default inside the `<Controls>` component at `apps/bubble-studio/src/components/flow_visualizer/FlowVisualizer.tsx:2706`. No custom handler or state drove it; the component ships zoom-in, zoom-out, fit-view, and the lock toggle unless disabled per-button.

## How removed

Added `showInteractive={false}` to the `<Controls>` element. Zoom-in, zoom-out, and fit-view buttons remain; pan/zoom props on `<ReactFlow>` (lines 2698–2704) untouched. No handler/state cleanup needed since the toggle was library-internal.

## Verification

- `pnpm --filter bubble-studio exec tsc --noEmit`: clean (no output).
- `pnpm --filter bubble-studio exec vite build`: ✓ built in 34.31s (pre-existing chunk-size warnings only).
- Other canvas controls unaffected: `showInteractive` scopes to the one button per React Flow's Controls API.

## Deviations

None.
