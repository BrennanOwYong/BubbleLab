# Product Principles: the non-technical customer

The customer never wrote code, does not know what an API (Application
Programming Interface) is, and does not want to learn. They want an outcome:
"email me the report every Monday." The product shoulders all technical
complexity; the customer never sees it.

Every UX task (U1, U2, U3, U5, and all future ones) is measured against this
doc. `DISPATCH-CONTRACT.md` Pillar 2 requires each UX task's acceptance test to
include a "no technical leakage" check derived from the checklist below.

---

## Principles

1. **The customer describes an outcome. The product does the engineering.**
   Input is plain language; output is the thing they asked for. Everything in
   between belongs to the product.

2. **Show the result, never the mechanism.** The primary post-run surface is
   the answer (the doc link, the sent email, the headline number), one click
   away at most (U2). Steps, params, and internals are the product's business.

3. **Plain words only.** Every label passes the shop-owner test: would a
   person who runs a flower shop say this word? "Connect your Google account,"
   never "OAuth"; "Google Drive," never `GOOGLE_DRIVE_CRED`. A label that
   needs a tooltip to explain a term is the wrong label.

4. **Ask for one doable thing at a time.** When the product needs the customer
   (connect an account, pick an option), it asks for exactly that, in plain
   words, with one button, at the moment it matters. It never presents a form
   of technical fields.

5. **Errors resolve or instruct. Never explain-only.** Binary: the product
   fixes the problem silently (with at most a one-line note), or it gives the
   customer the single plain-language action that fixes it. An error message
   with no fix path is a defect.

6. **Complete honesty about setup.** The setup surface lists everything the
   flow needs to work, in product names, nested tools included (U5). A flow
   that looks ready but is missing a connection is a lie to the customer.

7. **Remember, never re-ask.** Details the customer gave once (their email,
   their bot, their sheet) auto-populate next time (FE2). Repeated questions
   signal the product was not listening.

8. **Depth lives behind intent, not on the surface.** The default surface is
   curated. Power users reach detail through the chat agent or the code tab
   by choosing to; nothing technical is one accidental hover away.

9. **The screen holds its shape.** Content fits its container; nothing spills,
   truncates mid-word, or overlaps (U3). Broken layout reads as a broken
   product.

---

## The "no technical leakage" checklist

The concrete gate. A customer-facing surface (canvas nodes, setup tab, chat,
results, dashboards) violates F0.5 if it shows ANY of the following. Each UX
task's event-based acceptance test asserts the relevant items from the data
layer that feeds the render (telemetry / node view-model / panel data), per
`DISPATCH-CONTRACT.md` Pillar 2.

Banned on every default customer-facing surface:

- [ ] **Raw parameter names or editors**: `message`, `url`, `limit`,
      `operation`, schema type annotations like `(string)` / `(object)`,
      "Add \<param\>" buttons.
- [ ] **Machine constants**: SCREAMING_SNAKE credential types (`*_CRED`),
      `variableId`s, raw bubble slugs (`ai-agent`, `web-search-tool`) used as
      display labels.
- [ ] **Code internals**: code strings, raw JSON blobs, stack traces, HTTP
      status codes, port numbers, environment-variable names, file paths.
- [ ] **Developer-state badges**: "Not in code", "Read-only", "Editable",
      "Hidden environment parameters", lint/validation phrasing.
- [ ] **Jargon**: API, OAuth, token, webhook, cron, schema, payload, SSE,
      credential-type, endpoint. Each has a plain replacement or is omitted.
- [ ] **Numeric IDs as identity**: "flow 81" or "credential 6" where a name
      belongs.
- [ ] **Unresolved errors**: any error shown without either a silent fix or
      one plain-language user action (Principle 5).
- [ ] **Layout leakage**: content overflowing its node/panel, exposing
      internals through spill (U3).

Required on every default customer-facing surface:

- [ ] Integrations carry their human product name and logo.
- [ ] The flow's most important output is reachable in one click after a run
      (U2).
- [ ] The setup surface lists every needed connection, nested tools included,
      in product names (U5).
- [ ] Node detail views show only the curated whitelist (U1: agent = model,
      instructions, tools, memory; tool = description + connected account).

## Per-task lens (Phase 2)

| Task | Leakage assertion its acceptance test must include                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1   | Rendered field list equals the curated whitelist exactly; no field is a raw param name; no rendered label matches `/_CRED$/` or SCREAMING_SNAKE. |
| U2   | The surfaced result is `finalResult[primaryOutputKey]` alone, not the raw result object/JSON; the button label is plain language.                |
| U3   | Computed node dimensions contain their content (no spill exposes internals).                                                                     |
| U5   | Setup-panel data lists every required connection by human name, nested tools included; no `*_CRED` strings in the rendered labels.               |

New UX tasks add their own row here in the same PR that adds the backlog row.

## Enforcement

- `DISPATCH-CONTRACT.md` Pillar 2: a UX task's event test fails (exit
  non-zero) on any banned item found in the render-feeding data. The pattern
  lives in `PLAN-DOCS/discovery/U1.md` (the `node.curated_view_rendered`
  telemetry event assertion).
- `[USER-TEST]` cards (Pillar 1) carry one standing taste question: "Did any
  word on screen feel like it was written for a programmer?"
- Review lens for PRs touching studio surfaces: quote the checklist item for
  any violation; the fix rides the same PR.
