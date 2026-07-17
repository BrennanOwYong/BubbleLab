# Delta: AuthMethod strategy model — every sign-in method, most convenient first, derived from docs (IR-3/IR-4)

Branch: `improve/auth-methods-from-docs`. BubbleLab had 141 hand-maintained credential types and
two overlapping systems for one app (`SLACK_CRED` OAuth vs `SLACK_API` token, teardown §12.1
#13/#14). This graft ports the reference build's AuthMethod seam
(`integration_stitcher/packages/auth` + `packages/core/src/auth.ts`) and adds the doc-derivation
discipline the reference never had: a method offered in the Connect UI is a claim about the
vendor's auth surface and must carry its citation, same rule as IR-8's side-effect metadata.

## What changed

### 1. Schema with provenance (`packages/bubble-shared-schemas/src/auth-method-schema.ts`)

- `AuthMethodKindSchema`: the 9-kind taxonomy (`oauth2, oauth2_jwt, api_key, pat, basic,
connection_string, multi_field, browser_session, xoauth2`).
- `AUTH_METHOD_CONVENIENCE_RANK` + `sortByConvenience`: lower = more convenient for a
  non-technical user; oauth2 (popup + scope picker, no secret handling) ranks first,
  connection_string (hand-assembled DSN with embedded password) last. `buildConnectUiSpec` marks
  exactly the top-ranked method `recommended`.
- `AuthMethodDescriptorSchema`: one offered method — kind, **`credentialType` binding into the
  existing credential system**, source (`openapi | prose | manual`), `citation` with `min(1)`,
  confidence, optional `unverified`, plus kind-specific config (placement, testRequest, fields,
  allowedSchemes, scopes). `AppAuthMethodsSchema` is the per-app list; `ConnectUiSpecSchema` the
  ranked payload the studio consumes.

### 2. Strategy seam (`packages/bubble-core/src/auth/`)

`AuthMethodStrategy` = `collect()` (what the Connect UI must ask for) + `test()` (canned vendor
probe) + `applyToRequest()` (where the secret lands) + optional `refresh()` / `grantedScopes()`.
Six kinds implemented end-to-end, all with injectable transports:

| Kind                | File                      | Notes                                                                                                                                              |
| ------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth2`            | `oauth2-strategy.ts`      | scope-picker collect, RFC 6750 bearer, RFC 6749 §6 refresh with rotation-aware refresh-token persistence (Google-omits-refresh_token case handled) |
| `api_key`           | `auth-method-strategy.ts` | one secret field, header/query placement                                                                                                           |
| `pat`               | 〃                        | same wire mechanics, user-scoped semantics (GitHub)                                                                                                |
| `basic`             | 〃                        | RFC 7617 `Basic base64(user:password)`; fields ride BubbleLab's existing JSON-envelope credential encoding (`decodeCredentialPayload`)             |
| `multi_field`       | 〃                        | N labelled fields, per-field placement, missing-field errors                                                                                       |
| `connection_string` | 〃                        | scheme-validating local test; live connectivity stays with each bubble's `testCredential()`                                                        |

`oauth2_jwt`, `browser_session`, `xoauth2` are declared kinds without strategies yet;
`strategyForDescriptor` fails loudly naming `IMPLEMENTED_AUTH_KINDS` instead of no-op'ing.

### 3. Doc-grounded inference (`packages/bubble-core/src/auth/infer-auth-methods.ts`)

`inferAuthMethods(evidence[]) → { methods, uncertainties }`.

- OpenAPI securitySchemes path (per OAS 3.1 Security Scheme Object): `oauth2`→oauth2 (+flow
  scopes), `apiKey` header/query→api_key (+placement), `http basic`→basic, `http bearer`→pat,
  `openIdConnect`→oauth2 at lower confidence. `mutualTLS`, cookie apiKey, unknown types become
  **uncertainties with a reason — never a guessed method**. Confidence: openapi 0.9 > prose 0.6;
  higher confidence wins per kind across evidence pieces.
- Prose path: keyword patterns (OAuth 2.0, personal access token, bot/integration/installation
  token, basic auth, connection string/URI, xoauth2); the citation records the matched phrase.
  No signal → an uncertainty saying so. Zero evidence throws `AuthInferenceError`.

### 4. Per-app derivation, colocated (no 13th registry location)

`bindInferredAuthMethods(inference, bindings)` is the honesty gate: a binding whose kind the
docs did not support throws; every produced descriptor inherits the inference's
source/citation/confidence. Four colocated `<bubble>.auth-methods.ts` files run the inference at
module scope over embedded vendor-doc quotes (fetched 2026-07-15, URLs below) and bind to
existing CredentialTypes; each bubble class declares the result as `static authMethods`,
exposed through `BubbleFactory.getMetadata()` next to `operationMetadata`:

- **slack** — TWO methods: oauth2→`SLACK_CRED` (scope picker fed from the existing
  `OAUTH_PROVIDERS` scope catalogue via `getScopeDescriptions`) and api_key→`SLACK_API`
  (paste `xoxb-…`, probe `auth.test`). The dual-system confusion becomes one app, two ranked
  choices, OAuth recommended.
- **notion** — TWO methods: oauth2→`NOTION_OAUTH_TOKEN`, api_key→`NOTION_API`
  (internal integration secret, probe `GET /v1/users/me`).
- **github** — pat→`GITHUB_TOKEN` (probe `GET /user`).
- **postgresql** — connection_string→`DATABASE_CRED` (`postgresql:`/`postgres:` schemes per
  libpq).

### 5. Connect UI spec renders from collect() (`packages/bubble-core/src/auth/connect-ui-spec.ts`)

`buildConnectUiSpec(bubbleName, methods)`: each option's `collect` payload is the live output of
`strategyForDescriptor(descriptor).collect()` — the UI never hand-maintains per-app field lists.
Options are sorted by convenience; the first is `recommended`. `resolveAuthChoice(methods, kind)`
honors the user's pick: the chosen descriptor's `credentialType` decides which CredentialType the
existing storage/injection/`chooseCredential` path uses, so no parallel credential plumbing exists.

## Deviations from the brief

- **Studio rendering not wired**: the brief says "the Connect UI spec renders from collect()".
  Delivered as the schema-valid `ConnectUiSpec` built from live `collect()` calls,
  factory-reachable via `getMetadata().authMethods` (the same channel `operationMetadata` reaches
  the studio catalogue). The React connect dialog consuming it is follow-up UI work; wiring it now
  would collide with the parallel run-grounding/studio branches.
- **3 of 9 kinds remain strategy-less** (oauth2_jwt, browser_session, xoauth2) — the register
  (IR-3/4 verdict) records these as unwritten work, not a port; the AC needs 3+, six are done.
  BubbleLab's BrowserBase sessions are the natural browser_session backend when it lands.
- The oauth2 strategy's `refresh()` duplicates none of `oauth-service.ts`'s product path: it is
  the strategy-level contract (used where no server-side service exists, and by tests); the API
  service keeps owning the hosted OAuth flow. Noted in the file header.

## How it was verified

Gate (REPO-MAP §2): `pnpm build && pnpm typecheck && pnpm test:core && pnpm lint:check` — results
in the final section.

New tests (no mocking of the unit under test; transports are injected doubles recording real
strategy output):

- `packages/bubble-core/src/auth/auth-methods.test.ts` (17 tests): per-kind collect/apply/test for
  all six strategies (RFC 7617 worked example, bearer placement, query placement, multi-field
  missing-field error, libpq scheme enforcement); oauth2 refresh rotation + Google-omit case +
  no-refresh-token error + honest `grantedScopes` undefined; inference — OpenAPI four-scheme
  mapping with citations, uncertainties for mutualTLS/cookie (never guessed), prose Slack quotes,
  no-signal uncertainty, openapi-over-prose precedence, zero-evidence throw, convenience ordering,
  descriptor schema round-trip.
- `packages/bubble-core/src/auth/connect-ui-spec.test.ts` (10 tests): **slack exposes two methods,
  oauth2 recommended, both bound to the previously-dual credential types** (AC); spec renders from
  collect() — scope picker carries `chat:write`, api_key field carries `xoxb-...` placeholder,
  whole payload parses `ConnectUiSpecSchema`; **user's choice honored** — `resolveAuthChoice`
  returns SLACK_CRED vs SLACK_API, both in `BUBBLE_CREDENTIAL_OPTIONS.slack`, and the chosen
  strategy probes `auth.test` with the chosen secret; citation guard over all four app files
  (schema-valid, URL-cited, credential types accepted by the bubble); statics reachable on the
  four bubble classes; unimplemented-kind loud failure; postgresql end-to-end scheme test.

## References (fetched 2026-07-15; re-verify before editing the derived files)

- Slack token types: https://docs.slack.dev/authentication/tokens/ — "Bot tokens ascribe to a
  granular permission model to request only the scopes you need." / "User tokens represent
  workspace members."
- Slack Web API bearer usage: https://docs.slack.dev/apis/web-api/ — "transmit your token as a
  bearer token in the Authorization HTTP header".
- Notion authorization: https://developers.notion.com/docs/authorization — "public connections
  use the OAuth 2.0 protocol"; "include the installation access token in the Authorization header
  with every API request".
- GitHub REST auth: https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
  — "Personal access tokens act as your identity … when you make requests to the REST API".
- PostgreSQL connection URIs: https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING
  — "The URI scheme designator can be either postgresql:// or postgres://."
- OpenAPI 3.1 Security Scheme Object: https://spec.openapis.org/oas/v3.1.0#security-scheme-object
- RFC 6749 (OAuth 2.0 §4.1, §5.1, §6), RFC 6750 (§2.1 bearer), RFC 7617 (§2 basic):
  https://datatracker.ietf.org/doc/html/rfc6749 · rfc6750 · rfc7617
- Google OAuth refresh (omits refresh_token on refresh):
  https://developers.google.com/identity/protocols/oauth2/web-server

## Gate results

(recorded after the run — see final commit)
