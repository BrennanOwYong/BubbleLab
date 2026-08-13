#!/usr/bin/env node
/**
 * U-3 acceptance (BACKLOG U-3): dragging a node persists its position across
 * a rebuild "not just in-session state" — i.e. it must survive a real page
 * reload/reopen, not merely an in-place recompute of the same mounted
 * FlowVisualizer instance.
 *
 * Test-fidelity fix (independent audit): the prior version of this test only
 * toggled `expandedFlowNode` on the SAME mounted component (structureChanged
 * recompute) — persistedPositions is a plain useRef, so that recompute could
 * never have caught a regression that dropped positions on unmount. The fix
 * (FlowVisualizer.tsx) persists dragged positions to localStorage keyed per
 * flow (`bubblelab:node-positions:<flowId>`) and emits a
 * `canvas.node_position_persisted` telemetry event on both write (drag end)
 * and read (mount restore), so this test now does a REAL page reload
 * (b.open the same flow URL again in the same browser session/profile — a
 * fresh FlowVisualizer mount, empty in-memory ref) and asserts survival from
 * both the DOM (position) and the logged event (mechanism).
 *
 * Drive: real mouse input (CDP) drags the entry node; survival is checked
 * first across an in-place recompute (regression coverage for the original
 * bug), then across a full reload (the literal "not just in-session state"
 * accept clause).
 */
import { createHarness } from '../harness.mjs';
import { STEPS_BRANCH_CODE } from '../lib/uxFixtures.mjs';
import { studioBrowser, openFlowPage, readNodes, sleep } from '../lib/studio.mjs';

const t = await createHarness({ name: 'u-3_drag_persist', backlogId: 'U-3' });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U-3 fixture',
  prompt: 'U-3 fixture: weather note flow (steps layout)',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

t.section('render');
const openBaseline = await t.telemetryBaseline();
const b = studioBrowser(t, 'u3-drag-persist');
await openFlowPage(b, t, flowId);
const before = readNodes(b);
const entry = before.find((n) => n.id === 'cron-schedule-node');
const stepNode = before.find((n) => n.type === 'stepContainerNode');
const bubbleNode = before.find((n) => n.type === 'bubbleNode');
t.assert('canvas rendered entry + step + bubble nodes', Boolean(entry && stepNode && bubbleNode), JSON.stringify(before).slice(0, 300));

t.section('drag');
const box = b.evalJs(
  `(() => { const r = document.querySelector('.react-flow__node[data-id="cron-schedule-node"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`
);
t.assert('entry node on screen', Boolean(box && box.w > 0), JSON.stringify(box));
const cx = Math.round(box.x + box.w / 2);
const cy = Math.round(box.y + Math.min(20, box.h / 2)); // top strip: clear of inner controls
const mouse = (...args) => b.raw(['mouse', ...args.map(String)], { allowFail: true });
mouse('move', cx, cy);
mouse('down');
mouse('move', cx + 40, cy + 25);
mouse('move', cx + 90, cy + 55);
mouse('up');
await sleep(800);
const afterDrag = readNodes(b).find((n) => n.id === 'cron-schedule-node');
const moved =
  afterDrag && (Math.abs(afterDrag.x - entry.x) > 5 || Math.abs(afterDrag.y - entry.y) > 5);
t.assert(
  'drag changed the node position',
  Boolean(moved),
  `before=(${entry?.x},${entry?.y}) after=(${afterDrag?.x},${afterDrag?.y})`
);

t.section('drag-end persisted to localStorage (logged event)');
await sleep(2000); // localStorage write is synchronous; telemetry server-sink batches on a 1s flush timer
const persistEvents = (
  await t.telemetry({ type: 'canvas.node_position_persisted', sinceSeq: openBaseline, limit: 500 })
).map((e) => e.event);
const persistedEvent = persistEvents.find((e) => e.action === 'persisted');
t.assert(
  'drag end emitted canvas.node_position_persisted (action=persisted)',
  Boolean(persistedEvent),
  JSON.stringify(persistEvents)
);

t.section('in-place recompute keeps the dragged position (regression coverage)');
// Toggle inline-expansion of a DIFFERENT node through the real uiStore: this
// flips FlowVisualizer's structureChanged branch, rebuilding every node from
// initialNodes where only persistedPositions survive. This is the original
// bug's exact reproduction path — kept as a fast regression check alongside
// the reload check below, which is the literal accept-clause proof.
const toggled = b.evalJs(
  `(async () => { const m = await import('/src/stores/uiStore.ts'); m.useUIStore.getState().toggleExpandedFlowNode(${JSON.stringify(bubbleNode.id)}); return true; })()`
);
t.assert('rebuild trigger fired (toggleExpandedFlowNode)', toggled === true, String(toggled));
await sleep(2000);
const afterRebuild = readNodes(b).find((n) => n.id === 'cron-schedule-node');
const persistedAcrossRebuild =
  afterRebuild &&
  Math.abs(afterRebuild.x - afterDrag.x) <= 2 &&
  Math.abs(afterRebuild.y - afterDrag.y) <= 2;
t.assert(
  'dragged position persisted across the in-place rebuild',
  Boolean(persistedAcrossRebuild),
  `dragged=(${afterDrag?.x},${afterDrag?.y}) rebuilt=(${afterRebuild?.x},${afterRebuild?.y})`
);

t.section('dragged position survives a REAL reload (not just in-session state)');
const reloadBaseline = await t.telemetryBaseline();
// Same browser session/profile => same localStorage origin; b.open does a
// full navigation, so this is a genuine remount (fresh persistedPositions
// ref), not the in-memory recompute exercised above.
await openFlowPage(b, t, flowId);
const afterReload = readNodes(b).find((n) => n.id === 'cron-schedule-node');
const survivedReload =
  afterReload &&
  Math.abs(afterReload.x - afterDrag.x) <= 2 &&
  Math.abs(afterReload.y - afterDrag.y) <= 2;
t.assert(
  'dragged position survived a full page reload/reopen',
  Boolean(survivedReload),
  `dragged=(${afterDrag?.x},${afterDrag?.y}) afterReload=(${afterReload?.x},${afterReload?.y})`
);

t.section('reload restore is a logged event, not just DOM state');
const restoreEvents = (
  await t.telemetry({ type: 'canvas.node_position_persisted', sinceSeq: reloadBaseline, limit: 500 })
).map((e) => e.event);
const restoredEvent = restoreEvents.find((e) => e.action === 'restored');
t.assert(
  'reload emitted canvas.node_position_persisted (action=restored) reading the persisted positions',
  Boolean(restoredEvent),
  JSON.stringify(restoreEvents)
);

await t.finish();
