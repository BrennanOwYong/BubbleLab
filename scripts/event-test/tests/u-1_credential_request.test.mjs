#!/usr/bin/env node
/**
 * U-1 acceptance (BACKLOG U-1): a `report_missing_credential` tool_use on the
 * build turn becomes an inline `credential_request` message in the flow
 * conversation.
 *
 * Event chain asserted:
 * 1. GET /build/:id/thread transcript carries the tool_use with the exact
 *    credentialType (logged event, sidecar).
 * 2. The thread status flips to blocked_on_credential (logged state).
 * 3. The REAL translator (usePearlStream.sendBuildMessage, driven in the live
 *    studio page via Vite module import) adds a credential_request message
 *    with that credentialType to the pearlChatStore — read through the same
 *    store module the panel renders from, no DOM parsing.
 */
import { createHarness } from '../harness.mjs';
import { STEPS_BRANCH_CODE } from '../lib/uxFixtures.mjs';
import {
  studioBrowser,
  openFlowPage,
  kickSendBuildMessage,
  awaitPageFlag,
  readChatMessages,
  threadToolUses,
} from '../lib/studio.mjs';

const CRED_TYPE = 'NOTION_OAUTH_TOKEN';
const INSTRUCTION =
  `Do exactly this and nothing else: call the report_missing_credential tool once ` +
  `with credentialType '${CRED_TYPE}' and deferredSetupScript []. ` +
  `Then reply with the single word done. Do not modify the flow, do not run it, do not call any other tool.`;

const t = await createHarness({ name: 'u-1_credential_request', backlogId: 'U-1', timeoutMs: 12 * 60_000 });

t.section('seed');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST U-1 fixture',
  prompt: 'U-1 fixture: weather note flow (no credentials)',
  eventType: 'schedule/cron',
  code: STEPS_BRANCH_CODE,
});
t.assert('fixture flow seeded', Boolean(flowId), `flowId=${flowId}`);

t.section('live turn through the studio page');
const b = studioBrowser(t, 'u1-cred-request');
await openFlowPage(b, t, flowId);
const kicked = kickSendBuildMessage(b, flowId, INSTRUCTION, '__u1turn');
t.assert('sendBuildMessage kicked in the page', kicked === true, String(kicked));
const flag = await awaitPageFlag(b, '__u1turn', 8 * 60_000);
t.assert('turn completed without transport error', flag?.done === true && !flag?.err, JSON.stringify(flag));

t.section('logged events');
const thread = await t.buildThread(flowId);
const uses = threadToolUses(thread, 'report_missing_credential');
t.assert(
  `thread transcript logs report_missing_credential tool_use with credentialType=${CRED_TYPE}`,
  uses.some((input) => input.credentialType === CRED_TYPE),
  JSON.stringify(uses).slice(0, 300)
);
t.assert(
  "thread status is 'blocked_on_credential'",
  thread?.status === 'blocked_on_credential',
  thread?.status
);

t.section('conversation message (real translator output)');
const messages = readChatMessages(b, flowId);
const credRequests = messages.filter((m) => m.type === 'credential_request');
t.assert(
  'pearlChatStore holds a credential_request message with the reported credentialType',
  credRequests.some((m) => m.credentialType === CRED_TYPE),
  JSON.stringify(credRequests).slice(0, 300)
);

await t.finish();
