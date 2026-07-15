/**
 * One-shot prompt -> workflow demo.
 *
 * Shows the whole path honestly, offline where possible:
 *   1. LIVE capability catalogue with per-operation side-effect hints (IR-8)
 *   2. Static validation gate — a flow with a bad literal parameter is
 *      REJECTED at compile time, provably without executing any tool
 *   3. Test-mode run of a stored-shape flow — the write is MOCKED, no network
 *   4. Real LLM generation (runs only when GOOGLE_API_KEY + OPENROUTER_API_KEY
 *      exist; otherwise reported as SKIPPED — never faked):
 *      a normal prompt must yield validated code; an impossible prompt must
 *      FAIL LOUDLY (success=false) instead of emitting garbage.
 *
 * Run from apps/bubblelab-api:  bun run scripts/demo-one-shot.ts
 */

import { BubbleFactory } from '@bubblelab/bubble-core';
import { validateAndExtract, BubbleRunner } from '@bubblelab/bubble-runtime';

let networkAttempts = 0;
const realFetch = globalThis.fetch;

function armNetworkGuard() {
  networkAttempts = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    networkAttempts++;
    return Promise.reject(
      new Error(`network attempt blocked by demo guard: ${String(args[0])}`)
    );
  }) as typeof fetch;
}

function disarmNetworkGuard() {
  globalThis.fetch = realFetch;
}

function section(title: string) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

const GOOD_FLOW = `
import { BubbleFlow, ResendBubble, WebhookEvent } from '@bubblelab/bubble-core';

export interface ReportPayload extends WebhookEvent {
  /** Email address the report is sent to. */
  recipient?: string;
}

export class DailyReportFlow extends BubbleFlow<'webhook/http'> {
  // Sends the daily report email through Resend to the configured recipient
  private async sendReport(recipient: string) {
    const reportEmail = new ResendBubble({
      operation: 'send_email',
      to: recipient,
      subject: 'Daily report',
      text: 'All systems nominal.',
    });
    return await reportEmail.action();
  }

  async handle(payload: ReportPayload) {
    const { recipient = 'user@example.com' } = payload;
    const result = await this.sendReport(recipient);
    return { sent: result.success, mocked: (result as { mocked?: boolean }).mocked };
  }
}
`;

// Same flow with a bad literal recipient (recipient still used, so the
// TypeScript pass is happy — only the Zod value check can catch this).
const BAD_LITERAL_FLOW = GOOD_FLOW.replace(
  "to: recipient,\n      subject: 'Daily report',\n      text: 'All systems nominal.',",
  "to: 'not-an-email',\n      subject: 'Daily report',\n      text: `All systems nominal, ${recipient}.`,"
);

if (BAD_LITERAL_FLOW === GOOD_FLOW) {
  throw new Error('demo fixture replace failed — BAD_LITERAL_FLOW is unchanged');
}

async function main() {
  const factory = new BubbleFactory();
  console.log('Registering live bubble catalogue (this scans real sources)…');
  await factory.registerDefaults();

  // ── 1. Live catalogue with side-effect hints ────────────────────────────
  section('1) LIVE capability catalogue (side-effect hints, read fresh)');
  for (const name of ['resend', 'gmail'] as const) {
    const meta = factory.getMetadata(name);
    const ops = Object.entries(meta?.operationMetadata ?? {});
    console.log(`\n${name}:`);
    if (ops.length === 0) {
      console.log('  (no operation metadata declared)');
      continue;
    }
    for (const [op, m] of ops) {
      console.log(
        `  ${op}: ${m.sideEffect}${m.requiredScopes?.length ? ` scopes=[${m.requiredScopes.join(' ')}]` : ''}`
      );
    }
  }

  // ── 2. Static gate: bad literal rejected without execution ──────────────
  section('2) Bad literal parameter → rejected at compile, tool NEVER runs');
  armNetworkGuard();
  const badResult = await validateAndExtract(BAD_LITERAL_FLOW, factory, false);
  disarmNetworkGuard();
  console.log(`valid: ${badResult.valid}`);
  console.log(`network attempts during validation: ${networkAttempts}`);
  for (const err of badResult.errors ?? []) console.log(`  ✗ ${err}`);
  if (badResult.valid || networkAttempts > 0) {
    throw new Error('DEMO FAILED: bad literal was not rejected statically');
  }

  const goodResult = await validateAndExtract(GOOD_FLOW, factory, false);
  console.log(`\ncontrol (same flow, runtime-provided recipient): valid: ${goodResult.valid}`);
  if (!goodResult.valid) {
    console.log(goodResult.errors);
    throw new Error('DEMO FAILED: the control flow should validate');
  }

  // ── 3. Test-mode run: the write is mocked, zero network ─────────────────
  section('3) Test-mode run of the validated flow (write mocked, no network)');
  armNetworkGuard();
  const runner = new BubbleRunner(GOOD_FLOW, factory, {
    pricingTable: {},
    testMode: true,
  });
  const runResult = await runner.runAll();
  disarmNetworkGuard();
  console.log(`run success: ${runResult.success}`);
  console.log(`flow return: ${JSON.stringify(runResult.data)}`);
  console.log(`network attempts during test-mode run: ${networkAttempts}`);
  const flowReturn = runResult.data as { sent?: boolean; mocked?: boolean };
  if (!runResult.success || flowReturn?.mocked !== true || networkAttempts > 0) {
    throw new Error(
      'DEMO FAILED: test-mode run should mock the write with zero network'
    );
  }
  console.log(
    'The email operation returned a shape-valid result with mocked: true — it DID NOT send.'
  );

  // ── 4. Real LLM generation (honest about requirements) ──────────────────
  section('4) One-shot LLM generation (needs GOOGLE_API_KEY + OPENROUTER_API_KEY)');
  if (!process.env.GOOGLE_API_KEY || !process.env.OPENROUTER_API_KEY) {
    console.log(
      'SKIPPED: GOOGLE_API_KEY / OPENROUTER_API_KEY not set. No fake success —\n' +
        'set the keys and re-run to watch a natural-language prompt become a\n' +
        'validated, storable flow, and an impossible prompt fail loudly.'
    );
    console.log('\nDemo finished: offline stages all passed.');
    return;
  }

  const { runBoba } = await import('../src/services/ai/boba.js');

  console.log('\nPrompt: "Send an email to me with a haiku about automation"');
  const gen = await runBoba({
    prompt: 'Send an email to me with a haiku about automation',
  });
  console.log(`success: ${gen.success}, isValid: ${gen.isValid}`);
  if (!gen.success || !gen.isValid) {
    console.log(`error: ${gen.error}`);
    throw new Error('DEMO FAILED: a feasible prompt did not produce valid code');
  }
  console.log('--- generated code (validated) ---');
  console.log(gen.generatedCode);

  console.log(
    '\nImpossible prompt: "Read my neighbor\'s mind and text me their thoughts"'
  );
  const impossible = await runBoba({
    prompt:
      "Read my neighbor's mind every morning and text me their thoughts using the mind-reader bubble",
  });
  console.log(`success: ${impossible.success}, isValid: ${impossible.isValid}`);
  console.log(`error: ${impossible.error}`);
  if (impossible.success && impossible.isValid) {
    throw new Error(
      'DEMO FAILED: an impossible prompt exited successfully — inspect the code above'
    );
  }
  console.log('Failed loudly instead of emitting garbage — as designed.');

  console.log('\nDemo finished: all stages passed.');
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
