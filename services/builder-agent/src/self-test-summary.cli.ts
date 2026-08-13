#!/usr/bin/env node
/**
 * S4 parity CLI — exposes the sidecar's run reducer (gluu-client.ts
 * reduceRunEvents / executeFlowStream) to the event-test harness
 * (scripts/event-test/tests/s4_requirement_completeness.test.mjs), so tests
 * can assert the sidecar and the studio collector agree on every failure
 * class. Runs under plain `node` (Node >= 24 type-stripping, same as
 * `npm run start`).
 *
 * Modes:
 *   node src/self-test-summary.cli.ts collect
 *     stdin:  JSON array of StreamingLogEvents
 *     stdout: { signals, stepOutcomes, toolCalls, finalResult, success }
 *             (success here = signals.length === 0; no stream in play)
 *
 *   node src/self-test-summary.cli.ts run <apiUrl> <flowId> [payloadJson]
 *     Executes the flow through executeFlowStream (the same reducer the
 *     test_run_flow tool uses, including the sidecar.self_test.run telemetry
 *     emit) and prints the FlowRunSummary.
 */
import { z } from 'zod';
import {
  GluuClient,
  reduceRunEvents,
  runStreamEventSchema,
} from './gluu-client.ts';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === 'collect') {
  const raw: unknown = JSON.parse(await readStdin());
  const events = z.array(runStreamEventSchema).parse(raw);
  const reduced = reduceRunEvents(events);
  console.log(
    JSON.stringify({ ...reduced, success: reduced.signals.length === 0 })
  );
} else if (mode === 'run') {
  const [apiUrl, flowIdRaw, payloadRaw] = rest;
  const flowId = Number(flowIdRaw);
  if (!apiUrl || !Number.isInteger(flowId)) {
    console.error(
      'usage: self-test-summary.cli.ts run <apiUrl> <flowId> [payloadJson]'
    );
    process.exit(2);
  }
  const payload = z
    .record(z.string(), z.unknown())
    .parse(payloadRaw ? JSON.parse(payloadRaw) : {});
  const summary = await new GluuClient(apiUrl).executeFlowStream(
    flowId,
    payload
  );
  console.log(JSON.stringify(summary));
} else {
  console.error(
    'usage: self-test-summary.cli.ts collect | run <apiUrl> <flowId> [payloadJson]'
  );
  process.exit(2);
}
