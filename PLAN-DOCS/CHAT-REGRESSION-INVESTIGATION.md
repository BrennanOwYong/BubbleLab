# Chat regression investigation

Branch: `phase4-builder-harness`. Read-only git-history investigation, no source files touched.

## Queuing regression

### Finding: no true message queue has ever existed in this codebase

`git log --all -i -S'queue'` across `apps/bubble-studio/src/hooks`, `apps/bubble-studio/src/components/ai`, `apps/bubble-studio/src/stores` returns exactly one hit (`5972097`), and that hit is an unrelated code comment ("Query invalidation already queued") in `syncEditorFromServer`. No commit at any point introduced a message-queue array, a "send after current turn" buffer, or any mechanism that held a typed message and auto-sent it once the agent freed up. The user's recollection of "queuing" does not correspond to any implementation that ever existed.

### What did exist, and what actually changed: `isPending` semantics

The chat input has been gated by `pearl.isPending || isGenerating` continuously since at least commit `8ac1c67` (2026-02-16, `refactor: replace morph edit tool w/ native edit (#311)`, the last pre-pivot state of `PearlChat.tsx`) — same condition, same intent, all the way through today's `PearlChat.tsx:973`. That part never regressed.

What changed is **what `pearl.isPending` measures**:

- **Pre-harness (through `8ac1c67`)**: `apps/bubble-studio/src/hooks/usePearlStream.ts` used `useMutation({ mutationKey: ['pearlStream', flowId] })`, and `usePearlChatStore.ts` computed `const isPending = isMutating > 0`. The mutation's `mutationFn` itself ran `for await (const event of sseToAsyncIterable(response))`, i.e. it did not resolve until the entire SSE turn finished — so `isPending` was already true for the full duration of a turn, not just network round-trip. Mechanically this is the same "blocked for the whole turn" behavior as today.

- **Commit `cc056db`** (2026-07-30, "Studio: reset flow-page editor pane to effba78^ Pearl UI, backed by the Claude harness") rewrote `usePearlStream.ts` from scratch as a plain async function (`sendBuildMessage`) wired to the harness sidecar, replacing the old `useMutation`. `usePearlChatStore.ts` was updated to match, with the comment (verbatim, still in the file today):

  ```
  // An in-flight harness turn is the pending state (the old Pearl mutation
  // and the generation stream are the same thing now).
  const isPending = isGenerating;
  ```

  `isGenerating` is a `pearlChatStore` boolean flag, set `true` at the start of `sendBuildMessage` (`usePearlStream.ts:85`) and reset in the `finally` block (`usePearlStream.ts:286`, `s().setIsGenerating(false)`).

So structurally, both the pre-harness and harness versions block the input for the full turn — no regression in that specific mechanic. The severe regression is the one already identified and fixed today: prior to today's one-line fix, that `finally` block did not call `setIsGenerating(false)`, so `isGenerating` (and therefore `isPending`) latched `true` permanently after the _first_ turn ever ran in a session, disabling the input forever rather than just for the duration of each turn. That is almost certainly what the user is describing as "now i cant even enter text into the input" — not a removed queue, but a stuck-true flag turning a transient, expected disable into a permanent one. That bug is already fixed in the working tree (`usePearlStream.ts:286`, uncommitted at time of writing) and is out of scope per the brief.

### Secondary, still-live issue: sends during an active stream are silently dropped, not queued

`usePearlStream.ts:78-81`:

```ts
if (s().hasActiveGenerationStream()) {
  console.log(`[sendBuildMessage] Stream already active for flow ${flowId}`);
  return;
}
```

If `sendBuildMessage` is ever invoked while a stream is active (e.g. a race between a keyboard-driven submit and the disabled-state re-render, or a future caller that doesn't gate on `isPending`), the message is dropped with only a `console.log` — no user-visible feedback, no queuing, no retry. This is a latent no-op trap, not what the user is asking to restore, but worth fixing alongside any queuing work.

### Recommended fix shape (not implemented)

1. Confirm today's `setIsGenerating(false)` fix resolves the "can't type at all" symptom (it should — it's the flag that was latching true).
2. If the user wants _actual_ queuing (never existed, so this is a feature request, not a regression fix): keep the input enabled while `isPending`/`isGenerating` is true, and on submit during an active stream, hold the message in a small store-level queue (`pendingQueuedMessage: string | null` on `pearlChatStore`) instead of calling `sendBuildMessage` directly; drain the queue in the `finally` block of `sendBuildMessage` once the current turn ends, ahead of `setIsGenerating(false)` resolving to idle. This also fixes the silent-drop trap above, since the queue becomes the accept path instead of `hasActiveGenerationStream` short-circuiting to a no-op.

## Streaming regression

### Finding: the current code path is intact end-to-end; no mismatch, no drop point found

Traced the full pipeline as it exists on disk right now:

1. **Sidecar emits partial messages**: `services/builder-agent/src/builder.ts:353` sets `includePartialMessages: true` on the SDK `query()` call. This flag has been present since the sidecar's very first commit, `145b41e` ("Add builder-agent Node sidecar (Claude Agent SDK flow-builder harness)") — `git log -S'includePartialMessages' -- services/builder-agent` returns only that one commit. It has never been removed.

2. **Frame mapping**: `builder.ts:97-99` (`frameFor`) maps `msg.type === 'stream_event'` to `{ event: 'stream_event', data: msg.event }` unconditionally. `msg.event` is typed as `BetaRawMessageStreamEvent` (`@anthropic-ai/claude-agent-sdk/sdk.d.ts:4152`), whose `content_block_delta` member (`@anthropic-ai/sdk/resources/beta/messages/messages.d.ts:1772-1775`) carries `type: 'content_block_delta'` and a `delta` of type `BetaTextDelta` (`type: 'text_delta'`, `text: string`) among other delta kinds. This is exactly the shape `usePearlStream.ts:141-145` checks for (`ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string'`). No shape mismatch between what the SDK/sidecar sends and what the studio listens for.

3. **Live SSE emission is unfiltered**: `services/builder-agent/src/index.ts`, `handleBuildRequest`'s `emit` closure (~line 255-261) forwards every `(event, data)` pair to `stream.writeSSE` with no filtering. The `if (event === 'stream_event') return; // token-level spam` filter at `index.ts:344` is a different code path — it's inside `runAutoUnblock`'s local `emit`, used only for the headless credential-gap auto-kick (no SSE consumer, console-log-only sink). It does not affect the interactive user-facing stream.

4. **API proxy passes the stream through untouched**: `apps/bubblelab-api/src/routes/build.ts`, `forward()` returns `new Response(upstream.body, ...)` — the sidecar's `ReadableStream` body is handed straight to the client response, no buffering, no compression middleware found in `apps/bubblelab-api/src/index.ts` or `services/builder-agent/src/index.ts`.

5. **Frontend reads and parses incrementally**: `apps/bubble-studio/src/services/buildAgentApi.ts`, `streamBuildMessage` uses `response.body.getReader()` in a loop, decoding and splitting on `\n\n` per chunk and calling `onFrame` per parsed SSE frame as it arrives — not a buffered `.text()`/`.json()` read that would wait for stream completion.

6. **Store + render**: `usePearlStream.ts:146-148` calls `s().appendToLastTokenOrAdd(ev.delta.text)` per delta; `pearlChatStore.ts:296-327` appends to (or creates) a `token` timeline entry via an immutable `set()` update. `PearlChat.tsx:697-707` renders `token` timeline entries only while `pearl.isPending` is true (correct — that's the live-streaming window), then `flushAssistantText()` promotes the accumulated token entry to a permanent `assistant` message once the turn's text segment closes.

No commit was found that removed or broke any link in this chain, and no current-state mismatch was found between sidecar emission and studio listening (`git log -S'stream_event'` / `-S'content_block_delta'` across the sidecar and studio show the handling was introduced together at `c642c9f`/`e47933c` and carried through the `cc056db` rewrite unchanged in shape).

### What this means

Given the code on disk is correctly wired, the most likely explanations for the user's observed non-streaming are **not** a git-traceable regression:

- **Stale running process**: this branch has substantial uncommitted work across `services/builder-agent/src/{builder.ts,index.ts,...}`, `apps/bubblelab-api/src/routes/build.ts`, and `apps/bubble-studio/src/hooks/usePearlStream.ts` (per `git status`). If the dev stack the user tested against was started before these edits (or before the current checkout), it would be running stale sidecar/API code regardless of what's on disk now.
- Something environment-specific not visible in git history (e.g. a reverse proxy or dev tunnel in the user's specific setup buffering the response) — outside the scope of this repo's history.

### Recommended fix shape (not implemented)

1. Restart the dev stack (`scripts/dev-stack.sh down && up`) fresh from the current working tree and re-test streaming live before assuming further code changes are needed — this investigation found nothing in the current code to fix.
2. If streaming still doesn't appear after a clean restart, the next diagnostic step is a live capture: log each `frame.event` as `streamBuildMessage`'s `onFrame` receives it (temporarily) to confirm `stream_event` frames are actually reaching the browser in real time, vs. arriving all at once at stream end — this would distinguish a network/proxy buffering issue (frames arrive late but formatted correctly) from a genuine emission gap (frames never sent), neither of which this static trace can fully rule out without a live run.
