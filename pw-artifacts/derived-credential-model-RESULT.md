# derived-credential-model — RESULT

Branch `feature/derived-credential-model`, based on `feature/suite-provenance-mvp` @ f333bab.
Clone `/home/unix/bubblelab-derived`. Fast-forwards onto f333bab by construction (branched from it, no merge commits).

## Part 1 — persisted derived-credential relationship

### Schema / migration

New table `derived_credentials` (both dialects):

| column                                                | type                                            | notes                                             |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| id                                                    | pk autoincrement / serial                       |                                                   |
| parent_credential_id                                  | int, FK → user_credentials.id ON DELETE CASCADE | the credential whose grant covers the type        |
| user_id                                               | text, FK → users.clerk_id ON DELETE CASCADE     | query + ownership                                 |
| derived_credential_type                               | text                                            | e.g. GOOGLE_SHEETS_CRED                           |
| provider                                              | text                                            | e.g. google                                       |
| is_derived                                            | boolean NOT NULL default true                   |                                                   |
| created_at / updated_at                               | timestamps                                      |                                                   |
| UNIQUE(parent_credential_id, derived_credential_type) |                                                 | one row per relationship; guards concurrent syncs |

Migrations: `drizzle-sqlite/0018_absent_songbird.sql`, `drizzle-postgres/0018_lazy_slapstick.sql`. Schema defs in `apps/bubblelab-api/src/db/schema-sqlite.ts` / `schema-postgres.ts`, exported through `schema.ts`.

**Table over column (deviation-clause choice):** one parent covers MANY sibling types (the seeded Drive credential derives Sheets AND Calendar), so the relationship is 1:N. A JSON column on `user_credentials` would lose FK integrity, the uniqueness constraint, and cascade deletion.

### How coverage is persisted + kept in sync

- Single coverage implementation: `computeScopeCoverage(ownType, grantedScopes)` in `packages/bubble-shared-schemas/src/credential-schema.ts` (moved from the studio's `computeSuiteCoverage`; identity scopes openid/email/profile excluded, trailing-slash-tolerant comparison per RFC 6749 §3.3).
- `apps/bubblelab-api/src/services/derived-credential-service.ts`: `syncDerivedCredentialsForSource/ById` reconciles stored rows against the parent's current `oauth_scopes` — inserts newly covered types, deletes no-longer-covered ones (lockstep: a revoked scope drops its record), diff-only writes.
- Sync call sites (oauth-service.ts): `storeOAuthToken` (connect), `applyIncrementalToken` (re-consent), `checkGrantedScopes` after a successful tokeninfo probe overwrites `oauth_scopes` (scope-sync). Parent deletion cascades rows via FK.
- API exposure: GET /credentials attaches `derivedCredentials: DerivedCredentialRecord[]` to each parent row (`credentialResponseSchema` extended in shared-schemas). The list call is also the lazy backfill seam for credentials that predate the table — pure recompute from stored scopes, no network, only google-group rows considered.

## Part 2 — binding + labels read the stored record; auto-apply on load

- `apps/bubble-studio/src/lib/credentialBinding.ts`:
  - `getStoredSuiteCoverage(credential)` replaces the recomputing `computeSuiteCoverage`; CredentialsPage "Also grants:" now maps the stored records (a credential with covering scopes but NO record shows nothing — the record is the truth).
  - `computeSuiteBindingProposals` prefers candidates holding a stored record for the required type (`credentialCoversTypeByRecord`); proposals carry `hasDerivedRecord`.
- `apps/bubble-studio/src/hooks/useSuiteBindings.ts`: a proposal with `hasDerivedRecord` binds the steps IMMEDIATELY on flow load (auto-apply; parent exact-type defaults were already applied by useAutoBindCredentials). The scope-check probe still runs as confirmation + sync trigger; an insufficient result rolls the auto-applied binding back (only where still bound to that credential) and surfaces the existing re-consent affordance. Setup-panel "via your Google Drive credential (…)" and the Verified chip are unchanged surfaces now fed by the stored record.

## Part 3 — gmailAccountEmail investigation + implementation

**Finding: the token alone authenticates; the email string is not consumed by the bubbles.** `packages/bubble-core/src/bubbles/service-bubble/gmail.ts` calls `https://www.googleapis.com/gmail/v1/users/me/...` (lines ~886, ~909) — the OAuth token identifies the account; no Gmail/Sheets bubble parameter takes an account email. `gmailAccountEmail` is a flow-input payload field generated flows declare; in flow 6's code it is declared and never referenced. Its only real effect was UI-side: a REQUIRED blank field disables the Execute button (`InputSchemaNode.isFormValid`).

**Built (branch A, fully — not staged):**

- `lib/autoPopulate.ts`: account fields reference the bound credential — prefers the step-bound credential (bound ids from `pendingCredentials`, wired through InputSchemaNode), value = `metadata.email` if known, else the credential NAME (`source: 'credential_name'`). Never blank while a credential is bound; nothing fabricated (both values are stored row data).
- `components/InputFieldsRenderer.tsx`: when the field shows a credential name (email unknown — credential predates the openid/email identity scopes, see memory email-backfill-needs-email-scope), an inline "Reconnect to show the email" affordance runs incremental re-consent with an empty scope list (initiateOAuth appends openid+email; include_granted_scopes preserves the grant), then upgrades the field value to the resolved email. No runtime-resolution refactor was needed since nothing consumes the string at runtime.

## Verification (commands + results)

All in `/home/unix/bubblelab-derived`, Linux bun `~/.bun/bin/bun` (PATH bun is Windows bun — pnpm-run test scripts resolve it and fail; invoke Linux bun directly):

- Package builds shared-schemas→core→runtime→appgen: pass.
- `tsc --noEmit` apps/bubblelab-api + apps/bubble-studio: clean.
- `apps/bubble-studio: vitest --run`: 9 files, 152 tests pass (incl. rewritten credentialBinding.test.ts — 22, autoPopulate.test.ts — 7: stored-coverage reader, record-preferred proposals + hasDerivedRecord, computeScopeCoverage, name-fallback, bound-credential preference).
- API full suite `DATABASE_URL=file:./test.db BUBBLE_ENV=test ~/.bun/bin/bun test --timeout 120000 --preload ./src/test/setup.ts`: **209 pass / 21 skip / 0 fail** (21 skips pre-existing). New `src/services/derived-credential-service.test.ts` (11 tests): record materialization, idempotency, lockstep drop on scope removal, GET /credentials lazy backfill + response shape, probe-shrink drops record, probe-grow adds record, parent-delete cascade.
- Migrations applied: test.db via test setup migrator; dev.db via API-startup runMigrations — `derived_credentials` present in both, dev.db rows verified.
- Studio production build (`tsc -b && vite build`) + API `bun build`: clean.
- eslint on every changed file (from each app dir): clean.
- Browser smoke (alt ports API :3510 / studio :3511, live app, seeded flow 6 replica via `scripts/seed-provenance-smoke.ts` — Drive credential carrying spreadsheets+calendar scopes): `pw-artifacts/smoke-derived-model.py`, two modes, **12/12 checks pass**:
  - fallback mode (Google unreachable/fake tokens): proposal with hasDerivedRecord=true; scope check verified from stored grant; gmailAccountEmail = "Legacy Gmail" (source credential_name, never blank); reconnect affordance renders; setup panel "via your Google Drive credential (Legacy Drive)"; credentials page "Also grants: Google Sheets, Google Calendar" from stored records.
  - identity mode (google-stub preload): backfilled email autopopulates (regression held), no affordance, probe-verified binding, provenance with account email.
  - Screenshots: smoke-derived-setup-{fallback,identity}.png, smoke-derived-credentials-{fallback,identity}.png.

## Deviations

1. Part 3 branch A applied fully (token authenticates alone); the reconnect affordance from branch B was added anyway as a cheap upgrade path for the email display — nothing staged.
2. The scope-check probe still runs after a stored-record auto-bind instead of being skipped. Deliberate: the probe is the sync mechanism that keeps the record honest (it drops stale records), and skipping it would let a revoked-in-Google grant keep a verified label until some other write path fired. Behavior surface is unchanged; latency is hidden by the immediate pre-bind.
3. `computeSuiteCoverage` (studio recompute) was REMOVED, its logic relocated to shared-schemas `computeScopeCoverage` for the API. Dependency surface mapped first: consumers were CredentialsPage + its test only.

## Deploy notes for the live clone

- Fast-forward onto f333bab, then the sqlite migration applies automatically at API startup (runMigrations) — no manual step; or run `corepack pnpm run db:migrate:sqlite` in apps/bubblelab-api.
- First GET /credentials after deploy backfills the records for existing credentials (diff-only writes).
- Rebuild order before serving: shared-schemas → bubble-core → bubble-runtime → bubble-appgen, restart vite (new studio code).

## Learnings

- `pnpm run test` in apps/bubblelab-api resolves the WINDOWS bun even in a Linux-fs clone (backslash paths in output, coverage EINVAL); invoke `~/.bun/bin/bun test` directly.
- `bun --preload x.ts run script` misparses (prints script list); the working form is `bun --preload x.ts src/index.ts`.
- Killing the nohup'd parent of `bun run src/index.ts` leaves the bun CHILD serving the port — kill the pid that owns the socket (`ss -tlnp`).
- Unstubbed Google tokeninfo with a fake token can stall >30s on this box before failing (dead-route hang despite gai.conf fix); smoke waits on that path need ~120s.
- Concurrent bun test runs share `test.db` — serialize full-suite runs.
