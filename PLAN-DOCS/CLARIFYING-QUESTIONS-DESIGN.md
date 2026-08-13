# Clarifying-questions & setup-phase discovery — design spec

Status: BUILT, VERIFIED LIVE. Replaces free-text "ask a question" behavior on
the flow-building agent (`services/builder-agent`, agentKind `flow`).
Written 2026-08-06 after the feature was built and tested; this is the
reference for the rules going forward, not a proposal.

**2026-08-06 update:** rule 2 below originally described a two-layer
trailing-text SUPPRESSION mechanism (live-stream + rehydration). The user
rejected that approach outright ("that still makes it not render text...
the code for it must not exist") and it was fully removed. Rule 2 now
describes what replaced it: a genuine generation-level hard stop via a
`PostToolUse` SDK hook, verified to produce zero trailing text anywhere —
not a rendering choice, an actual halt. See "Native `AskUserQuestion`:
investigated and ruled out" below for why the SDK's own built-in
human-in-the-loop tool couldn't be used instead, and BACKLOG.md F0.8/F0.8b
for the full investigation trail.

## What this replaces, and why the shape is what it is

The flow-building agent used to ask the user something by writing a normal
chat message — indistinguishable from any other reply, no dedicated way to
answer it, and (before today's separate F0.7 fix) often paired with a false
"Code generation complete!" banner on the same turn. There was no commit,
ever, where this worked better on this architecture — verified by exhaustive
git history search (see investigation log below). Two prior systems were
considered and rejected as direct models:

- **Coffee (deleted 2026-07-29, `ee4a177`/`d8c710a`)** guaranteed no trailing
  text by _not being a tool call at all_ — its entire turn was one
  single-shot JSON object (`{action: 'askClarification', questions: [...]}`)
  with no schema field for free text. That guarantee doesn't transfer to an
  agentic-loop architecture; there's no equivalent hard constraint available.
- **Claude Agent SDK's native `AskUserQuestion` tool** is real (confirmed in
  the installed SDK's own type definitions) but was never wired in —
  `allowedTools: ['mcp__builder__*']` has gated the harness since its first
  commit (`145b41e`) and has never been changed since, so a bare-named
  built-in tool could never have been called. More fundamentally,
  `AskUserQuestion` is built for a synchronous, in-process pause-and-wait
  interaction (like this CLI session) — this harness's turns are stateless
  HTTP requests, and the human's answer can arrive as a wholly separate
  request an arbitrary amount of time later. Bridging that gap is a real,
  unverified undertaking, not a config flip, so a purpose-built async tool
  was the correct call rather than force-fitting the native one.

The design below is a **custom MCP tool with the same guarantee Coffee had
(no trailing text), enforced by code at the layers this architecture actually
has**, not by asking the model nicely (prompt-only instructions were tried
first and failed on the first live test — the model reworded the sentence
instead of omitting it).

## The tool

`ask_clarifying_questions` — `services/builder-agent/src/tools.ts`, flow
agentKind only.

```
questions: Array<{
  id: string
  question: string
  choices: Array<{ id: string; label: string; description?: string }>  // may be EMPTY
  context?: string
  allowMultiple?: boolean
}>  // min 1
```

`choices` empty is correct and expected for a purely open-ended question
("what's the spreadsheet URL?") — the rendered widget always also offers a
free-text "Other" option regardless of how many real choices are listed.

## Rules (enforced, not requested)

1. **One call per turn, every open question together** — not one question
   per call. SOP instruction (`prompts.ts`, "Asking the user something").
2. **Zero text after the tool call, in the same turn — enforced as a hard
   generation stop, not a rendering filter.** `builder.ts`'s `query()` call
   registers a `PostToolUse` hook (`ASK_CLARIFYING_QUESTIONS_HOOKS`) matched
   on `mcp__builder__ask_clarifying_questions` that returns
   `{continue:false, stopReason:...}` — the SDK's own documented mechanism
   (`SyncHookJSONOutput.continue`) for ending a turn the instant a specific
   tool fires, before the model is invoked again. The model is never asked
   to continue, so no trailing text is ever generated — not hidden, not
   filtered, never produced. This replaced an earlier two-layer
   SUPPRESSION approach (live-stream flag + rehydration flag) that the user
   rejected: it only stopped _rendering_ text the model still generated
   server-side, burning compute for output nobody would ever see — exactly
   the failure mode "the code for it must not exist" was about. The hook
   approach has no equivalent failure mode: there is nothing generated to
   hide, because generation itself stops.
   - Root cause of the original trailing text: the tool's handler returned
     `{status:'asked', questionCount}` as the tool_result _immediately_ on
     call — a normal successful result, so the model naturally kept talking
     in the same turn, believing the interaction was progressing.
   - Verified live (flow 275): the assistant message containing the
     tool_use is followed immediately by `event: result` with zero further
     assistant content, live-stream AND on the durable rehydrated transcript
     (`/build/:id/thread`) — confirming the stop happened before generation,
     not after.
   - Leading text (before the tool_use, in the same message) is a separate,
     smaller concern the hook doesn't touch — still governed by the SOP
     prompt instruction only (`prompts.ts`, "Asking the user something").
3. **Never call `save_flow` in the same turn** as `ask_clarifying_questions`.
4. **Populate `choices` with real candidates when they exist** (from setup-
   phase discovery, see below); leave empty only when genuinely open-ended.
5. **Backend status guarantee**: the tool writes
   `build_threads.status = 'blocked_on_clarification'` synchronously, mid-
   turn (same `insert...onConflictDoUpdate` pattern as
   `report_missing_credential`'s `blocked_on_credential`). `builder.ts`'s
   `persistFinalStatus` checks a `STICKY_STATUSES` set before accepting the
   SDK's own end-of-turn status, so the SDK reporting "no error" can never
   silently overwrite a tool's mid-turn "actually, I'm blocked" write.
6. **Frontend completion gate**: `generation_complete` (the "Code generation
   complete!" banner) and `onGenerationComplete` (completion sound +
   `success:true` analytics) now both require `sawSaveFlow`, not just
   `finalStatus === 'ready'`. This closes the false-done signal for _any_
   turn that ends without saving code, not just the clarifying-question case
   specifically — a turn that ends on unstructured prose with zero tool
   calls (should not happen per rule 1, but if the model ever ignores the
   SOP) is also covered by this gate.

## Setup-phase discovery before asking (FE6)

When the user names a resource by description ("my farm temperature
spreadsheet") rather than a link/ID, the agent must try to find it itself
before asking:

- `find_drive_file` (`tools.ts` + `provision.ts`) — a real
  `GoogleDriveBubble({operation:'list_files', query}).action()` call, run
  through the SAME already-authenticated execution path
  (`client.runContextFlow`) `provision_spreadsheet` uses. Not a bespoke
  search API — the user's real, already-connected credential, the same
  bubble class a saved flow would use.
- One strong match: use it directly, state which file was picked in one
  sentence, move on — no question needed.
- Multiple plausible matches, or zero: call `ask_clarifying_questions`, with
  any real candidates found as choices (label = file name, description =
  last-modified date), never guessing among ambiguous matches.
- Credential resolution: `pickDriveCredential` mirrors
  `pickSheetsCredential`'s exact recency rule (exact `GOOGLE_DRIVE_CRED`
  first, else the most recent Google OAuth grant whose scopes cover
  `drive.readonly`).

## Consumption side (pre-existing, now finally fed real data)

`ClarificationWidget`, the `pendingClarification` derivation
(`getPendingClarificationRequest`), and the `submitClarificationAnswers`
round-trip (`hooks/usePearlChatStore.ts`) were already fully implemented —
this was confirmed by reading the code, not assumed. They were dead paths
only because nothing on the harness ever produced a `clarification_request`
message before this tool existed. No new frontend state was needed; only the
frame-handler branch that recognizes the tool's `tool_use` block and turns it
into that message type (validated against `ClarificationQuestionSchema`, zod,
no `as any`).

## Verified live (real browser, not just API)

- Flow 255: 3 questions rendered (2 with real choices, 1 open-ended with only
  "Other"), Continue correctly gated until all answered, multi-round
  confirmed (agent asked a clean follow-up after a non-answer), input
  correctly disabled mid-turn / re-enabled after, no false completion
  banner, `build_threads.status` stayed `blocked_on_clarification`
  throughout.
- Flow 272/273: trailing-text suppression confirmed on the live stream (this
  was the now-removed suppression mechanism; superseded, see below).
- Flow 274: `find_drive_file` called twice with different queries before
  falling back to `ask_clarifying_questions` with well-reasoned choices
  ("create a new spreadsheet" vs "I'll provide the link"); rehydration
  suppression bug found (tool_result-as-role-user false-reset) and fixed;
  re-verified clean on both the raw `/thread` API response and a fresh
  browser tab after the fix. (Also superseded — the whole suppression layer
  this bug lived in is gone.)
- **Flow 275 (2026-08-06, hard-stop hook, current mechanism):** direct SSE
  capture of `POST /build/275/message` — the `ask_clarifying_questions`
  tool_use is the sole content block in its assistant message, immediately
  followed by `tool_result` (`is_error:false`) then `event: result`
  (`num_turns:5`, empty result string) — no further assistant message of any
  kind. `GET /build/275/thread` (durable Postgres session store, not the
  live stream) independently confirms the same: the tool_use/tool_result
  pair is the transcript's last entry. `POST /build/275/resume` with typed
  answers re-verified the round-trip: same `session_id`, agent correctly
  called `find_drive_file` (FE6) per the answer, then hard-stopped again on
  a clean follow-up question when still short on detail — multi-round
  proven under the new mechanism.

## Native `AskUserQuestion`: investigated and ruled out (2026-08-06)

The user's first preference was the Claude Agent SDK's own built-in
human-in-the-loop tool (`AskUserQuestionInput`/`Output`, real types in
`sdk-tools.d.ts`, functionally identical to the tool this Claude Code
session itself has) rather than a custom MCP tool. Investigated directly
against the installed package, not assumed:

- **Zero references anywhere in the SDK's bundled runtime**
  (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`) — the type exists,
  but nothing in the JS the `query()` caller actually runs implements or
  dispatches it.
- **Why:** `query()` spawns a separate process — "the built-in [Claude Code]
  executable" (`pathToClaudeCodeExecutable` in `sdk.d.ts`) — and _that_
  binary, not `sdk.mjs`, owns all client-side tool execution (Bash, Read,
  Edit, `AskUserQuestion`, `TodoWrite` rendering, etc.) internally via its
  own interactive-terminal loop. There is no hook, callback, or
  `control_request` type exposed to a headless `query()` embedder (this
  Hono server, not a terminal) to supply an answer to it.
- **`canUseTool`/`PermissionResult` is not a substitute.** It is a
  pre-execution allow/deny/modify-input gate (checked _before_ a tool runs)
  — it has no field for supplying a tool's execution _result_, so it cannot
  stand in for answering a question the tool itself would otherwise render
  and collect.
- **Conclusion:** using it for real would require exactly the interactive/
  streaming-input session architecture the user scoped out as **F0.8b**
  (KIV) — a persistent process per open conversation, not the current
  stateless-HTTP-per-turn model. Not a smaller lift than the `PostToolUse`
  hook; a larger one, for a capability (skills, subagent dispatch, "company
  brain") not needed for this requirement. The `PostToolUse` hook achieves
  the actual requirement — the LLM's state freezes until answered — without
  it.

## Known limitations (explicit, not silent)

- `find_drive_file` covers Google Drive only. Other providers a resource
  might live in (Notion pages, Slack files, etc.) have no equivalent
  discovery tool yet — would need the same pattern per provider if needed.
- Only wired on the flow agent (`createBuilderServer`). The page agent
  already had `list_integrations`/`read_sheet_range` (commit `787d082`) but
  does not have `ask_clarifying_questions` or `find_drive_file` — not in
  scope here, since the page agent's build hasn't shown the same symptom.
- The `PostToolUse` hook is scoped to `ask_clarifying_questions` only —
  `report_missing_credential` (a similarly turn-ending tool) was left
  untouched; it has never shown the same trailing-text symptom and was out
  of scope for this fix.

## References

- `git log --all -i -S"clarif"` / `-S"AskUserQuestion"` / `-S"askUser"` across
  the full repo history — zero hits, confirming no prior implementation
  existed on this architecture at any point (session investigation,
  2026-08-06).
- `git log -p -S"allowedTools" -- services/builder-agent/src/builder.ts` —
  one commit, `145b41e`, never changed since.
- `customers/SALVAGED_AGENT_SKILLS.md` (outside this git repo, Windows
  planning directory) — the actual Pearl/Rice/MilkTea salvage doc from the
  transition; confirmed it does not describe or recommend a trailing-text-
  free tool-call mechanism (Pearl's own SOP was plain prose: "missing info →
  ask").
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` — real
  `AskUserQuestionInput`/`AskUserQuestionOutput` type definitions (installed
  package, version pinned in `services/builder-agent/package.json`).
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` —
  `grep -n "AskUserQuestion"` returns zero hits, confirming its execution is
  not implemented in the SDK's own runtime.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `CanUseTool`/
  `PermissionResult` (pre-execution gate, no result-supply field),
  `pathToClaudeCodeExecutable` ("Uses the built-in executable if not
  specified" — confirms `query()` spawns a separate CLI binary),
  `SyncHookJSONOutput` (`continue?: boolean; stopReason?: string;` — the hard
  -stop mechanism actually used), `HookCallback`/`HookCallbackMatcher`
  (hook registration shape), `PostToolUseHookInput`/`HookSpecificOutput`.
