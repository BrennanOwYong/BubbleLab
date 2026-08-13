/**
 * Headless-studio helpers for UX event tests (Pillar 2).
 *
 * The browser is used ONLY to drive the real studio (open the flow page,
 * click, drag, kick the real store/hook modules via Vite dev's on-the-fly
 * module serving: `import('/src/...')` in page context returns the SAME
 * module instances the app runs). Assertions read logged events
 * (GET /telemetry, GET /build/:id/thread, execute-stream) wherever one
 * exists; the two features without an event yet (U-3 node positions, U-4
 * rendered edge labels) read structured page state through the sanctioned
 * lib/browser.mjs bridge and are flagged in their test headers.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a browser session against the stack's studio; a missing/down studio
 * is an infra problem (exit 3, F0.2 refuse semantics), never a red.
 */
export function studioBrowser(t, session) {
  if (!t.stack.studio || t.stack.studioUp === false) {
    console.error('STACK UNAVAILABLE  studio url unresolved or not serving — run scripts/dev-stack.sh up');
    console.log(
      JSON.stringify({
        test: session,
        pass: false,
        exitCode: 3,
        stackUnavailable: true,
        error: 'studio not available',
        assertions: [],
      })
    );
    process.exit(3);
  }
  const b = t.browser(session);
  t.cleanup(() => b.close());
  return b;
}

/** Open the flow canvas page and let it settle (queries + first paint). */
export async function openFlowPage(b, t, flowId, settleMs = 4000) {
  b.open(`${t.stack.studio}/flow/${flowId}`);
  await sleep(settleMs);
}

/** Structured read of rendered React Flow nodes: [{id, type, x, y}]. */
export function readNodes(b) {
  return (
    b.evalJs(
      `[...document.querySelectorAll('.react-flow__node')].map((n) => {
        const m = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(n.style.transform ?? '');
        return {
          id: n.getAttribute('data-id'),
          type: (n.className.match(/react-flow__node-(\\S+)/) || [])[1] ?? null,
          x: m ? Number(m[1]) : null,
          y: m ? Number(m[2]) : null,
        };
      })`
    ) ?? []
  );
}

/** Rendered edge label texts (structured read, no pixel parsing). */
export function readEdgeLabels(b) {
  return (
    b.evalJs(
      `[...document.querySelectorAll('.react-flow__edge')].map((e) => e.textContent.trim()).filter(Boolean)`
    ) ?? []
  );
}

/**
 * Kick the REAL conversation transport (usePearlStream.sendBuildMessage) in
 * the page and park completion on a window flag; poll with awaitPageFlag.
 * This exercises the production SSE-frame -> pearlChatStore translator.
 */
export function kickSendBuildMessage(b, flowId, message, key = '__eventTestTurn') {
  return b.evalJs(
    `(() => {
      window[${JSON.stringify(key)}] = { done: false, err: null };
      import('/src/hooks/usePearlStream.ts')
        .then((m) => m.sendBuildMessage(${flowId}, ${JSON.stringify(message)}))
        .then(() => { window[${JSON.stringify(key)}].done = true; })
        .catch((e) => { window[${JSON.stringify(key)}].err = String(e); });
      return true;
    })()`
  );
}

/** Poll the window flag set by kickSendBuildMessage. */
export async function awaitPageFlag(b, key, timeoutMs = 360_000, pollMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const flag = b.evalJs(`window[${JSON.stringify(key)}] ?? null`);
    if (flag && (flag.done || flag.err)) return flag;
    if (Date.now() > deadline) return flag ?? { done: false, err: 'timeout: flag never set' };
    await sleep(pollMs);
  }
}

/** Read the flow's pearlChatStore messages via the real store module. */
export function readChatMessages(b, flowId) {
  return (
    b.evalJs(
      `(async () => {
        const m = await import('/src/stores/pearlChatStore.ts');
        return m.getPearlChatStore(${flowId}).getState().messages.map((x) => ({
          type: x.type,
          credentialType: x.credentialType ?? null,
          primaryOutput: x.primaryOutput ?? null,
        }));
      })()`
    ) ?? []
  );
}

/** tool_use blocks named `name` across the build-thread transcript. */
export function threadToolUses(thread, name) {
  const uses = [];
  for (const entry of thread?.transcript ?? []) {
    for (const block of entry.blocks ?? []) {
      if (block.type === 'tool_use' && block.name?.endsWith(name)) {
        uses.push(block.input ?? {});
      }
    }
  }
  return uses;
}

const SCREAMING_SNAKE = /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/;

/** F0.5 leakage predicate: machine constant / cred type used as a label. */
export function isLeakedLabel(value) {
  if (typeof value !== 'string') return false;
  return /_CRED$/.test(value) || SCREAMING_SNAKE.test(value);
}
