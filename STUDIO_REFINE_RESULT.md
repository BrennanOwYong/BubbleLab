# STUDIO_REFINE_RESULT

## Status

Complete.

## Branch / commit / push

- Branch: `feature/studio-refine` (base 797e40f)
- Commit: e53deea "studio: remove brand logos, plain-language actions/outcomes checklist" (+ a docs amend for this file)
- Pushed: `origin feature/studio-refine`

## 1. Logos removed

Every brand/mascot mark deleted; text labels ("Gluu") kept; functional icons untouched (integration chips in ExportModal/CredentialsPage/BubbleNode etc. remain, since those name the user's apps).

| Site                                                                                  | Change                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/bubble-studio/index.html:5`                                                     | Favicon `<link rel="icon" href="/gluu-icon.svg">` removed (no favicon now).                                                                                                                             |
| `apps/bubble-studio/src/components/Sidebar.tsx:44-61`                                 | Toggle button showed gluu-icon with hover-swap to panel icons; now shows `PanelLeftClose`/`PanelLeft` (functional icons) directly. "Gluu" text label kept.                                              |
| `apps/bubble-studio/src/components/SignInModal.tsx:36-44`                             | 12x12 gluu-icon block above "Welcome to Gluu" removed; heading text kept.                                                                                                                               |
| `apps/bubble-studio/src/components/ConsolidatedSidePanel.tsx:127`                     | Pearl tab rendered gluu-icon instead of its tab icon; the `isPearl` branch is gone, tab now uses a `Sparkles` lucide icon like every other tab (the `Code` placeholder icon and unused import removed). |
| `apps/bubble-studio/src/components/ai/PearlChat.tsx:646-651`                          | Empty-state gluu-icon above "Chat with Gluu" removed; heading kept.                                                                                                                                     |
| `apps/bubble-studio/src/components/execution_logs/EvaluationLoadingPopup.tsx:120-140` | Avatar `<img>` inside the animated circle removed; the circle is now a plain gradient orb so the existing glow/ring spinner animation still has a center.                                               |
| `apps/bubble-studio/public/gluu-icon.svg`                                             | Asset deleted (`git rm`).                                                                                                                                                                               |

`grep -rn gluu-icon apps/ packages/` returns nothing. No pearl avatar image assets existed beyond gluu-icon.svg (public/ holds only integration logos + data files; no image imports in src).

## 2. Checklist plain language

`apps/bubble-studio/src/utils/flowChecklist.ts`:

- New `toPlainLanguage(text)` sanitizer applied to every checklist line, plan-fallback line, and flow summary. Ordered replacement table swaps coder vocabulary for everyday words: AI agent→AI, prompt→instructions, 2D array→table, array→list, A1 range→cell range, JSON→structured data, XML→data, HTML dropped, UTC dropped, RSS→news, API→service, parse→read, endpoint→address, payload→data, webhook→automatic trigger, cron→schedule, query→look up, render→create, configured→chosen, deterministically→reliably, downstream→later. Also spells out leaked identifiers: snake_case (`chat_id`→"chat id") and camelCase (`sendReminderEmail`→"send reminder email").
- `humanizeFunctionName` (fallback when a step has no description) now maps coder verbs to everyday ones (transform→prepares, build→creates, fetch→gets, execute→runs, validate→checks, compute→works out, ...) then runs `toPlainLanguage`.
- `humanizeToolName` chip names: `ai-agent`→"AI", `http`→"Web", `postgresql`→"Database"; app bubbles keep their app name (Google Sheets, Gmail, Telegram).
- `step-main` line: "Sets up the tools this flow uses" → "Connects the apps this flow uses".
- Native-call noise (`max`, `object`, `safeParse`, `push` nodes in real workflows) never reaches the checklist: `extractStepGraph` already skips function_call nodes without `methodDefinition` (workflowToSteps.ts:154).

### Real before/after (flow 22, GET :3001/bubble-flow/22)

Before (generation-time descriptions rendered verbatim):

- "Converts a sheet tab name into a wide A1 range that includes headers and typical client columns."
- "Reads the client table from Google Sheets as a 2D array including the header row."
- "Generates one structured HTML brief and risk assessment for a single client row."
- "Builds the AI prompt for one client including all sheet fields and explicit instructions for HTML output."
- "Creates a stable subject line including the current UTC date for easy inbox scanning."
- "Renders the compiled HTML email body with a summary header and per-client sections sorted by risk."
- Tool chips: "AI Agent", "Google Sheets", "Gmail"

After (probe run of `deriveChecklistItems` against the live flow 22 JSON):

- "Converts a sheet tab name into a wide cell range that includes headers and typical client columns."
- "Reads the client table from Google Sheets as a table including the header row." [Google Sheets]
- "Generates one structured brief and risk assessment for a single client row." [AI]
- "Builds the AI instructions for one client including all sheet fields and explicit instructions for output."
- "Creates a stable subject line including the current date for easy inbox scanning."
- "Creates the compiled email body with a summary header and per-client sections sorted by risk."
- "Sends the compiled brief to the provided recipient using the connected Gmail account." [Gmail]

## Verification

- `pnpm --filter bubble-studio exec vitest run src/utils/flowChecklist.test.ts`: 11/11 pass (tests updated for new humanizer outputs + new `toPlainLanguage` cases built from flow 22/32 live descriptions).
- `pnpm --filter bubble-studio exec tsc --noEmit`: exit 0.
- `pnpm --filter bubble-studio exec vite build`: built in 33.6s (pre-existing chunk-size warnings only).
- Throwaway probe test rendered the flow 22 checklist above, then was deleted.

## Deviations

- ConsolidatedSidePanel pearl tab: brief said remove logos; the tab needed some icon to match its siblings, so it uses the lucide `Sparkles` glyph — a functional UI icon, not a brand mark. Swap or drop on request.
- EvaluationLoadingPopup: removing the image outright would leave the spinner rings orbiting nothing, so the center circle keeps its animation as a plain purple gradient orb (no image asset).

## Learnings

- `extractStepGraph` filters native calls (`max`, `push`, `safeParse`) by requiring `methodDefinition`, so checklist noise-filtering needs no extra work.
- `deriveFlowSummary` sentence-cases now; one test asserting lowercase pass-through needed updating.
- Real flows 22/32 carry good generation-time step descriptions; the leak surface is vocabulary (A1/2D array/JSON/HTML/UTC/chat_id), not missing descriptions, so a deterministic replacement table covers it.
