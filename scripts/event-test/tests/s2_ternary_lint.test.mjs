#!/usr/bin/env node
/**
 * S2 — linter-reject bubble .action() in ternary/short-circuit (BACKLOG S2).
 *
 * Root cause: BubbleParser extracts bubbles at four anchor shapes only; a
 * bubble call inside a ternary or short-circuit expression is never
 * registered in bubbleParameters, so it runs credential-less and fails
 * silently in the user's run (flow 80). The fix is a BLOCKING lint rule
 * (no-bubble-in-ternary-or-short-circuit) that forces valid:false even at
 * gates passing requireLintErrors=false, with a prescriptive if/else+const
 * fix message.
 *
 * Asserts on logged HTTP payloads of the real save gates (no DOM):
 *   1. POST /bubble-flow/validate (ternary)        -> valid:false, blocking (in errors AND lintErrors), prescriptive message
 *   2. POST /bubble-flow/validate (short-circuit)  -> valid:false, /short-circuit/
 *   3. POST /bubble-flow (create, ternary)         -> HTTP 400 'TypeScript validation failed', /ternary/
 *   4. POST /bubble-flow/validate (if/else)        -> valid:true, GOOGLE_DRIVE_CRED slot recognized
 *   5. seeded if/else flow -> GET /bubble-flow/:id bubbleParameters carries the google-drive bubble (injection precondition)
 *
 * The brief's live execute-stream assertion is intentionally skipped: the dev
 * DB's Google Drive credential refresh is dead (memory: drive cred 1), so a
 * live list_files proves credential HEALTH, not S2's extraction invariant.
 * Extraction + credential-slot recognition (assertions 4-5) are the exact
 * preconditions credential injection operates on.
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s2_ternary_lint.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({ name: 's2_ternary_lint', backlogId: 'S2' });

const flowCode = (className, stepBody) => `import { BubbleFlow, GoogleDriveBubble } from '@bubblelab/bubble-core';
import type { WebhookEvent } from '@bubblelab/bubble-core';

export class ${className} extends BubbleFlow<'webhook/http'> {
  async handle(payload: WebhookEvent): Promise<{ ok: boolean }> {
    const ok = await this.listFiles(true);
    return { ok };
  }

  private async listFiles(flag: boolean): Promise<boolean> {
${stepBody}
  }
}
`;

const CODE_TERNARY = flowCode(
  'S2TernaryFlow',
  `    const result = flag
      ? await new GoogleDriveBubble({ operation: 'list_files' }).action()
      : null;
    return result !== null;`
);

const CODE_SHORT_CIRCUIT = flowCode(
  'S2ShortCircuitFlow',
  `    const result = flag && (await new GoogleDriveBubble({ operation: 'list_files' }).action());
    return Boolean(result);`
);

const CODE_IF_ELSE = flowCode(
  'S2IfElseFlow',
  `    if (flag) {
      const result = await new GoogleDriveBubble({ operation: 'list_files' }).action();
      return result.success;
    } else {
      return false;
    }`
);

// --- 1. ternary rejected at the validate/save gate --------------------------
t.section('validate: ternary bubble call');
const ternary = await t.api('/bubble-flow/validate', {
  method: 'POST',
  body: JSON.stringify({ code: CODE_TERNARY }),
});
t.assert('validate(ternary) responds 200', ternary.status === 200, `HTTP ${ternary.status}`);
t.assert('valid === false', ternary.body?.valid === false, `valid=${ternary.body?.valid}`);
const ternaryLint = ternary.body?.lintErrors ?? [];
t.assert(
  'lintErrors non-empty and names the ternary',
  ternaryLint.some((m) => m.includes('ternary')),
  JSON.stringify(ternaryLint).slice(0, 300)
);
t.assert(
  'blocking: the ternary message also lands in errors (not advisory)',
  (ternary.body?.errors ?? []).join(';').includes('ternary'),
  JSON.stringify(ternary.body?.errors).slice(0, 300)
);
const ternaryMsg = ternaryLint.find((m) => m.includes('ternary')) ?? '';
t.assert(
  "message prescribes the fix shape (if/else + const, no rename)",
  ternaryMsg.includes('if/else') && ternaryMsg.includes('const') && /do NOT rename/i.test(ternaryMsg),
  ternaryMsg.slice(0, 300)
);
t.assert(
  'message names the bubble class',
  ternaryMsg.includes('GoogleDriveBubble'),
  ternaryMsg.slice(0, 120)
);

// --- 2. short-circuit rejected ----------------------------------------------
t.section('validate: short-circuit bubble call');
const shortCircuit = await t.api('/bubble-flow/validate', {
  method: 'POST',
  body: JSON.stringify({ code: CODE_SHORT_CIRCUIT }),
});
t.assert('valid === false', shortCircuit.body?.valid === false, `valid=${shortCircuit.body?.valid}`);
t.assert(
  'a lintErrors entry matches /short-circuit/',
  (shortCircuit.body?.lintErrors ?? []).some((m) => /short-circuit/.test(m)),
  JSON.stringify(shortCircuit.body?.lintErrors).slice(0, 300)
);
t.assert(
  'blocking: short-circuit message also lands in errors',
  (shortCircuit.body?.errors ?? []).join(';').includes('short-circuit'),
  JSON.stringify(shortCircuit.body?.errors).slice(0, 300)
);

// --- 3. create path blocks too (bubble-flows.ts create gate) ----------------
t.section('create: ternary bubble call');
const created = await t.api('/bubble-flow', {
  method: 'POST',
  body: JSON.stringify({
    name: 'EVENT-TEST S2 ternary reject fixture',
    code: CODE_TERNARY,
    eventType: 'webhook/http',
  }),
});
if (created.status !== 400 && created.body?.id) {
  // Guard against regression leaking a persisted flow
  t.cleanup(() => t.api(`/bubble-flow/${created.body.id}`, { method: 'DELETE' }));
}
t.assert('create(ternary) returns HTTP 400', created.status === 400, `HTTP ${created.status}`);
t.assert(
  "error === 'TypeScript validation failed'",
  created.body?.error === 'TypeScript validation failed',
  `error=${created.body?.error}`
);
t.assert(
  'details name the ternary',
  /ternary/.test(created.body?.details ?? ''),
  String(created.body?.details).slice(0, 300)
);

// --- 4. if/else equivalent validates clean AND is extracted -----------------
t.section('validate: if/else equivalent');
const ifElse = await t.api('/bubble-flow/validate', {
  method: 'POST',
  body: JSON.stringify({ code: CODE_IF_ELSE }),
});
t.assert('valid === true', ifElse.body?.valid === true, JSON.stringify(ifElse.body?.errors ?? ifElse.body?.error).slice(0, 400));
t.assert(
  'no ternary/short-circuit lint entry',
  !(ifElse.body?.lintErrors ?? []).some((m) => /ternary|short-circuit/.test(m)),
  JSON.stringify(ifElse.body?.lintErrors ?? []).slice(0, 300)
);
// requiredCredentials is keyed by variableId (extractRequiredCredentials over
// bubbleParameters), not bubbleName — assert the slot itself.
const reqCreds = ifElse.body?.requiredCredentials ?? {};
t.assert(
  'requiredCredentials carries a GOOGLE_DRIVE_CRED slot (slot recognized)',
  Object.values(reqCreds).some(
    (types) => Array.isArray(types) && types.includes('GOOGLE_DRIVE_CRED')
  ),
  JSON.stringify(reqCreds).slice(0, 300)
);

// --- 5. seeded if/else flow persists the extracted bubble -------------------
t.section('seed + persisted extraction');
const flowId = await t.seedFlow({
  name: 'EVENT-TEST S2 if-else fixture',
  prompt: 'S2 fixture: if/else bubble call form (extractable)',
  eventType: 'webhook/http',
  code: CODE_IF_ELSE,
});
t.assert('seedFlow saved the if/else fixture', Boolean(flowId), `flowId=${flowId}`);
const flowRes = await t.api(`/bubble-flow/${flowId}`);
const bubbleParams = flowRes.body?.bubbleParameters ?? {};
const driveEntry = Object.values(bubbleParams).find((b) => b?.bubbleName === 'google-drive');
t.assert(
  'bubbleParameters carries the google-drive bubble (injection precondition)',
  Boolean(driveEntry),
  `bubbles=${Object.values(bubbleParams).map((b) => b?.bubbleName).join(',')}`
);
t.assert(
  "extracted bubble declares className GoogleDriveBubble",
  driveEntry?.className === 'GoogleDriveBubble',
  `className=${driveEntry?.className}`
);

await t.finish();
