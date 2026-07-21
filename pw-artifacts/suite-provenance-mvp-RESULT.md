# suite-provenance-mvp — RESULT

- **Status**: complete
- **Branch**: `feature/suite-provenance-mvp` (based on `feature/suite-aware-credential-binding` @ e43fe6d)
- **Clone**: `/home/unix/bubblelab-prov`
- **Scope**: MVP presentation + one backfill over existing data. No DB redesign.

## What shipped

### Fix 1 — Google account-email backfill (API)
Existing Google OAuth credentials connected before the callback started writing
`metadata.email` (OIDC userinfo) carried `metadata = null`, so
`autoPopulate.ts` had nothing to fill `gmailAccountEmail` from.

- `OAuthService.backfillGoogleAccountEmail(userId, credentialId)`
  (`apps/bubblelab-api/src/services/oauth-service.ts`): loads the row, skips
  non-google / already-identified rows, probes the OIDC UserInfo endpoint with
  the credential's access token (5s `AbortSignal.timeout`), persists
  `{email, displayName}` into `metadata`, emits
  `setup.account_email_backfilled` (server-side `[bl:telemetry]` line,
  `apps/bubblelab-api/src/utils/telemetry.ts`).
- Seam: GET `/credentials` (`apps/bubblelab-api/src/routes/credentials.ts`) —
  the credential-load path both the setup panel and autoPopulate feed from.
  Rows lacking an email are backfilled before the response is built, so the
  FIRST list a fresh studio session makes already carries the email. Lazy +
  cached: a persisted email is the durable cache; a FAILED probe is remembered
  in-process (`googleEmailBackfillAttempts` set) so a dead route is probed once
  per credential per server run, never per request. Probe failure degrades to
  the bare row — listing never blocks, no email is ever fabricated.
- Userinfo endpoint researched against the official reference (2026-07-21):
  `https://openidconnect.googleapis.com/v1/userinfo`, bearer GET, response
  carries `email` when the email scope was granted; listed as
  `userinfo_endpoint` in the discovery document
  `https://accounts.google.com/.well-known/openid-configuration`.
  Doc: https://developers.google.com/identity/openid-connect/openid-connect
  (cited in the method's docstring).

### Fix 2 — Setup panel suite-binding provenance (studio)
`FlowSetupPanel.tsx`: a verified cross-type suite binding now renders
`via your <source-type label> credential (<email or name>)` under the entry
(e.g. Google Sheets — "via your Google Drive credential
(drive-user@example.com (Legacy Drive))"), `data-testid="suite-provenance"`.
Account identity comes from the source credential row
(`describeCredentialAccount`, OAuth email first) — real stored data only.
Emits `setup.suite_provenance_shown` (surface `setup_panel`) once per
flow/type/credential.

### Fix 3 — Credentials page suite coverage (studio)
- `computeSuiteCoverage(credential)` in
  `apps/bubble-studio/src/lib/credentialBinding.ts` (pure): for an OAuth
  credential in a multi-type provider group, compares its stored
  `oauthScopes` (probe-synced by the scope-check infra) against each sibling
  type's `getDefaultScopes` (identity scopes excluded, trailing-slash-tolerant
  normalization). Sibling covered ⇔ every default scope granted.
- `CredentialsPage.tsx` CredentialCard renders
  `Also grants: Google Sheets, Google Calendar (scopes present)`
  (`data-testid="suite-coverage"`) and emits `setup.suite_provenance_shown`
  (surface `credentials_page`) once per credential per covered-set.

## Verification

- `tsc --noEmit`: API exit 0, studio (`tsc -b`) exit 0; studio production
  build (`pnpm run build`) exit 0. Prereq dists built in order
  shared-schemas → bubble-core → bubble-runtime (+ bubble-appgen, needed by
  the API's tool-generator).
- API tests (bun, sqlite test DB, outbound Google fetch stubbed):
  - new `src/routes/credentials-email-backfill.test.ts` — 3 pass: (a) probe
    once for a metadata-null google credential, persist + serve the email,
    second list serves from storage without a re-probe (call counter = 1);
    (b) 401 probe degrades gracefully, metadata stays null, failure is not
    re-probed; (c) non-google and already-identified rows are never probed.
  - regression: credentials-scope-check, credential-creation-debug,
    bubble-flows-scope-audit — 16 pass, 0 fail; all `src/routes/` +
    credential-validator/validation/offer-helper — 76 pass, 0 fail.
- Studio unit tests (vitest): 145 pass (9 files), including 3 new
  `computeSuiteCoverage` tests (coverage/partial-coverage, trailing-slash
  tolerance, non-OAuth/empty/single-type returns []).
- ESLint on every changed file: no new errors (CredentialsPage's
  `react-refresh/only-export-components` at the
  `getServiceNameForCredentialType` export pre-exists on base e43fe6d,
  verified by linting the base file).
- Live browser smoke (`pw-artifacts/smoke-provenance.py`, Python Playwright,
  API on :3410 with `pw-artifacts/google-stub.preload.ts` stubbing ONLY the
  outbound userinfo/tokeninfo endpoints, studio on :3411, credentials seeded
  metadata=null by `apps/bubblelab-api/scripts/seed-provenance-smoke.ts`):
  7/7 checks pass —
  1. `setup.account_email_backfilled` fired for both seeded rows on first
     GET /credentials; DB rows persisted the emails.
  2. `setup.field_autopopulated` filled `gmailAccountEmail` with the
     BACKFILLED `gmail-user@example.com` (row started metadata=null).
  3. `setup.suite_binding_proposed` + `setup.scope_check_passed`
     (GOOGLE_SHEETS_CRED via GOOGLE_DRIVE_CRED).
  4. Setup panel DOM shows the provenance label with the backfilled account
     email; `setup.suite_provenance_shown` surface=setup_panel.
  5. Credentials page DOM shows "Also grants: Google Sheets, Google Calendar
     (scopes present)" on the Drive card;
     `setup.suite_provenance_shown` surface=credentials_page.
  Screenshots: `pw-artifacts/smoke-setup-panel.png`,
  `pw-artifacts/smoke-credentials-page.png`.

## Deviations

- Backfill seam: the brief suggested the scope-check path. The scope check
  only runs for suite-binding proposals, so an exact-type Gmail credential
  (fix 1's target scenario) would never pass through it. GET `/credentials`
  is the seam both consumers (autoPopulate, account dropdowns) already load
  from, keeps the lazy+cached contract, and needed no client change.
- Seed script lives at `apps/bubblelab-api/scripts/seed-provenance-smoke.ts`
  (not pw-artifacts): bun resolves workspace packages only under a package
  root.
- `setup.suite_provenance_shown` is one event with a `surface` discriminator
  (`setup_panel` | `credentials_page`) instead of two names.

## KIV (unchanged from brief)

- Relational `step_credentials` table + stored suite provenance (which
  credential served which slot and why), replacing the presentation-derived
  labels here.
- Failed-backfill retry policy is process-lifetime; a TTL or manual retry
  affordance would need the relational model anyway.

## Learnings

- `pkill -f vite` from a smoke cleanup killed the live :3000 studio
  (bubblelab-suite) — restarted from `/home/unix/bubblelab-suite/apps/bubble-studio`
  via `corepack pnpm run dev`, back to 200. Kill by exact port/pid, never by
  process-name pattern.
- Port 3210 was already taken on this box; smoke used 3410/3411.
- Spreading a union-typed drizzle JSON column (`{ ...existing, ...userInfo }`)
  type-checks against `CredentialMetadata` without casts — no `as` needed for
  the metadata merge.
- The API test harness wipes `user_credentials` per test (`beforeEach` in
  src/test/setup.ts), but the oauthService singleton's in-process attempt set
  survives across tests; sqlite id reuse could collide. Safe today because no
  other test file calls GET /credentials.
