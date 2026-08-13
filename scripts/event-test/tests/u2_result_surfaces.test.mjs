#!/usr/bin/env node
/**
 * U2 (#2) acceptance (BACKLOG U2): the flow's headline result, end to end.
 *
 * Chain asserted on logged events + the ONE shared selector:
 * 1. PATCH /bubble-flow/:id/primary-output persists metadata.primaryOutput.
 * 2. A real run's execution_complete carries finalResult with the registered
 *    keys (execute-stream, logged).
 * 3. The REAL shared selector (resultNodeValue.deriveResultNodeValue,
 *    imported in-page from the live module graph) derives the surfaced value
 *    from the persisted execution row: artefactUrl = finalResult[artefactKey],
 *    outcomes = plain strings, never raw JSON (F0.5 U2 lens).
 * 4. Clicking the canvas ResultNode emits result_node_reveal
 *    {surface:'canvas', hasValue:true} (GET /telemetry).
 * 5. A live agent turn calling set_primary_output produces the result_ready
 *    conversation message (real usePearlStream translator + store) and the
 *    ResultRevealWidget's result_node_reveal {surface:'conversation'}
 *    telemetry; the tool_use is logged on the build thread.
 */
import { createHarness } from '../harness.mjs';
import { RESULT_CODE } from '../lib/uxFixtures.mjs';
import {
  studioBrowser,
  openFlowPage,
  kickSendBuildMessage,
  awaitPageFlag,
  readChatMessages,
  threadToolUses,
  sleep,
} from '../lib/studio.mjs';

const PRIMARY_OUTPUT = {
  kind: 'both',
  label: 'Your weather note',
  artefactKey: 'report_url',
  outcomeKeys: ['summary'],
};

const t = await createHarness({ name: 'u2_result_surfaces', backlogId: 'U2', timeoutMs: 12 * 60_000 });

t.section('seed + register primary output');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U2 fixture',
  prompt: 'U2 fixture: weather note with a linkable report',
  eventType: 'schedule/cron',
  code: RESULT_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);
const patched = await t.api(`/bubble-flow/${flowId}/primary-output`, {
  method: 'PATCH',
  body: JSON.stringify(PRIMARY_OUTPUT),
});
t.assert('PATCH /primary-output accepted', patched.status === 200, JSON.stringify(patched.body).slice(0, 150));
const flow = await t.api(`/bubble-flow/${flowId}`);
t.assert(
  'metadata.primaryOutput persisted round-trip',
  JSON.stringify(flow.body?.metadata?.primaryOutput) === JSON.stringify(PRIMARY_OUTPUT),
  JSON.stringify(flow.body?.metadata?.primaryOutput)
);

t.section('run (logged finalResult)');
const run = await t.executeStream(flowId, {});
const complete = run.events.find((e) => e.type === 'execution_complete');
const finalResult = complete?.additionalData?.finalResult ?? complete?.additionalData?.result;
t.assert('run succeeded', run.success, complete?.message);
t.assert(
  'finalResult carries the registered keys',
  typeof finalResult?.report_url === 'string' && typeof finalResult?.summary === 'string',
  JSON.stringify(finalResult).slice(0, 200)
);

t.section('shared selector derives the surfaced value (in-page, real module)');
const baseline = await t.telemetryBaseline();
const b = studioBrowser(t, 'u2-result-surfaces');
await openFlowPage(b, t, flowId);
const derived = b.evalJs(
  `(async () => {
    const m = await import('/src/components/flow_visualizer/resultNodeValue.ts');
    const api = ${JSON.stringify(t.stack.api)};
    const flow = await (await fetch(api + '/bubble-flow/' + ${flowId})).json();
    const po = m.getPrimaryOutput(flow.metadata);
    const execs = await (await fetch(api + '/bubble-flow/' + ${flowId} + '/executions?limit=1')).json();
    let row = execs.items?.[0]?.result ?? null;
    if (typeof row === 'string') { try { row = JSON.parse(row); } catch { /* keep */ } }
    const value = m.deriveResultNodeValue(po, [], row);
    return { po, value, hasValue: m.resultHasValue(value) };
  })()`
);
t.assert('selector saw the persisted registration', derived?.po?.kind === 'both', JSON.stringify(derived?.po));
t.assert(
  'artefactUrl is exactly finalResult[artefactKey]',
  derived?.value?.artefactUrl === finalResult?.report_url,
  JSON.stringify(derived?.value)
);
t.assert(
  'outcomes surface finalResult[outcomeKey] as plain language (no raw JSON)',
  Array.isArray(derived?.value?.outcomes) &&
    derived.value.outcomes.includes(finalResult?.summary) &&
    derived.value.outcomes.every((o) => typeof o === 'string' && !o.includes('{')),
  JSON.stringify(derived?.value?.outcomes)
);
t.assert('selector reports hasValue', derived?.hasValue === true, String(derived?.hasValue));

t.section('canvas ResultNode reveal telemetry');
const clicked = b.clickText(PRIMARY_OUTPUT.label);
t.assert('ResultNode reveal button found + clicked', clicked === true, String(clicked));
await sleep(2500);
const canvasReveals = (
  await t.telemetry({ type: 'result_node_reveal', flowId, sinceSeq: baseline })
).map((e) => e.event);
t.assert(
  "result_node_reveal logged with surface:'canvas', hasValue:true, kind:'both'",
  canvasReveals.some((e) => e.surface === 'canvas' && e.hasValue === true && e.kind === 'both'),
  JSON.stringify(canvasReveals)
);

t.section('conversation result_ready (live agent turn)');
const INSTRUCTION =
  `Do exactly this and nothing else: call the set_primary_output tool once with ` +
  `kind='both', label='${PRIMARY_OUTPUT.label}', artefactKey='report_url', outcomeKeys=['summary']. ` +
  `Then reply with the single word done. Do not modify the flow code and do not run the flow.`;
const kicked = kickSendBuildMessage(b, flowId, INSTRUCTION, '__u2turn');
t.assert('sendBuildMessage kicked in the page', kicked === true, String(kicked));
const flag = await awaitPageFlag(b, '__u2turn', 8 * 60_000);
t.assert('turn completed without transport error', flag?.done === true && !flag?.err, JSON.stringify(flag));
const thread = await t.buildThread(flowId);
const uses = threadToolUses(thread, 'set_primary_output');
t.assert(
  'thread transcript logs the set_primary_output tool_use',
  uses.some((input) => input.artefactKey === 'report_url'),
  JSON.stringify(uses).slice(0, 300)
);
const messages = readChatMessages(b, flowId);
const resultReady = messages.filter((m) => m.type === 'result_ready');
t.assert(
  'pearlChatStore holds a result_ready message carrying the registration',
  resultReady.some((m) => m.primaryOutput?.artefactKey === 'report_url' && m.primaryOutput?.kind === 'both'),
  JSON.stringify(resultReady).slice(0, 300)
);
await sleep(2500);
const convoReveals = (
  await t.telemetry({ type: 'result_node_reveal', flowId, sinceSeq: baseline })
).map((e) => e.event);
t.assert(
  "ResultRevealWidget logged result_node_reveal with surface:'conversation'",
  convoReveals.some((e) => e.surface === 'conversation'),
  JSON.stringify(convoReveals)
);

await t.finish();
