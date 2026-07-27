# RESKIN_RESULT

## Status

DONE. tsc --noEmit clean, vite build passes, placeholder palette verified in the built CSS.

## Branch / commit / push

- Branch: `feature/reskin-gluu` (cut from origin/feature/mvp-oneshot @ ebf398a)
- Commit: see `git log -1` on the branch (message: "reskin: de-brand to Gluu, neutralize BubbleLab look, centralize color tokens")
- Pushed: yes, `origin feature/reskin-gluu`

## Color-token file — where the final Gluu hexes go

Single file: `apps/bubble-studio/src/index.css`, lines 1–51. Two blocks:

**1. `@theme` block (lines 11–43)** — Tailwind v4 theme override. Every `purple-*`, `pink-*`, and the few `violet-*`/`indigo-*` gradient utilities across all ~28 component files resolve to these variables, so the final palette lands here only:

- `--color-purple-50` … `--color-purple-950` — PRIMARY accent scale (placeholder: teal `#f0fdfa`→`#042f2e`, 500=`#14b8a6`, 600=`#0d9488`)
- `--color-pink-50` … `--color-pink-950` — SECONDARY accent scale (placeholder: amber, 500=`#f59e0b`, 600=`#d97706`)
- `--color-indigo-600`, `--color-indigo-700`, `--color-violet-500`, `--color-violet-600` — gradient partners, keep in the primary family

**2. `:root` block (lines 45–51)** — app-shell tokens used by plain CSS and inline styles:

- `--gluu-bg` (placeholder `#101418`) — page background, replaced BubbleLab navy `#0f0f23`
- `--gluu-fg` (placeholder `#cccccc`) — base text
- `--gluu-accent` (placeholder `#14b8a6`) — must equal final purple-500 replacement
- `--gluu-accent-strong` (placeholder `#0d9488`) — must equal final purple-600 replacement; consumed by Monaco line-highlight CSS (index.css:161–187) and FlowVisualizer edge strokes

Literal hexes that also need the final palette (could not be vars):

- `apps/bubble-studio/public/gluu-icon.svg` — placeholder logo/favicon: rect fill `#14181d`, glyph stroke `#14b8a6` (marked with a comment inside the SVG)
- `apps/bubble-studio/src/components/flow_visualizer/FlowVisualizer.tsx:1263` — cron-trigger edge color `#d97706` (secondary accent; kept distinct from the teal service-trigger edge)
- index.css rgba fallbacks `rgba(13, 148, 136, …)` (Monaco highlight backgrounds, lines 158–177 and the `highlight-pulse` keyframes) — rgb of placeholder accent-strong
- Template email gradients in `src/components/templates/template_codes/*.ts`: `#667eea`→`#0d9488`, `#764ba2`→`#115e59` (dailyNewsDigest, projectManagementAssistant)

## Brand strings / logos replaced (file:line, post-change)

- `apps/bubble-studio/index.html:13` — `<title>` Bubble Studio → Gluu; `:5` favicon.ico → `/gluu-icon.svg`
- `public/favicon.ico`, `public/pearl.png` — DELETED (BubbleLab logo + Pearl avatar); replaced by `public/gluu-icon.svg` (neutral G-mark)
- `src/components/Sidebar.tsx:46,55` — logo img → gluu-icon.svg, alts → "Gluu"; `:73`-area wordmark "Bubble Studio" → "Gluu"; **removed** the Discord / Documentation (docs.bubblelab.ai) / Demos (YouTube @bubblelab_ai) / GitHub-star link blocks (old lines 293–435) plus `useGitHubStars` usage; `src/hooks/useGitHubStars.ts` deleted (orphaned, no other importers)
- `src/components/SignInModal.tsx:39,48` — logo swap, "Welcome to Bubble Lab" → "Welcome to Gluu"
- `src/components/FlowNotFoundView.tsx:15` — "Bubble Studio" → "Gluu"
- `src/components/MonthlyUsageBar.tsx:132–133`, `UsageDetailsModal.tsx:236`, `ExportModal.tsx:352,515`, `OnboardingQuestionnaire.tsx:233`, `WebViewWarning.tsx:207,221,264`, `SubmitTemplateModal.tsx:126`, `DashboardPage.tsx:694` — Bubble Lab / BubbleLab → Gluu
- `src/pages/DashboardPage.tsx` — removed "See what the community is building" anchor to bubblelab.ai/community (old lines 406–446); commented-out community URL neutralized to `#`
- `src/pages/PricingPage.tsx` — removed "View full pricing details" anchor to bubblelab.ai/pricing + orphaned ExternalLink import
- `src/utils/zipExportGenerator.ts:84,335,445` — exported-project README/package text → Gluu; removed Learn More/Support sections that linked github.com/bubblelabai/BubbleLab and bubblelab.dev
- Pearl (BubbleLab's assistant persona) display strings → Gluu: `ConsolidatedSidePanel.tsx:64,128`, `ContextRequestWidget.tsx:121`, `GeneratingOverlay.tsx:59`, `AllEventsView.tsx:928,1248,1461` ("Fix with Pearl" buttons), `EvaluationIssuePopup.tsx:218,249`, `EvaluationLoadingPopup.tsx:135`, `PearlChat.tsx:647,652`, `BubbleSidePanel.tsx:192,574`. Code identifiers (PearlChat, onFixWithPearl, tab id 'pearl') untouched — display-only rename, zero refactor risk.
- Template codes (`template_codes/*.ts`, 12 files) — "Bubble Lab"/"BubbleLab"/"bubble lab" display text → Gluu; `https://bubblelab.ai` + github repo links in generated emails → `#`. Functional Resend sender addresses (`welcome@hello.bubblelab.ai`) kept — the domain is what's DNS-verified for sending; only the display name changed ("Gluu Team <…>").

## Restyle summary

- Signature look neutralized: navy-purple body bg → graphite `--gluu-bg`; all purple/pink accents → teal/amber placeholder via the `@theme` override (verified in dist: `--color-purple-500:#14b8a6`, `--color-pink-600:#d97706` in built CSS; no `#9333ea`/oklch purple accents remain in app CSS)
- Monaco editor highlight styles and flow-canvas edge highlight strokes moved onto `var(--gluu-accent-strong)`
- Layout/behavior untouched apart from deleting four sidebar brand links and two brand anchors (Dashboard hero, Pricing header)

## Verification

- `pnpm --filter bubble-studio exec tsc --noEmit` — clean (0 errors)
- `pnpm --filter bubble-studio exec vite build` — success (34.7s; pre-existing >500kB chunk warnings only)
- Built CSS inspected: placeholder token values present, default purple palette gone

## Deviations

- "Bubble" as product vocabulary (BubbleFlow, bubbles-as-nodes, `@bubblelab/*` package names, install commands in ExportModal) NOT renamed — it is load-bearing runtime/API naming, not skin. Renaming it is a core-rename project, not a reskin.
- Residual brand touchpoints left functional, need product decisions: `src/lib/integrations.ts:338` per-bubble doc links still open docs.bubblelab.ai; `hooks/useAnalytics.ts:11` localStorage key `bubblelab_anonymous_user_id` (invisible, changing resets anon ids); `demos/R2StorageDemo.tsx` internal demo setup text; `types/toolGeneration.ts:3` comment citing the real `apps/bubblelab-api` path.
- Sidebar Discord/docs/YouTube/GitHub links deleted rather than re-pointed (no Gluu equivalents exist yet).

## Learnings

- Tailwind v4 `@theme` override in index.css remaps the entire default `purple-*`/`pink-*` scales app-wide with zero component edits — cleanest possible palette centralization for a codebase with 200+ scattered accent utilities.
- GOTCHA: a CSS comment containing `purple-*/pink-*` terminates at that embedded `*/`, silently turning the following `@theme` block into junk text — Tailwind emits default colors and the override lands as dead literal CSS after the utilities layer. Never write `*/` inside CSS comments.
- Verify @theme overrides by grepping the built CSS for the new hex values; the failure mode is silent (build passes, defaults ship).
