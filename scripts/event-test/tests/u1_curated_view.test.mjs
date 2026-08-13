#!/usr/bin/env node
/**
 * U1 (#5) acceptance (BACKLOG U1): expanding a canvas node renders the
 * curated view-model only — asserted from the `node.curated_view_rendered`
 * telemetry event (server ring buffer, GET /telemetry), whose payload derives
 * from the SAME object the panel renders (curatedNodeView.ts).
 *
 * F0.5 leakage lens (PRODUCT-PRINCIPLES per-task table, U1 row): the field
 * list equals the whitelist exactly per node kind; no rendered label matches
 * /_CRED$/ or SCREAMING_SNAKE; agent tool/memory labels are humanized (no
 * raw slugs).
 */
import { createHarness } from '../harness.mjs';
import { AGENT_TOOL_CODE } from '../lib/uxFixtures.mjs';
import { studioBrowser, openFlowPage, readNodes, sleep, isLeakedLabel } from '../lib/studio.mjs';

const AGENT_FIELDS = ['systemPrompt', 'allowedTools', 'memorySources'];
const TOOL_FIELDS = ['description'];
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const t = await createHarness({ name: 'u1_curated_view', backlogId: 'U1' });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U1 fixture',
  prompt: 'U1 fixture: agent + tool weather summary flow',
  eventType: 'schedule/cron',
  code: AGENT_TOOL_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

t.section('expand every bubble node');
const baseline = await t.telemetryBaseline();
const b = studioBrowser(t, 'u1-curated-view');
await openFlowPage(b, t, flowId);
const bubbleNodes = readNodes(b).filter((n) => n.type === 'bubbleNode');
t.assert('canvas rendered bubble nodes', bubbleNodes.length >= 2, JSON.stringify(bubbleNodes).slice(0, 200));
for (const node of bubbleNodes) {
  // Real expansion path: the same uiStore action the node's click handler calls.
  b.evalJs(
    `(async () => { const m = await import('/src/stores/uiStore.ts'); m.useUIStore.getState().setExpandedFlowNode(${JSON.stringify(node.id)}); return true; })()`
  );
  await sleep(1500);
}
await sleep(2500); // telemetry server-sink flush

t.section('node.curated_view_rendered events');
const events = (await t.telemetry({ type: 'node.curated_view_rendered', flowId, sinceSeq: baseline })).map(
  (e) => e.event
);
t.assert('an expansion emitted curated-view telemetry', events.length >= 2, `events=${events.length}`);
const agentEvent = events.find((e) => e.nodeKind === 'agent');
const toolEvent = events.find((e) => e.nodeKind === 'tool');
t.assert('agent node event present (ai-agent)', Boolean(agentEvent), JSON.stringify(events.map((e) => [e.bubbleName, e.nodeKind])));
t.assert('tool node event present', Boolean(toolEvent), JSON.stringify(events.map((e) => [e.bubbleName, e.nodeKind])));
t.assert(
  'agent view exposes exactly the whitelist fields',
  Boolean(agentEvent) && sameSet(agentEvent.fields ?? [], AGENT_FIELDS),
  JSON.stringify(agentEvent?.fields)
);
t.assert(
  'tool view exposes exactly the whitelist fields',
  Boolean(toolEvent) && sameSet(toolEvent.fields ?? [], TOOL_FIELDS),
  JSON.stringify(toolEvent?.fields)
);

t.section('F0.5 no-technical-leakage lens');
const renderedLabels = [];
for (const e of events) {
  renderedLabels.push(...(e.allowedTools ?? []), ...(e.memorySources ?? []));
  for (const slot of e.credentialSlots ?? []) {
    renderedLabels.push(slot.displayName, ...(slot.name ? [slot.name] : []));
  }
}
const leaked = renderedLabels.filter((label) => isLeakedLabel(label));
t.assert(
  'no rendered label is a *_CRED / SCREAMING_SNAKE machine constant',
  leaked.length === 0,
  JSON.stringify({ leaked, renderedLabels }).slice(0, 300)
);
const rawSlugs = (agentEvent?.allowedTools ?? []).filter((label) => /-/.test(label));
t.assert(
  'agent tool labels are humanized (no raw hyphenated slugs)',
  rawSlugs.length === 0,
  JSON.stringify(agentEvent?.allowedTools)
);
const RAW_PARAM_NAMES = ['url', 'method', 'message', 'operation', 'limit'];
t.assert(
  'no whitelist field is a raw bubble param name',
  events.every((e) => (e.fields ?? []).every((f) => !RAW_PARAM_NAMES.includes(f))),
  JSON.stringify(events.map((e) => e.fields))
);

await t.finish();
