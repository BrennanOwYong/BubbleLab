# IR Index — per-Improvement-Requirement deep-dives

One doc per IR (Improvement Requirement). Each follows the same template: Purpose, BubbleLab today,
the delta, why needed, reference build vs port, evidence/status, verdict. Companions:
`../HANDOFF.md` and `../IMPROVEMENT-REGISTER.md` (improvement-plan branch), `../REPO-MAP.md`,
`../deltas/` (merged-work records). Status column reflects fork main `d79b6ca`, 2026-07-15.

| IR | Name | Purpose (one line) | Verdict | Status | Doc |
|---|---|---|---|---|---|
| IR-1 | Declarative AppSpec | One dropped spec file per integration; zero central edits (kills the 12-location checklist) | SURGERY, incrementally adoptable | CONFIRMED (ref); port Wave 3, building | [IR-01](./IR-01.md) |
| IR-2 | Author/user control levers | 7 author + 7 user control surfaces over auth, scopes, and read/write | RE-ANALYSE | NO TEST EVER WRITTEN; not porting | [IR-02](./IR-02.md) |
| IR-3 | Auth-method-per-app | One AuthMethod strategy per kind; "OAuth or token" = one app, two methods | PORT the seam; 6 of 9 kinds are unwritten work | PARTIAL (3/9 kinds); port Wave 2, building | [IR-03](./IR-03.md) |
| IR-4 | Credential resolver seam | Single seam for credential resolution; provider swappable with zero upstream change | PORT | CONFIRMED (ref); port Wave 2, building | [IR-04](./IR-04.md) |
| IR-5 | Refresh-on-expiry + single-flight lock | Refresh only when expired; concurrent resolutions produce exactly one refresh | PORT | CONFIRMED (ref); port Wave 1, building | [IR-05](./IR-05.md) |
| IR-6/7 | Proactive scope audit + honest fallback | Fail before a run naming the missing scope; say so when scopes are uncheckable | PORT | CONFIRMED (ref); port in progress (Wave 2) | [IR-06-07](./IR-06-07.md) |
| IR-8 | Doc-grounded side-effect classifier | Every operation carries a cited read/write classification from docs, never the HTTP method | PORT | CONFIRMED; MERGED on fork main (PR #2, 59-op backfill) | [IR-08](./IR-08.md) |
| IR-9/10 | Tester (probe-to-ground) + auto-run gate | Reads run for real and ground contracts; writes mock unless per-op sign-off | PORT (the wall-breaker) | CONFIRMED (ref: 48/48, 0 prod mutations, 4 docs-lie catches); port PARTIAL — test-mode MERGED (PR #3), grounding branch pushed | [IR-09-10](./IR-09-10.md) |
| IR-11/12 | Self-healing Contract KB + anti-poison | Contracts heal to reality after 3 consistent observations; never learn from mocks | SURGERY, only after IR-9/10 | LAB-ONLY; production-blocked in ref by the drift-code collapse bug; port Wave 3, building | [IR-11-12](./IR-11-12.md) |
| IR-13 | Web/DOM contract | Captured DOM interactions as a pseudo-API contract; replay drift is detected, not silent | RE-ANALYSE (blocked on a real driver) | PARTIAL/LAB-ONLY (validated against captured DOM only); deferred | [IR-13](./IR-13.md) |
| IR-14 | Browser observe-and-intervene | Supervised browser sessions with human takeover, captured as replayable traces | RE-ANALYSE | BUILT BUT NEVER VALIDATED (mock driver only); KIV, not scheduled | [IR-14](./IR-14.md) |
| IR-15 | Runtime-context injection | Per-run state travels in a context object; delete the source-text rewriter | SURGERY | CONFIRMED (ref: byte-identical source); deferred, not scheduled | [IR-15](./IR-15.md) |
| IR-16 | Sandboxed execution | Generated code runs in an allowlisted isolate, not in-process behind a denylist | SURGERY (genuine security fix) | CONFIRMED (ref: allowlist holds); deferred, not scheduled | [IR-16](./IR-16.md) |
| IR-17 | Durable step execution + resume | Interrupted flows resume from the last completed step; fills BubbleLab's own stubs | SURGERY (low-risk variant) | CONFIRMED (ref: resume verified); deferred, not scheduled | [IR-17](./IR-17.md) |

## Cross-cutting notes

- **The one wall:** upstream BubbleLab's build never executes; generation grounds on schema-synthesized
  fiction. IR-9/10 (reframed on the fork as two-phase execution + sign-off gate) breaks it; IR-11/12
  waits behind it. See HANDOFF §3 and §5.
- **The AST retraction (HANDOFF §2):** the reference build's AST-vs-regex benchmark (F1 0.95 vs 0.34)
  was measured against a naive regex baseline BubbleLab does not use. BubbleLab already parses a real
  AST and assigns per-call-site identity. No identity layer is ported; IR-11/12 keys on the identity
  they already have, and IR-15's target is the source-rewriting write path, not the parser.
- **Data corrections found while writing these docs:** the register's "141 hand-maintained credential
  types" does not match the current tree (63 `CredentialType` enum members; 90 bubble entries in
  `BUBBLE_CREDENTIAL_OPTIONS`); the `"example string"`/`42` literals HANDOFF §3 attributes to
  `mock-data-generator.ts` live in `get-bubble-details-tool.ts` (`generateExampleValue()`), with
  `MockDataGenerator` producing equivalent schema-derived fiction. Both substantive claims stand.
