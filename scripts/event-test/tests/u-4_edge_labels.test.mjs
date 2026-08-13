#!/usr/bin/env node
/**
 * U-4 acceptance (BACKLOG U-4): guard-clause / bare-else edges carry NO
 * 'otherwise' label on the canvas, while informative conditional labels stay.
 *
 * Data half (no DOM): the persisted flow's workflow is run through the REAL
 * step-graph modules (utils/workflowToSteps + utils/flowChecklist, imported
 * in-page from the live Vite module graph) to prove the fixture produces
 * both an 'otherwise'-humanizing edge (the suppression case) and an
 * informative conditional edge (the keep case).
 *
 * BRIDGE NOTE (deviation): the final rendered-edge check reads the React Flow
 * edge label texts (structured .react-flow__edge textContent, no pixels)
 * because edge data emits no logged event yet and feature code is frozen.
 * Follow-up for the U-4 PR: emit a `canvas.edges_built` telemetry payload and
 * graduate this assertion to GET /telemetry.
 */
import { createHarness } from '../harness.mjs';
import { STEPS_BRANCH_CODE } from '../lib/uxFixtures.mjs';
import { studioBrowser, openFlowPage, readEdgeLabels } from '../lib/studio.mjs';

const t = await createHarness({ name: 'u-4_edge_labels', backlogId: 'U-4' });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U-4 fixture',
  prompt: 'U-4 fixture: guard clause + if/else weather flow',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

t.section('edge data through the real step-graph modules');
const b = studioBrowser(t, 'u4-edge-labels');
await openFlowPage(b, t, flowId);
const graph = b.evalJs(
  `(async () => {
    const flow = await (await fetch(${JSON.stringify(t.stack.api)} + '/bubble-flow/' + ${flowId})).json();
    const wts = await import('/src/utils/workflowToSteps.ts');
    const fc = await import('/src/utils/flowChecklist.ts');
    const bubbles = {};
    for (const [k, bub] of Object.entries(flow.bubbleParameters ?? {})) {
      const id = bub.variableId ?? parseInt(k, 10);
      if (!isNaN(id)) bubbles[id] = bub;
    }
    const g = wts.extractStepGraph(flow.workflow, bubbles);
    return g.edges.map((e) => ({
      label: e.label ?? null,
      humanized: e.label ? fc.humanizeConditionLabel(e.label) : null,
    }));
  })()`
);
t.assert('step graph produced edges', Array.isArray(graph) && graph.length > 0, JSON.stringify(graph).slice(0, 300));
const otherwiseEdges = (graph ?? []).filter((e) => e.humanized === 'otherwise');
const informative = (graph ?? []).filter((e) => e.humanized && e.humanized !== 'otherwise');
t.assert(
  "fixture produces at least one guard/bare-else edge humanizing to 'otherwise' (the suppression case exists)",
  otherwiseEdges.length > 0,
  JSON.stringify(graph)
);
t.assert(
  'fixture produces at least one informative conditional edge label',
  informative.length > 0,
  JSON.stringify(informative)
);

t.section('rendered canvas edges');
const rendered = readEdgeLabels(b);
t.assert(
  "no rendered edge carries the 'otherwise' label",
  rendered.every((label) => label !== 'otherwise'),
  JSON.stringify(rendered)
);
t.assert(
  'the informative conditional label still renders',
  informative.some((e) => rendered.includes(e.humanized)),
  `rendered=${JSON.stringify(rendered)} expected-one-of=${JSON.stringify(informative.map((e) => e.humanized))}`
);

await t.finish();
