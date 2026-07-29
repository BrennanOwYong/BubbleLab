/**
 * Phase-4 vertical-slice benchmark: drives ONE flow build end-to-end through
 * the API build proxy (studio path) and asserts the four slice criteria:
 *  (a) the agent ran a SETUP phase (provision_spreadsheet during build, not in handle())
 *  (b) the provisioned id landed in the flow's default_inputs
 *  (c) validate is clean AND the code contains zero in-flow resource creation
 *  (d) the thread persisted to Postgres and /resume continues the session
 *
 * Benchmark problem (simplest of the 8): feedback responses -> AI summary ->
 * append to sheet -> notify on Telegram.
 *
 * Usage: node test/benchmark.mjs
 * Env: API_URL (default http://localhost:3011), SIDECAR_URL (default http://localhost:3010)
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3011';
const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://localhost:3010';

const PROBLEM_STATEMENT = [
  'Build this automation for me. Every weekday at 09:00 UTC:',
  '1. Read the customer feedback rows from my feedback spreadsheet (columns: Date, Name, Feedback).',
  "   I do NOT have a feedback spreadsheet yet - please set one up for me as part of the build.",
  '2. Use AI to summarize the new feedback into a short digest (overall sentiment + top themes).',
  '3. Append the digest as a dated row to a "Summaries" tab in that same spreadsheet.',
  '4. Send me the digest in my own Telegram chat.',
  'I want this fully set up so it can run without me editing anything.',
].join('\n');

function fail(step, detail) {
  console.error(`\nFAIL at ${step}: ${detail}`);
  process.exit(1);
}

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json();
}

/** Consume an SSE response; returns frames [{event, data}]. */
async function consumeSse(res, onFrame) {
  const frames = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const raw of parts) {
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data === '') continue;
      try {
        const frame = { event, data: JSON.parse(data) };
        frames.push(frame);
        if (onFrame) onFrame(frame);
      } catch {
        /* heartbeat/comment */
      }
    }
  }
  return frames;
}

const results = [];
function record(name, pass, evidence) {
  results.push({ name, pass, evidence });
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${name}\n  ${evidence}`);
}

// ---------------------------------------------------------------------------
console.log('1. Creating empty flow...');
const created = await json(`${API_URL}/bubble-flow/empty`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'benchmark-feedback-digest',
    eventType: 'webhook/http',
    description: 'Phase-4 benchmark: feedback -> summarize -> append -> notify',
    prompt: PROBLEM_STATEMENT,
  }),
});
const flowId = created.id;
console.log(`   flowId = ${flowId}`);

console.log('2. Sending build message through the API proxy (SSE)...');
const t0 = Date.now();
const buildRes = await fetch(`${API_URL}/build/${flowId}/message`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: PROBLEM_STATEMENT }),
});
if (!buildRes.ok || !buildRes.body) {
  fail('build stream', `HTTP ${buildRes.status}: ${(await buildRes.text()).slice(0, 400)}`);
}
const toolCalls = [];
const frames = await consumeSse(buildRes, (frame) => {
  if (frame.event === 'assistant') {
    for (const block of frame.data.blocks ?? []) {
      if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, input: block.input });
        console.log(`   [tool] ${block.name}`);
      }
    }
  } else if (frame.event === 'session') {
    console.log(`   [session] ${frame.data.session_id}`);
  } else if (frame.event === 'result') {
    console.log(`   [result] subtype=${frame.data.subtype} is_error=${frame.data.is_error} turns=${frame.data.num_turns}`);
  } else if (frame.event === 'done') {
    console.log(`   [done] status=${frame.data.status} session=${frame.data.sessionId}`);
  } else if (frame.event === 'error') {
    console.log(`   [error] ${frame.data.message}`);
  }
});
console.log(`   build turn took ${Math.round((Date.now() - t0) / 1000)}s, ${frames.length} frames`);

const doneFrame = frames.find((f) => f.event === 'done');
const sessionId = doneFrame?.data?.sessionId ?? null;
if (sessionId === null) fail('build stream', 'no done frame with sessionId');

// ---------------------------------------------------------------------------
// (a) setup phase ran: provision_spreadsheet tool call during build
const provisionCalls = toolCalls.filter((t) => t.name === 'mcp__builder__provision_spreadsheet');
const gapCalls = toolCalls.filter((t) => t.name === 'mcp__builder__report_missing_credential');
record(
  '(a) setup phase: provision_spreadsheet ran during build',
  provisionCalls.length > 0 || gapCalls.length > 0,
  provisionCalls.length > 0
    ? `provision_spreadsheet called ${provisionCalls.length}x with input ${JSON.stringify(provisionCalls[0].input)}`
    : gapCalls.length > 0
      ? `credential-gap path fired instead: ${JSON.stringify(gapCalls[0].input)}`
      : `tool calls seen: ${toolCalls.map((t) => t.name).join(', ') || 'none'}`
);

// ---------------------------------------------------------------------------
// (b) provisioned id stored in default_inputs
const flow = await json(`${API_URL}/bubble-flow/${flowId}`);
const defaults = flow.defaultInputs ?? {};
const defaultValues = Object.values(defaults).map(String);
// The real spreadsheetId appears in the persisted transcript's provision tool result.
const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://bubblelab:bubblelab@localhost:5432/bubblelab',
});
const entryRows = await pool.query(
  `select entry from session_entries where session_id = $1 order by id`,
  [sessionId]
);
const transcriptText = entryRows.rows.map((r) => JSON.stringify(r.entry)).join('\n');
const idMatch = transcriptText.match(/"spreadsheetId\\?":\s*\\?"([A-Za-z0-9_-]{20,})/);
const provisionedId = idMatch?.[1] ?? null;
if (gapCalls.length === 0) {
  record(
    '(b) provisioned id stored in default_inputs (flow state)',
    provisionedId !== null && defaultValues.includes(provisionedId),
    `provisionedId=${provisionedId}; default_inputs=${JSON.stringify(defaults)}`
  );
} else {
  const thread = await json(`${SIDECAR_URL}/build/${flowId}/thread`);
  record(
    '(b) credential-gap: deferred setup script persisted',
    thread.deferredSetup !== null,
    `deferredSetup=${JSON.stringify(thread.deferredSetup)}`
  );
}

// ---------------------------------------------------------------------------
// (c) validate clean + zero in-flow resource creation
const code = flow.code ?? '';
const validation = await json(`${API_URL}/bubble-flow/validate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, options: { includeDetails: true, strictMode: true } }),
});
const forbidden = ['create_spreadsheet', 'create_folder', 'ensure'];
const inFlowCreation = forbidden.filter((token) => code.includes(token));
record(
  '(c) validate clean + zero in-flow resource creation',
  validation.valid === true &&
    (validation.lintErrors ?? []).length === 0 &&
    inFlowCreation.length === 0 &&
    code.length > 0,
  `valid=${validation.valid} errors=${JSON.stringify(validation.errors ?? [])} lintErrors=${JSON.stringify(validation.lintErrors ?? [])} forbiddenTokensInCode=${JSON.stringify(inFlowCreation)} codeLength=${code.length}`
);

// ---------------------------------------------------------------------------
// (d) thread persisted + resume continues it
const threadRow = await pool.query(
  `select flow_id, session_id, agent_kind, status from build_threads where flow_id = $1`,
  [flowId]
);
const entryCount = entryRows.rows.length;
console.log('\n3. Resuming the session with a follow-up question...');
const resumeRes = await fetch(`${API_URL}/build/${flowId}/resume`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message:
      'One-line answer: what trigger schedule does the flow use, and which inputs does it read?',
  }),
});
if (!resumeRes.ok || !resumeRes.body) {
  fail('resume stream', `HTTP ${resumeRes.status}`);
}
const resumeFrames = await consumeSse(resumeRes);
const resumeDone = resumeFrames.find((f) => f.event === 'done');
const resumeResult = resumeFrames.find((f) => f.event === 'result');
record(
  '(d) thread persisted to Postgres and resume continues it',
  threadRow.rows.length === 1 &&
    threadRow.rows[0].session_id === sessionId &&
    entryCount > 0 &&
    resumeDone !== undefined &&
    resumeResult !== undefined &&
    resumeResult.data.is_error === false &&
    resumeDone.data.sessionId === sessionId,
  `build_threads row=${JSON.stringify(threadRow.rows[0] ?? null)}; session_entries=${entryCount}; resume result="${String(resumeResult?.data?.result ?? '').slice(0, 200)}"; resume session=${resumeDone?.data?.sessionId}`
);

await pool.end();

console.log('\n================ SUMMARY ================');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`flowId=${flowId} sessionId=${sessionId}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
