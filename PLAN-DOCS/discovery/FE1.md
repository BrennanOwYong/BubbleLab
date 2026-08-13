# FE1 — Credential-gap auto-run: design brief

Status: discovery/design only, no source modified. Backlog row: FE1 (Phase 3,
`depends-on S1`). Contract: `DISPATCH-CONTRACT.md` (all six pillars apply).

## Problem

`report_missing_credential` already persists the deferred setup script on the
build thread and marks it `blocked_on_credential`
(`services/builder-agent/src/tools.ts:129-196`). Resolution logic already
exists: `tryResolveDeferredSetup`
(`services/builder-agent/src/deferred.ts:96-219`) checks the credential,
runs the script (`provision_spreadsheet` / `seed_rows`, `$storeAs` chaining),
persists produced ids into the flow's `default_inputs`, annotates
`deferred_setup` with `resolvedAt + results`, and flips status to `building`.

The gap: that resolver runs only at the start of the NEXT build turn
(`services/builder-agent/src/builder.ts:132-150`), i.e. only when the user
sends another chat message. Adding the credential does nothing by itself. The
user connects Google, then stares at a still-blocked build until they think to
type something. FE1 wires the trigger: credential added, deferred setup runs,
build unblocks and finishes its self-test, no user message required.

## Approach

Server-push trigger, API to sidecar, reusing the existing turn machinery
end to end. Three moving parts:

1. **API notifies on credential write.** Every site that creates (or
   scope-extends) a credential fires a fire-and-forget
   `POST ${BUILDER_AGENT_URL}/internal/credentials-changed` with
   `{userId, credentialType}`. Sites: `POST /credentials` insert
   (`apps/bubblelab-api/src/routes/credentials.ts:231`), OAuth connect insert
   (`apps/bubblelab-api/src/services/oauth-service.ts:926`,
   `storeOAuthToken`), and the OAuth re-consent path that widens scopes on an
   existing row (`oauth-service.ts` ~880, after
   `syncDerivedCredentialsById`). Re-consent matters because a Google Sheets
   gap can be closed by adding the sheets scope to an existing Google
   credential, not only by a new row (`credentialAvailable` +
   `pickSheetsCredential` already encode this suite semantics,
   `deferred.ts:54-60`).

2. **Sidecar endpoint scans blocked threads and kicks them.** New
   `POST /internal/credentials-changed` in
   `services/builder-agent/src/index.ts`: query `build_threads` where
   `status = 'blocked_on_credential'`, respond `202 {kicked: [...]}`
   immediately, then for each thread run a headless auto-unblock turn in the
   background (`void (async ...)`), honoring the existing `activeBuilds`
   mutex (`index.ts:48`) so a kick never races a live user turn. No
   credential-type pre-filtering in the endpoint: `tryResolveDeferredSetup`
   is the single authority on whether the gap is satisfied (it owns the
   suite-credential matching); duplicating that matching in the trigger is
   how the two drift.

3. **`runBuildTurn` gains an auto-unblock mode.** New option
   `autoUnblockOnly: true` on `runBuildTurn`
   (`services/builder-agent/src/builder.ts:121`): behave exactly as today
   through the `tryResolveDeferredSetup` attempt, but if the resolution comes
   back `resolved: false`, return `{status: 'blocked_on_credential'}` WITHOUT
   invoking the agent SDK `query()`. This is the cost guard: an unrelated
   credential add must not burn an agent turn on every blocked thread. When
   resolution succeeds, the turn proceeds as a normal resume with the
   existing `[Automatic setup notice]` prompt (`builder.ts:146-148`) plus the
   default resume message (`Continue where you left off.`), so the resumed
   agent reuses produced ids, re-validates, and runs the `test_run_flow`
   self-test to completion, which is what "unblocks the build" means.

The headless turn needs an emit sink because there is no SSE consumer: a
logging emit (console + optional in-memory ring, mirroring the telemetry
sink pattern) is enough. Durability is already handled elsewhere: the
transcript persists through the Postgres `SessionStore` regardless of emit,
and `build_threads` status/`deferred_setup` writes are the observable state.
The studio needs no change: `useBuildThreadStatus` polls the thread every 10s
(`apps/bubble-studio/src/hooks/usePearlStream.ts:356-379`) and the thread
rehydration hooks pull the new transcript, so the unblock surfaces on the
open flow page within one poll cycle.

Fallback preserved: the turn-start resolution in `builder.ts` stays exactly
as is. If the sidecar is down when the credential lands, or the notify is
lost, the next user message still resolves the gap. The trigger is an
accelerator on top of an already-correct state machine, never a replacement.

## Files to create / modify

| File                                                      | Change                                                                                                                                       | Why                                                                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/builder-agent/src/index.ts`                     | Add `POST /internal/credentials-changed`; headless runner with logging emit                                                                  | The trigger's receiving end; owns the blocked-thread scan and background kicks                                                                                                                  |
| `services/builder-agent/src/builder.ts`                   | `runBuildTurn` option `autoUnblockOnly`                                                                                                      | Skip the SDK `query()` when resolution fails; reuse the whole existing resume path when it succeeds                                                                                             |
| `services/builder-agent/src/deferred.ts`                  | Annotate resolution provenance (`resolvedBy: 'credential-added' \| 'turn-start'`) and persist `lastAttempt: {at, reason}` on failed attempts | Auditability + the event test asserts the AUTO path fired, not a coincidental user turn; failed attempts (e.g. scopes still missing) become visible on the thread endpoint instead of vanishing |
| `services/builder-agent/src/tools.ts` (or `db.ts`)        | `listBlockedThreads()` helper next to `getBuildThread` (`tools.ts:676`)                                                                      | The scan query; keep drizzle access in the existing db seam                                                                                                                                     |
| `apps/bubblelab-api/src/services/builder-notify.ts` (new) | `notifyBuilderCredentialsChanged(userId, credentialType)`: fetch with `.catch()`, never awaited by the caller's response path                | One fire-and-forget helper; an unhandled fetch rejection crashes Bun (the ipify lesson, `bubblelab-api-ipify-crash`)                                                                            |
| `apps/bubblelab-api/src/routes/credentials.ts`            | Call notify after the insert at :231                                                                                                         | API-key credential adds                                                                                                                                                                         |
| `apps/bubblelab-api/src/services/oauth-service.ts`        | Call notify after `storeOAuthToken` insert (:926) and after the re-consent update (~:880)                                                    | OAuth connects and scope-widening re-consents both close gaps                                                                                                                                   |
| `scripts/event-test/fe1-credential-gap-autorun.mjs` (new) | Thin script on the F0.1 harness                                                                                                              | The Pillar 2 acceptance gate                                                                                                                                                                    |

Not modified: studio. `CredentialRequestWidget` (U-1, local) already
invalidates `['credentials']` after the popup closes; the OAuth callback
lands in the API, which is exactly where the notify fires, so the widget
path is covered server-side. Optional polish (not FE1 scope): also
invalidate `['build-thread-status', flowId]` in the widget so the unblock
shows inside 1s instead of the 10s poll.

## Data model / state

No schema migration. `build_threads` already carries everything
(`deferred_setup` is jsonb, `services/builder-agent/src/db.ts:37`). Additions
are jsonb-internal:

- On success (existing `resolvedAt`, `results`): add
  `resolvedBy: 'credential-added' | 'turn-start'`.
- On failed attempt: add/overwrite `lastAttempt: {at, reason}` while leaving
  the original script and blocked status untact per the sticky-blocked
  invariant (deferred.ts header comment, lines 4-14). The invariant is
  unchanged: only `tryResolveDeferredSetup` transitions a thread out of
  blocked; the new endpoint only decides WHEN to attempt, never the outcome.

State machine after FE1: `blocked_on_credential` exits via the same single
resolver, now reachable from two triggers (turn start, credential add). The
`activeBuilds` mutex serializes them.

## User-facing clarifying question

When the user is sitting in the flow chat and clicks Connect, should the
auto-resumed build stream into the visible chat live (a studio-triggered
`/build/:flowId/resume` after the popup closes, replacing the headless kick
for that one case), or is catching up via the 10s thread poll acceptable?
Default taken by this design: headless + poll catch-up, because it is one
mechanism for every entry point (widget, Settings page, OAuth completing
after the user navigated away) and the durable-build principle says the
build is a background process the user may leave. A visible-stream fast path
can layer on later without touching the trigger.

## Event-based acceptance test (Pillar 2)

`scripts/event-test/fe1-credential-gap-autorun.mjs`, exit-coded, asserts on
logged events and persisted records only:

1. **Arrange the gap.** Delete any credential of the chosen type (use an
   API-key type addable via `POST /credentials`, e.g. `FIRECRAWL_API_KEY`,
   so the test needs no OAuth dance; the deferred script will be EMPTY,
   which the resolver treats as resolve-on-availability, `deferred.ts:7`).
   Drive a real build: `POST /build/:flowId/message` with a prompt requiring
   that credential.
2. **Assert blocked.** `GET /build/:flowId/thread` shows
   `status: 'blocked_on_credential'`, `deferredSetup.credentialType` equals
   the type, and the transcript contains a
   `tool_use{name: 'report_missing_credential'}` block.
3. **Act: add the credential.** `POST /credentials` with the named type. No
   chat message is sent from here on; that is the point of the test.
4. **Assert auto-run, by polling the logged artifacts (timeout 5 min):**
   - `GET /build/:flowId/thread`: `deferredSetup.resolvedAt` set AND
     `deferredSetup.resolvedBy === 'credential-added'` (proves the trigger,
     not a user turn, resolved it); status has left
     `blocked_on_credential` and settles at `ready`.
   - Transcript contains the `[Automatic setup notice]` user message and a
     subsequent `tool_use{name: 'test_run_flow'}`.
   - `GET /bubble-flow/:flowId/executions?limit=5`: a new execution exists
     with a persisted result (the accept line's "execution event appears").
5. **Negative control.** Re-arrange a blocked thread, add a credential of a
   DIFFERENT type, assert after a grace period that the thread is still
   `blocked_on_credential`, `deferredSetup.lastAttempt.reason` names the
   still-missing type, and no new execution appeared (proves the cost guard:
   no agent turn was burned).

A second scenario (Google Sheets gap with a real
`provision_spreadsheet` step) exercises the script-execution branch and the
suite-credential matching, but requires a live Google OAuth credential; run
it as a manual/gated variant, keep scenario 1 as the CI gate.

`[USER-TEST]` card (Pillar 1, taste only): connect the missing credential
from the in-chat widget, watch the flow page for the next ~15s. Judging:
does the unblock feel automatic or dead, is the automatic-setup chat catchup
comprehensible to a non-technical user (F0.5 lens: no jargon leakage from
the notice text), is the 10s poll delay tolerable.

## Dependency surface (Pillar 5 map)

Importers of touched modules, from grep:

- `builder.ts` (`runBuildTurn`): imported only by `index.ts`. Option added,
  no signature break.
- `deferred.ts` (`tryResolveDeferredSetup`): imported only by `builder.ts`.
  Return shape gains fields, existing fields untouched.
- `tools.ts` (`getBuildThread`): imported by `index.ts`, `builder.ts`.
  Additive helper only.
- `credentials.ts` / `oauth-service.ts`: additive fire-and-forget call, no
  signature changes, no callers affected.
- `GET /build/:id/thread` consumers (studio `usePearlStream` hooks, the U-1
  widget path): response gains optional jsonb fields inside `deferredSetup`;
  the studio treats `deferredSetup` as opaque today (`index.ts:135` passes it
  through), so no break.
- `BUILDER_AGENT_URL` is currently re-declared in three API route files
  (`build.ts:21`, `build-page.ts:18`, `pages.ts:23`); the notify helper adds
  a fourth. Centralizing is a candidate cleanup for the PR, not required.

## Risks

- **Bun crash on notify failure.** An unawaited fetch whose rejection is
  unhandled kills the Bun API process (observed with ipify,
  `apps/bubblelab-api/src/index.ts` ~137 history). The helper MUST attach
  `.catch()` at creation. This is the highest-severity risk and the reason
  the notify lives in one audited helper.
- **409 race with a live user turn.** The headless kick and a user chat
  message contend on `activeBuilds`; whichever loses gets a 409. For the
  kick that is a silent skip (the user's own turn will resolve the gap at
  turn start anyway). For the user it is the existing "already running"
  error, pre-existing behavior, now marginally more likely. Acceptable;
  noted for U-series polish.
- **Multi-user scoping.** `build_threads` has no user column and the
  sidecar's `GluuClient` sends no auth (viable only under `DISABLE_AUTH`,
  single-user dev). The scan is global; in a multi-user deployment a user A
  credential add would attempt resolution against user A's credential list
  for user B's threads (and fail closed, staying blocked, so no data leak,
  but wasted attempts). This is a pre-existing property of the whole
  sidecar, not introduced by FE1; the notify payload carries `userId` now so
  the filter can be added when the sidecar grows auth (S7/S8 family).
- **Sidecar down at credential-add time.** Notify lost; thread stays blocked
  until the next user message (existing behavior). Accepted; an optional
  boot-time sweep of blocked threads would close it and can ride a later
  row.
- **Unknown deferred actions.** The resolver hard-stops on any action other
  than `provision_spreadsheet` / `seed_rows` (`deferred.ts:148-155`); the
  trigger inherits that and stays blocked with a persisted `lastAttempt`
  reason. Correct behavior, but worth asserting in the test's negative
  control family as the action vocabulary grows.
- **S1 dependency.** The backlog gates FE1 on S1. The trigger mechanism is
  orthogonal to S1 (it exercises direct-credential gaps and empty scripts),
  so FE1 can build and test against a direct credential type before S1
  lands; nested-tool gaps start flowing through it once S1 fixes detection.
  Surface this sequencing choice at dispatch rather than silently reordering.

## Sources

- `services/builder-agent/src/tools.ts:124-196` (report_missing_credential persistence)
- `services/builder-agent/src/deferred.ts` (resolver + sticky-blocked invariant)
- `services/builder-agent/src/builder.ts:132-153, 199-216` (turn-start resolution, sticky status)
- `services/builder-agent/src/index.ts:47-49, 145-235` (activeBuilds mutex, SSE build routes)
- `apps/bubblelab-api/src/routes/credentials.ts:197-248` (create route insert)
- `apps/bubblelab-api/src/services/oauth-service.ts:~860-947` (re-consent + storeOAuthToken)
- `apps/bubblelab-api/src/routes/build.ts:1-66` (API-to-sidecar proxy, BUILDER_AGENT_URL)
- `apps/bubble-studio/src/hooks/usePearlStream.ts:348-380` (useBuildThreadStatus 10s poll)
- `apps/bubble-studio/src/components/ai/CredentialRequestWidget.tsx`, `src/lib/connectCredential.ts` (U-1 connect path)
- Memory: `bubblelab-api-ipify-crash` (unhandled fetch rejection crashes Bun), `durable-build-persistence-model` (build = background process)
