/**
 * Event-assertion test harness (DISPATCH-CONTRACT Pillar 2, backlog F0.1).
 *
 * The ONE import a test file needs. Drives a real path (API + sidecar,
 * optionally headless studio), collects the four logged-event sources
 * (execute-stream SSE, run history, build thread, telemetry), asserts on
 * logged events, prints one structured JSON report on stdout, exits coded:
 *   0 all assertions pass
 *   1 at least one assertion failed (a real red)
 *   2 usage/config error
 *   3 stack unavailable (infra problem, NOT a code failure — F0.2 refuses to act)
 *
 * Minimal test file:
 *   import { createHarness } from '../harness.mjs';
 *   const t = await createHarness({ name: 'S6.example', backlogId: 'S6' });
 *   const flowId = await t.seedFlow({ name, prompt, code });
 *   const run = await t.executeStream(flowId);
 *   t.assert('run clean', run.success && run.signals.length === 0);
 *   await t.finish();
 *
 * Pillar-2 self-event: finish() POSTs `event_test.run` to /telemetry, so every
 * harness run is itself queryable from the telemetry ring buffer.
 */
import { resolveStack, StackUnavailableError, EXIT_STACK_UNAVAILABLE } from './lib/stack.mjs';
import { jsonFetch, sseCollect } from './lib/api.mjs';
import { runErrorSignals, FIX_REQUEST_MARKER } from './lib/signals.mjs';
import * as sources from './lib/sources.mjs';
import * as fixtures from './lib/fixtures.mjs';
import { createReporter } from './lib/report.mjs';
import { createBrowser } from './lib/browser.mjs';

export { runErrorSignals, FIX_REQUEST_MARKER, StackUnavailableError };

export async function createHarness(opts) {
  if (!opts?.name) {
    console.error('createHarness: opts.name (test id) is required');
    process.exit(2);
  }
  let stack;
  try {
    stack = await resolveStack(opts);
  } catch (e) {
    if (e instanceof StackUnavailableError) {
      // No report claiming assertions ran: emit a refusal document and exit 3.
      console.error(`STACK UNAVAILABLE  ${e.message}`);
      console.log(
        JSON.stringify({
          test: opts.name,
          pass: false,
          exitCode: EXIT_STACK_UNAVAILABLE,
          stackUnavailable: true,
          error: e.message,
          assertions: [],
        })
      );
      process.exit(EXIT_STACK_UNAVAILABLE);
    }
    throw e;
  }

  const reporter = createReporter({
    name: opts.name,
    backlogId: opts.backlogId,
    branch: stack.branch,
    stack: { api: stack.api, sidecar: stack.sidecar, studio: stack.studio, source: stack.source },
  });
  const cleanups = [];
  const timeoutMs = opts.timeoutMs ?? 8 * 60_000; // agent turns run 1-5 min
  const budget = setTimeout(() => {
    reporter.assert('global time budget', false, `exceeded ${timeoutMs}ms`);
    void finish();
  }, timeoutMs);
  budget.unref?.();

  async function finish() {
    clearTimeout(budget);
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error(`cleanup failed: ${e.message}`);
      }
    }
    const report = reporter.build();
    // Pillar-2 self-event: the harness run is itself an assertable logged event.
    try {
      await jsonFetch(stack.api, '/telemetry', {
        method: 'POST',
        body: JSON.stringify({
          event: 'event_test.run',
          ts: new Date().toISOString(),
          test: report.test,
          backlogId: report.backlogId ?? null,
          branch: report.branch,
          pass: report.pass,
          exitCode: report.exitCode,
          assertions: report.assertions.length,
          failed: report.assertions.filter((a) => !a.pass).length,
          flowId: reporter.artifacts.flowIds[0] ?? null,
        }),
      });
    } catch {
      /* telemetry sink is best-effort */
    }
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.exitCode);
  }

  return {
    stack,
    artifacts: reporter.artifacts,

    // raw transports
    api: (path, init) => jsonFetch(stack.api, path, init),
    sse: (base, path, payload, ms) => sseCollect(base, path, payload, ms),

    // event-source collectors (Pillar 2 table, one method per row)
    async executeStream(flowId, payload, ms) {
      const run = await sources.executeStream(stack, flowId, payload, ms);
      reporter.recordEvents('executeStream', run.events);
      const execId = run.events.find((e) => e.executionId)?.executionId;
      if (execId) reporter.artifacts.executionIds.push(execId);
      return run;
    },
    executions: (flowId, limit) => sources.executions(stack, flowId, limit),
    async buildThread(flowId) {
      const thread = await sources.buildThread(stack, flowId);
      if (thread?.sessionId) reporter.artifacts.sessionId = thread.sessionId;
      return thread;
    },
    async buildMessage(flowId, message, ms) {
      const turn = await sources.buildMessage(stack, flowId, message, ms);
      reporter.recordEvents('buildThread', turn.events);
      return turn;
    },
    awaitThreadTurn: (flowId, o) => sources.awaitThreadTurn(stack, flowId, o),
    telemetryBaseline: () => sources.telemetryBaseline(stack),
    async telemetry(filter) {
      const events = await sources.telemetry(stack, filter);
      reporter.recordEvents('telemetry', events);
      return events;
    },

    // fixtures (auto-cleanup registered LIFO)
    async seedFlow(spec) {
      const flowId = await fixtures.seedFlow(stack, spec);
      reporter.artifacts.flowIds.push(flowId);
      cleanups.push(() => fixtures.deleteFlow(stack, flowId));
      return flowId;
    },
    cleanup: (fn) => cleanups.push(fn),

    // optional headless UI (temporary bridge only — see lib/browser.mjs header)
    browser: (session) => createBrowser(session),

    // verdict
    assert: (name, pass, detail) => reporter.assert(name, pass, detail),
    section: (label) => reporter.section(label),
    finish,
  };
}
