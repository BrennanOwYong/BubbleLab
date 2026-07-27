# PEARL_RESULT

## Status

DONE. Pearl chat repaired and repurposed as a plain-English error explainer.

## Branch / commit / pushed

- Branch: `feature/pearl-error-explainer` (cut from `origin/feature/mvp-oneshot` @ ebf398a)
- Commit: see `git log -1` on the branch (single commit: "fix: repair Pearl chat + repurpose as plain-English error explainer")
- Pushed: yes, `origin/feature/pearl-error-explainer`

## Root cause of the breakage (evidence)

Every Pearl request failed inside `runPearl` before the agent ran, for two stacked reasons:

1. **`undefined` credential values fail the agent's input schema.**
   `apps/bubblelab-api/src/routes/ai.ts` built the credentials record as
   `[CredentialType.ANTHROPIC_CRED]: env.ANTHROPIC_API_KEY!` (old lines 54/87).
   The deployed `.env` (both `bubblelab-live` and `bubblelab-derived`) has NO
   `ANTHROPIC_API_KEY` at all, and blank `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` /
   `FIRE_CRAWL_API_KEY`; only `OPENAI_API_KEY` is set. A key present with value
   `undefined` fails AIAgentBubble's Zod schema as "Required".
   Probe evidence (live :3001, before fix):
   `POST /ai/pearl?stream=false` → 500
   `{"error":"Input Schema validation failed: tools.0.credentials.ANTHROPIC_CRED: Required, ... credentials.ANTHROPIC_CRED: Required"}`
   Same failure repeats on all 3 retries; streaming mode returns it as a `reject`
   result, so the chat shows "Failed after 3 attempts: Input Schema validation failed…".

2. **Default model pointed at a provider with no key.**
   `PEARL_DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-4.5'`
   (`packages/bubble-shared-schemas/src/pearl.ts:7-8`), and the studio sends it
   explicitly (`usePearlChatStore.ts:663`). Even after fixing (1), OpenRouter has a
   blank key so the call would fail at the provider. The working generation path
   (Coffee) uses `openai/gpt-5.2`.

Secondary bug found while tracing: the streaming route's catch wrote the SSE error
as `{type:'error', error, recoverable}` but the frontend reads `event.data.error`
(`usePearlStream.ts:88`), so real errors surfaced as "No final result received from
stream".

## The fix

- `apps/bubblelab-api/src/routes/ai.ts`: new typed `systemAICredentials()` helper
  includes only env keys that are set and non-blank; used by the milktea route and
  both Pearl paths (stream + non-stream). No `as any`, no `!` on possibly-unset env.
- `packages/bubble-shared-schemas/src/pearl.ts`: `PEARL_DEFAULT_MODEL` →
  `'openai/gpt-5.2'` (same model as `COFFEE_DEFAULT_MODEL`, the path that works
  live). Studio picks this up from the shared constant, no studio change needed.
- `routes/ai.ts` streaming catch: SSE error event now shaped
  `{type:'error', data:{error, recoverable:false}}` to match `StreamingEvent`.

## Error-explainer wiring

- **Backend** (`services/ai/pearl.ts` system prompt): new "ERROR EXPLAINER MODE"
  section, highest priority when the user asks about an error or errors are in
  context. Pearl must (1) explain in plain English, no jargon; (2) classify:
  "This needs an action from you" (API key / reconnect / permission / input /
  quota — with the exact step, and NO code edits) vs "I can fix this in the
  workflow" (then use editWorkflow); (3) ask one direct question if unsure.
- **Context feed already existed**: `buildAdditionalContext`
  (`usePearlChatStore.ts:130-212`) injects recent execution/console errors into
  every Pearl request, so Pearl reads the console errors without new plumbing.
- **Studio CTAs** re-pointed from auto-fix to explain-first:
  - `AllEventsView.tsx` `handleFixWithPearl` prompt now asks Pearl to explain in
    plain English and classify user-action vs workflow fix; all three banner CTAs
    relabeled "Explain with Pearl" with matching copy.
  - `EvaluationIssuePopup.tsx`: button now shows for EVERY failure (previously
    hidden for setup/input issues), passes the evaluator's `issueType` into the
    prompt, relabeled "Explain with Pearl".

## tsc result

- `pnpm --filter bubble-studio exec tsc --noEmit` → clean (no output).
- `pnpm --filter bubblelab-api exec tsc --noEmit` → clean (no output).
- `@bubblelab/shared-schemas` rebuilt (tsup success).

## Before / after

- Before (live :3001, old code): `POST /ai/pearl?stream=false` → 500
  `Input Schema validation failed: ... credentials.ANTHROPIC_CRED: Required`.
- After (patched clone on :3002): same endpoint with
  `userRequest: "My workflow failed with this error: GoogleSheetsBubble: 401 invalid_grant (token expired)..."`
  → 200, `type:"answer"`, plain-English explanation ("the Google login it was
  using is no longer valid…") + explicit "**This needs an action from you (not a
  code change)**" with reconnect steps.
- Streaming path on :3002: `?stream=true` emits `llm_start`, 9× `token`,
  `llm_complete`, `complete`, `stream_complete` — full round trip.

## What must restart to go live

- **API bounce required** (routes/ai.ts, services/ai/pearl.ts, rebuilt
  shared-schemas dist). The :3001 server must pick up this branch + a fresh
  `@bubblelab/shared-schemas` build.
- **Studio restart required** (PEARL_DEFAULT_MODEL comes through the studio
  bundle, plus CTA changes; vite on /mnt/c does not hot-reload).

## Deviations

- Extended the `systemAICredentials()` fix to the milktea route as well — same
  latent bug, same helper, zero extra surface.
- `EvaluationIssuePopup` now shows the Pearl button for setup/input failures too.
  The old behavior hid it because Pearl would have tried to code-fix a
  non-code problem; with explainer mode that inversion is the point.
- Did NOT add a separate `/ai/explain` endpoint. The existing `/ai/pearl` +
  system-prompt behavior + existing error context feed covers the brief with no
  new API surface.

## Learnings

- AIAgentBubble credentials: a key present with `undefined` value fails Zod as
  "Required" — never build credential records with `env.X!`; filter unset/blank.
- Deployed env has ONLY `OPENAI_API_KEY`; `ANTHROPIC_API_KEY` absent,
  `OPENROUTER_API_KEY`/`GOOGLE_API_KEY`/`FIRE_CRAWL_API_KEY` blank strings.
  Any default model outside `openai/*` is dead on arrival.
- Frontend `StreamingEvent` error contract is `event.data.error`; the pearl route
  emitted top-level `error` (mismatch existed since the route was written).
- Pearl already receives console/execution errors on every message via
  `buildAdditionalContext` — error-explaining needed prompt + CTA changes only.
