# RESULT — prompts lane (feature/nontechnical-prompts)

Status: COMPLETE
Branch: feature/nontechnical-prompts
Commit: f328f66 (on top of bf32c04)

## Files changed

- `packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts` — default-model fixes (A2)
- `apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts` — A2 model steering + rules 27–31 + comment/example rewrites + @header/@hint/@fromUserProfile instructions
- `apps/bubblelab-api/src/services/ai/coffee.ts` — planning prompt sections for setup provisioning, "for me" inputs, checklist framing

## A2 — default model

Chosen id: **`openai/gpt-5-mini`** (= `RECOMMENDED_MODELS.OPENAI_FAST`, listed in the registry `AvailableModels` at `packages/bubble-shared-schemas/src/ai-models.ts:7`). BEST-tier steering uses **`openai/gpt-5.2`** (= `RECOMMENDED_MODELS.OPENAI_BEST`), the same id Pearl/Coffee/Boba already run on in this env.

The default was not one location; five sites steered generated AI-agent bubbles to google/\* models. All changed:

1. `ai-agent.ts:325` — `ModelConfigSchema.default` model: `RECOMMENDED_MODELS.FLAGSHIP` (google/gemini-3-flash-preview) → `OPENAI_FAST`. Fires when generated code omits the model param.
2. `ai-agent.ts:174` — `backupModel` default: `GOOGLE_FLAGSHIP` → `OPENAI_FAST`. Fires at runtime whenever the primary fails and the flow set no backup; with only OPENAI_API_KEY deployed, the old google backup was a guaranteed "No credential found for provider: google" (thrown at `ai-agent.ts:1037`).
3. `ai-agent.ts:552` — constructor fallback params: `FAST` (google/gemini-2.5-flash-lite) → `OPENAI_FAST`.
4. `bubbleflow-generation-prompts.ts` rules 8 and 12 code examples: `'google/gemini-2.5-flash-lite', temperature: 0` → `'openai/gpt-5-mini'` with **temperature dropped** (GPT-5-family rejects non-default temperature; mirrors the coffee.ts model config comment). ResearchAgentTool good-example model: `google/gemini-3-pro-preview` → `openai/gpt-5.2`.
5. `AI_AGENT_BEHAVIOR_INSTRUCTIONS` tier guide + decision flowchart: BEST/PRO/FAST/LITE now interpolate `OPENAI_BEST`/`OPENAI_FLAGSHIP`/`OPENAI_FAST`; google/anthropic/openrouter models restricted to "user explicitly requests that provider AND has connected that provider's credential"; added line: "GPT-5-family models only accept the default temperature: OMIT the temperature field entirely."

Shared `RECOMMENDED_MODELS` values were NOT edited (other consumers, e.g. RICE, depend on them); only which key each prompt/default references.

## B1 — plain-language comments (new rule 27, quoted)

> 27. PLAIN-LANGUAGE COMMENTS (every comment in the flow - bubble methods, pure helper methods, inline comments alike): describe the business action in words a non-technical reader understands. NEVER put a variable name, parameter name, method name, type name, or any other code identifier inside a comment. "Queries the Notion database for deals updated since the last run" is acceptable; "pages until maxDeals using sinceISO" is NOT. Name the real-world thing (the spreadsheet, the email recipient, the deal), never the identifier that holds it. Machine-read JSDoc tags on payload fields (@canBeFile, @canBeGoogleFile, @header, @hint, @fromUserProfile) are configuration, not prose, and are exempt.

Supporting edits: rule 9 now ends "Comment wording follows rule 27: plain business language, never a code identifier." The BUBBLE COMMENT REQUIREMENTS section (BUBBLE_SPECIFIC_INSTRUCTIONS) was rewritten: guidance no longer says comments "reveal parameters"; the GOOD EXAMPLE comments were rewritten identifier-free; the BAD EXAMPLE gained "❌ Names a model id (a code identifier) in the comment". In-example comments in rules 8/12 were de-identifiered.

## B2 — per-input header + hint (new rule 28, quoted)

> 28. PER-INPUT HEADER AND HINT: every field in the payload interface carries two JSDoc tags, personalized to THIS flow: @header - a 2-4 word plain-language label naming the input (e.g. "Recipient email"); @hint - one short plain-language question telling the user what to enter (e.g. "Who should receive this email?"). Write both for a non-technical reader: no code identifiers, no jargon. The setup form shows header and hint next to each input; the field's destructuring default remains the prefilled value.

INPUT_SCHEMA_INSTRUCTIONS gained a "PER-INPUT HEADER AND HINT (@header / @hint) - REQUIRED ON EVERY FIELD" section with examples, and the canonical UserNotificationPayload example now carries @header/@hint on every field.

### Field-descriptor contract emitted

Per required/default input, the generated flow persists (in the payload interface source):

- **key** = the interface property name
- **header** = the `@header <text>` JSDoc tag value
- **hint** = the `@hint <text>` JSDoc tag value
- **value** (optional) = the destructuring default in handle()
- **for-me marker** = `@fromUserProfile <profileKey>` JSDoc tag, profileKey ∈ { `email`, `telegramChatId` }

Extraction seam for downstream lanes: `packages/bubble-runtime/src/extraction/BubbleParser.ts` already lifts `@canBeFile`/`@canBeGoogleFile` from payload-field JSDoc into the input schema (extractJSDocInfo, ~line 2526); the new tags ride the same seam once the parser lane adds three regexes. I did NOT touch BubbleParser (not my file per brief).

## B3 — checklist content

CRITICAL_INSTRUCTIONS new rule 30 (quoted):

> 30. CHECKLIST-READY DESCRIPTIONS: every piece of user-facing descriptive text the flow carries (input headers and hints, method and bubble comments) must fit one of four plain-language buckets: (1) what the user provides (required inputs), (2) what the flow produces (expected outcomes), (3) when it runs (said in everyday words - "every Monday at 9am", "whenever a new form answer arrives"), (4) what the user is told when something goes wrong (e.g. "you get a message saying the spreadsheet could not be reached"). The flow's checklist is built from exactly these four buckets, so phrase all of them without technical terms.

coffee.ts gained "## PLAIN-LANGUAGE CHECKLIST FRAMING" restricting plan summary/steps to the same four buckets, banning webhook/cron/API/payload/schema/bubble-name wording in user-facing text while keeping bubblesUsed/estimatedBubbles machine fields intact. Actual error-handling behavior untouched (out of scope per brief).

## D — setup-provisioning responsibility

coffee.ts new section (quoted):

> ## SETUP PROVISIONING RESPONSIBILITY:
>
> When the user asks for an item to exist just for this flow ("make a spreadsheet to pipe answers into", "create a database for this"), creating that item is YOUR setup responsibility during this conversation - not the user's homework:
>
> - Use the runBubbleFlow tool to create the item as part of planning (the user approves credentials as usual), then take the REAL id from the result.
> - Put that real id in the plan as the prefilled default value for the matching flow input, and add a plan step that names the created item and states its id is already filled in.
> - NEVER plan an input that asks the user for the id of something that does not exist yet, and never leave a placeholder for it.

Codegen side: new rule 31 makes the provisioned item's real id the destructuring default ("NEVER ask the user for the id of something that does not exist yet, and NEVER leave a placeholder for it (rule 21)"), plus item 4 in the REQUIRED vs OPTIONAL decision list. Note: coffee's runBubbleFlow was previously framed as read-only context gathering; this section extends its sanctioned use to setup writes, which is the brief's intent — the provisioning execution mechanics belong to another lane.

## F — "for me" auto-fill

Marker name: **`@fromUserProfile`** with profile key `email` or `telegramChatId`.

CRITICAL_INSTRUCTIONS new rule 29 (quoted):

> 29. PROFILE-BACKED "FOR ME" INPUTS: when results go to the user themselves ("send it to me", "message me", "do it for me"), do NOT ask for their address or chat id and do NOT invent one. Mark the field with the JSDoc tag @fromUserProfile followed by the profile key: @fromUserProfile email for the user's own email address, @fromUserProfile telegramChatId for the user's own Telegram chat. The server fills these from the flow creator's stored profile; keep the field in the payload interface with @header/@hint as usual and give it a realistic default.

coffee.ts gained a matching '## "FOR ME" INPUTS' section (plan wording: "sent to your email on file"). INPUT_SCHEMA_INSTRUCTIONS documents the tag with an example. Storage (userProfileDefaults) is another lane's build; only the marker + instruction shipped here.

## Verification

- `pnpm install` (worktree had no node_modules) then builds in order: @bubblelab/shared-schemas ✅, @bubblelab/bubble-core ✅ (94-bubble manifest regenerated), @bubblelab/bubble-runtime ✅, @bubblelab/bubble-appgen ✅.
- `PATH="$HOME/.bun/bin:$PATH" ~/.local/bin/pnpm --filter bubblelab-api exec tsc --noEmit` → exit 0, no errors.

## Deviations from brief

1. "wherever the default generated-AI-agent model is set" turned out to be five sites, three of them in `packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts` (schema default, backup default, constructor fallback), not an api-side constant. Changed the core file and rebuilt it per the brief's build-order allowance; the backup default especially was a silent runtime google dependency.
2. Prompt examples' `temperature: 0` was removed alongside the model swap — not requested, but keeping it would trade the credential failure for an OpenAI "temperature unsupported" failure on GPT-5-family models.
3. Existing rule numbering was preserved (rules cross-reference each other by number), so new material was appended as rules 27–31 rather than woven into rules 9/21/22.
