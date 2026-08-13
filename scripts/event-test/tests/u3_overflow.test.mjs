#!/usr/bin/env node
/**
 * U3 acceptance (BACKLOG U3): a canvas render (including expansions) produces
 * ZERO `layout.node_overflow` telemetry — the always-on tripwire
 * (useOverflowTripwire) fires whenever a node's rendered content exceeds the
 * height the layout formula reserved, so an empty query IS the containment
 * proof (F0.5: nothing spills, no internals exposed through overflow).
 *
 * Non-vacuity guards: the page's own api.call telemetry proves the flow page
 * loaded and fetched this flow, and rendered nodes are confirmed before the
 * zero-overflow assertion.
 *
 * F0.5-2 fix (independent test-fidelity audit): the stress loop below
 * expands every `bubbleNode`-type node, but AGENT_TOOL_CODE's tool
 * description was a one-liner that could never approach the 6-line clamp
 * boundary — bubbleNode had zero overflow instrumentation (unlike
 * StepContainerNode/TransformationNode) and this test could not have caught
 * a real regression there. AGENT_TOOL_LONG_DESCRIPTION_CODE gives the
 * HttpBubble tool node a genuinely long, multi-sentence description (via the
 * comment BubbleParser attaches as its curated `description` field) so the
 * loop actually exercises useOverflowTripwire on BubbleNode's curated view.
 */
import { createHarness } from '../harness.mjs';
import { AGENT_TOOL_LONG_DESCRIPTION_CODE } from '../lib/uxFixtures.mjs';
import { studioBrowser, openFlowPage, readNodes, sleep } from '../lib/studio.mjs';

const t = await createHarness({ name: 'u3_overflow', backlogId: 'U3' });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U3 fixture',
  prompt: 'U3 fixture: agent + tool flow with long prompt content',
  eventType: 'schedule/cron',
  code: AGENT_TOOL_LONG_DESCRIPTION_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

t.section('render + expand (stress the layout)');
const baseline = await t.telemetryBaseline();
const b = studioBrowser(t, 'u3-overflow');
await openFlowPage(b, t, flowId);
const nodes = readNodes(b);
t.assert('canvas rendered nodes', nodes.length > 0, JSON.stringify(nodes).slice(0, 200));
for (const node of nodes.filter((n) => n.type === 'bubbleNode')) {
  b.evalJs(
    `(async () => { const m = await import('/src/stores/uiStore.ts'); m.useUIStore.getState().setExpandedFlowNode(${JSON.stringify(node.id)}); return true; })()`
  );
  await sleep(1200);
}
await sleep(2500); // telemetry server-sink flush

t.section('logged events');
const apiCalls = await t.telemetry({ type: 'api.call', sinceSeq: baseline, limit: 500 });
const fetchedThisFlow = apiCalls.some((e) => e.event?.path === `/bubble-flow/${flowId}`);
t.assert(
  'the page emitted api.call telemetry for this flow (render not vacuous)',
  fetchedThisFlow,
  JSON.stringify(apiCalls.map((e) => e.event?.path).slice(0, 20))
);
const curatedEvents = (
  await t.telemetry({ type: 'node.curated_view_rendered', sinceSeq: baseline, limit: 500 })
).map((e) => e.event);
const longDescToolExpanded = curatedEvents.some((e) => e.nodeKind === 'tool');
t.assert(
  'the long-description tool node was actually expanded (genuinely-long case not vacuous)',
  longDescToolExpanded,
  JSON.stringify(curatedEvents.map((e) => [e.bubbleName, e.nodeKind]))
);
const overflows = await t.telemetry({ type: 'layout.node_overflow', sinceSeq: baseline, limit: 500 });
t.assert(
  'zero layout.node_overflow events for the genuinely-long tool description (BubbleNode containment holds)',
  overflows.length === 0,
  JSON.stringify(overflows.map((e) => e.event)).slice(0, 400)
);

await t.finish();
