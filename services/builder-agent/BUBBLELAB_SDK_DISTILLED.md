# BubbleLab SDK, distilled

A reference for writing a correct `BubbleFlow` with no repo access. Every contract below is extracted from the real source; file:line citations point into the `bubblelab-suite` monorepo. Param and result shapes come from the bubbles' Zod schemas, not from guesses.

---

## 1. Golden rules

### 1.1 Setup vs repeatable: the boundary that defines a flow

A BubbleFlow stores ONLY the idempotent, repeatable sequence. It runs on every trigger fire. One-time SETUP (creating the spreadsheet, database, or folder the flow reuses every run) is NOT part of `handle()`.

- `handle()` MUST assume its input resources already exist and arrive as payload inputs.
- NEVER write "check if X exists, else create it" (ensureX / create-if-missing) inside `handle()`. That is setup leaking into the repeatable core: it adds latency and failure surface to every run, and the first run mocks writes anyway (rule 1.4), so the "create" branch produces a shape-valid fake and the flow reads garbage.
- A fixed resource created once for the flow is a build-time setup item. Its ID arrives as a payload input field carrying `@header`/`@hint` JSDoc tags, and `handle()` reads it. The generation rulebook encodes this: user-specific IDs MUST be JSDoc-documented payload fields with realistic defaults, never created in-flow and never placeholders (`bubbleflow-generation-prompts.ts:129` rule 21, `:139` rule 31).
- Creating a FRESH output artifact each run (a new dated report doc per execution) is legitimate repeatable work. The distinction: fixed infrastructure reused across runs = setup (out); a new artifact produced per run = repeatable (in).

**BAD — setup leaking into handle():**

```typescript
// ANTI-PATTERN: create-if-missing inside the repeatable core
private async ensurePipelineSpreadsheet(): Promise<string> {
  const info = await new GoogleSheetsBubble({
    operation: 'get_spreadsheet_info', spreadsheet_id: this.knownId,
  }).action();
  if (!info.success) {
    const created = await new GoogleSheetsBubble({
      operation: 'create_spreadsheet', title: 'Pipeline',
    }).action();                               // mocked on the first run;
    return created.data?.spreadsheet?.spreadsheetId ?? ''; // fake ID flows onward
  }
  return this.knownId;
}
```

**GOOD — the resource ID is a payload input; handle() only appends:**

```typescript
export interface PipelinePayload extends CronEvent {
  /**
   * @header Pipeline spreadsheet
   * @hint Which spreadsheet should new rows be added to?
   * @canBeGoogleFile true
   */
  spreadsheet_id?: string;
}
// ...inside a private bubble method, called from handle():
const appendResult = await new GoogleSheetsBubble({
  operation: 'append_values',
  spreadsheet_id: spreadsheetId,
  range: 'Sheet1!A:D',
  values: [[date, title, url, summary]],
}).action();
```

**The setup sequence you (the agent) run — tool orchestration, not flow code.** Because setup is not part of the flow, YOU perform it as ordered tool calls before the flow is done:

1. **Provision** each fixed artifact via the provision tool (creates a real spreadsheet and returns its real id). Provisioning EXECUTES for real — it is a direct tool call, not a saved-flow run, so the mocked-writes rule (1.4) does NOT apply here; the sheet and any seed rows genuinely exist afterward. Seed reference/starter rows now if the flow reads existing data.
2. **Author** the repeatable flow with each artifact id as a payload input (§1.1 GOOD shape) — no create/ensure in code.
3. **Validate → fix → save** the code (loop on `errors` and `lintErrors` until both clean).
4. **Store setup state on the flow**: write the provisioned id(s) into the flow's `default_inputs` via the set-defaults tool, so the flow persists what setup produced and every run reads the real id. This is what makes the flow "stateful about its setup" — the artifact is remembered as flow config, distinct from run-to-run history (which the flow still does not keep; see §1.6).

A flow is only correct when setup ran as this phase AND its outputs are stored as `default_inputs`. If you author create-in-flow logic instead, you have put setup into the repeatable work — the exact defect this boundary exists to prevent.

### 1.2 Send safety: draft, do not send

When a flow emails other people, messages others, or posts publicly, and the user has not explicitly opted into automatic sending, the flow CREATES A DRAFT (gmail `create_draft`) plus a notification/reminder to the user, never a direct send. Direct outward sends only on explicit opt-in. Output addressed solely to the user (their own email, their own Telegram chat) is not an outward action (`bubbleflow-generation-prompts.ts:133` rule 25). Gmail `create_draft` takes the identical param set as `send_email` (gmail.ts:402-464), so the safe variant costs nothing.

### 1.3 AI structured output: expectedOutputSchema + safeParseJson

`result.data.response` from an ai-agent bubble is ALWAYS a string. With `expectedOutputSchema` set it is a JSON string in the requested shape, still a string (ai-agent.ts:408-413). The single sanctioned path from AI text to typed data:

1. Declare a Zod schema as a const inside the bubble method.
2. Pass it as `expectedOutputSchema` (a Zod value, never stringified). This auto-enables JSON mode (ai-agent.ts:390-392).
3. Parse with `safeParseJson(result.data.response, sameSchema)`, imported from `@bubblelab/bubble-core` (defined at `packages/bubble-core/src/utils/codegen-narrow.ts:53`). It JSON-parses, validates with the schema, and returns the typed object or `undefined`. Zero casts.

```typescript
const ticketSchema = z.object({
  urgency: z.enum(['low', 'high']),
  reason: z.string(),
});
const result = await new AIAgentBubble({
  message: `Classify this ticket's urgency and give a one-sentence reason: ${text}`,
  expectedOutputSchema: ticketSchema,
  model: { model: 'openai/gpt-5-mini', maxTokens: 10000 },
}).action();
if (!result.success || !result.data?.response) return null;
return safeParseJson(result.data.response, ticketSchema) ?? null;
```

NEVER `JSON.parse(x) as {...}`, never read fields off the unparsed response, never redefine safeParseJson locally.

**Model availability (runtime — do not skip).** Model keys are system credentials from server env, and the deployed runtime has ONLY an OpenAI key set. So every ai-agent MUST use an `openai/...` model — default `openai/gpt-5-mini`, or `openai/gpt-5` for harder reasoning. `anthropic/...`, `google/...`, and `openrouter/...` models validate fine but FAIL at execution with "No credential found for provider". Never set `temperature` on gpt-5-family models — they reject any non-default temperature and error at runtime.

### 1.4 Reads first, writes terminal

The user's first run is a TEST run: reads execute for real, writes are mocked (they return shape-valid results with `mocked: true` but DID NOT happen). Structure flows so reads gather data first and writes come last. NEVER depend on a write's effect later in the same flow (send-then-search, create-then-read-back). Report what was written from data already held (`bubbleflow-generation-prompts.ts:21` and `:128` rule 20). This is the mechanical reason rule 1.1's create-if-missing pattern breaks.

### 1.5 The four anchor shapes

The runtime re-parses the source and recognizes a bubble ONLY when `new XBubble({...})` (optionally awaited, with a single chained `.action()`) sits directly at: a const/let initializer, a bare expression statement, a concise arrow body, or a return statement. A bubble anywhere else (ternary arm, object/array literal, call argument, `.map()` callback) compiles green but runs with NO credentials and NO telemetry. Pass the constructor's argument as an inline object literal with discrete properties; never hoist, spread, or cast it (`bubbleflow-generation-prompts.ts:21,30-34`).

### 1.6 Statelessness: a flow keeps no memory between runs

Each execution runs `handle()` fresh with NO persistent state — the runtime offers no key-value store, no "last run" timestamp, nothing carried from the previous run. So "the new rows since last time", "only unseen items", "don't repeat yesterday's" cannot rely on runtime memory. Track state IN the integrated tools the flow already touches, and pick one sanctioned pattern:

- **Status column** — add a `processed`/`status` column; each run reads rows where it's blank, acts, then writes the status back. The sheet IS the memory.
- **Marker row / tracking tab** — append a marker row, or keep a one-cell "last processed id/date" in a dedicated tracking tab, and read rows after it.
- **Provider-native filter** — e.g. Gmail `is:unread` then mark-as-read, or a date-bounded query, so the source system tracks what's new.

State which pattern you used; never assume the runtime remembers. (Note this respects 1.4: the status-write is terminal, and on the first mocked run nothing is actually marked — acceptable, since a test run re-processing rows is harmless.)

### 1.7 Cron timezone

`cronSchedule` is evaluated in **UTC**. When the user gives a wall-clock hour without a timezone ("every day at 9am"), take the literal hour AS UTC — `'0 9 * * *'` — and note the assumption in the comment. Do NOT silently convert to a guessed local zone. Only convert when the user names a timezone, and then show the arithmetic in the comment (e.g. `'0 13 * * 1-5' // 9am ET = 13:00 UTC`).

---

## 2. Flow skeleton

```typescript
import type { BubbleTriggerEventRegistry } from '@bubblelab/shared-schemas';
import {
  BubbleFlow,
  GoogleSheetsBubble,
  AIAgentBubble,
  TelegramBubble,
  WebSearchTool,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas'; // or WebhookEvent, SlackMentionEvent, ...

export interface MyPayload extends CronEvent {
  // custom input fields, see section 3
}

export class MyFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 9 * * 1-5'; // REQUIRED literal for cron flows, UTC

  constructor() {
    super('my-flow', 'What this flow does');
  }

  async handle(payload: MyPayload): Promise<{ ok: boolean }> {
    // pure orchestration only
    return { ok: true };
  }
}
```

Ground truth:

- `BubbleFlow<TEventType extends keyof BubbleTriggerEventRegistry>` is the abstract base; `handle(payload: BubbleTriggerEventRegistry[TEventType]): Promise<BubbleFlowOperationResult>` where `BubbleFlowOperationResult = unknown`, so any meaningful return object is valid and is what the user sees (`packages/bubble-core/src/bubble-flow/bubble-flow-class.ts:9-45`, `packages/bubble-core/src/types/bubble.ts:81`).
- Trigger keys (`packages/bubble-shared-schemas/src/trigger.ts:1-11`): `'webhook/http'` (WebhookEvent), `'schedule/cron'` (CronEvent), `'slack/bot_mentioned'` (SlackMentionEvent), `'slack/message_received'`, `'slack/reaction_added'`, `'slack/approval_resumed'`, `'airtable/record_created'`, `'airtable/record_updated'`, `'airtable/record_deleted'`. The generic MUST be a quoted string literal.
- `CronEvent` = base event + `cron: string` + `body?: Record<string, unknown>` (trigger.ts:70-74). `WebhookEvent` = base event + `body?` (trigger.ts:76-78). Base event fields: `type`, `timestamp`, `executionId`, `path` (trigger.ts:34-40).
- Cron flows MUST declare `readonly cronSchedule = '<expr>'` as a literal inside the class (5-part cron, UTC). Validation rejects cron flows without it (`bubble-flow-class.ts:19-34`, prompts rule 2).
- Exactly ONE exported class extending BubbleFlow per file. Every import comes from the single `@bubblelab/bubble-core` import (plus types from `@bubblelab/shared-schemas` and `zod`).
- Structure rules (prompts rules 5-9): `handle()` is pure orchestration (sequential `const x = await this.method(...)`, plain if/for, then return). No bubble instantiation, no throw, no try-catch, no switch inside `handle()`. Each bubble lives in its own private async bubble method called ONLY from handle() as a plain statement (`Promise.all([this.a(), this.b()])` allowed). Pure transformation methods (no bubbles anywhere in their call chain) may call each other and appear inside expressions. Per-item fan-out: for loop in handle(), one bubble-method call per iteration; never fan out through `.map()` callbacks.
- No `any`, no casts of any kind (`as T`, `as unknown as T`, `<T>expr`), including on JSON.parse results (prompts rule 11). For polymorphic external data use the imported narrowing helpers `getField`, `asArray`, `asString`, `asNumber`, `asBoolean` (`codegen-narrow.ts:20-44`).
- Every declared interface/type must be used. No placeholder strings anywhere ("YOUR_API_KEY", "<FOLDER_ID>"). Each private method carries a one-line plain-language comment naming the business action, never a code identifier.
- Logging: `this.logger?.info(message)` when output has no destination.

### Bubble invocation and result envelope

`.action()` is the ONLY way to run a bubble. It returns `BubbleResult<T>`:

```typescript
{ success: boolean; error: string; data: T; executionId: string; timestamp: Date; mocked?: boolean }
```

(`packages/bubble-shared-schemas/src/mock-data-generator.ts:21-37`, wrap site `packages/bubble-core/src/types/base-bubble-class.ts:349-355`). `data` is the bubble's per-operation result, which itself carries `success` and `error` again (mirrored to the top level). API failures do NOT throw; they surface as `success: false` with `error` set. Always check `result.success` before touching `result.data`, and null-check fields (`result.data?.x`), since only `success === true` guarantees data (prompts rule 15).

For discriminated-union bubbles (sheets, gmail, drive, telegram, notion), passing `operation` as a quoted literal narrows `result.data` to that operation's result fields. One wrong param name breaks the narrowing and produces misleading union-wide errors; fix params first.

---

## 3. Input schema: the payload interface and its JSDoc tags

The studio extracts the flow's input schema from the payload interface, which MUST extend the trigger's event type (`export interface MyPayload extends CronEvent { ... }`). Custom fields become setup-form inputs. Fields are read in handle() by destructuring with realistic example defaults: `const { spreadsheet_id = '1BxiMVs0X...' } = payload;`.

The parser (`packages/bubble-runtime/src/extraction/BubbleParser.ts:2536-2699`) reads these JSDoc tags from the comment block directly above each field:

| Tag                            | Parsed as                           | Meaning                                                                                     |
| ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| `@header <text>`               | rest of line (BubbleParser.ts:2635) | 2-4 word plain-language label, the field's title on the setup form                          |
| `@hint <text>`                 | rest of line (:2642)                | one short plain-language question telling the user what to enter                            |
| `@fromUserProfile <key>`       | single identifier (:2650)           | "for me" field auto-filled from the flow creator's profile; keys: `email`, `telegramChatId` |
| `@canBeFile true\|false`       | boolean (:2613)                     | enables file upload UI for a string field                                                   |
| `@canBeGoogleFile true\|false` | boolean (:2620)                     | enables Google Picker UI for Drive file/folder ID fields                                    |

Remaining comment text becomes the field description. Every payload field REQUIRES `@header` and `@hint` (prompts rule 28). When results go to the user themselves, use `@fromUserProfile` instead of asking for their address; keep the field with @header/@hint and a realistic default (rule 29). Credentials and API keys NEVER go in the payload (rule 10).

```typescript
export interface ReportPayload extends CronEvent {
  /**
   * @header Deals spreadsheet
   * @hint Which spreadsheet holds the deals to summarize?
   * @canBeGoogleFile true
   */
  spreadsheet_id?: string;
  /**
   * @header Your Telegram chat
   * @hint Where should the daily summary be sent?
   * @fromUserProfile telegramChatId
   */
  telegram_chat_id?: string;
}
```

---

## 4. Bubble reference (demo-relevant set)

All service-bubble params are snake_case (`spreadsheet_id`, `chat_id`, `file_id`, `body_text`). Never camelCase. Every operation result carries `operation`, `success: boolean`, `error: string` (empty on success). Omit the `credentials` param entirely; it is injected at runtime (section 5).

### 4.1 GoogleSheetsBubble — `google-sheets`

`packages/bubble-core/src/bubbles/service-bubble/google-sheets/google-sheets.ts:38-47` (class), `google-sheets.schema.ts:103-456` (params union), `:459-634` (results). Credential: `GOOGLE_SHEETS_CRED` (google-sheets.ts:720-731).

| operation              | required                                            | key optional (= default)                                                | result.data                                                              |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `read_values`          | `spreadsheet_id`, `range`                           | `value_render_option='FORMATTED_VALUE'`, `major_dimension='ROWS'`       | `values?: (string\|number\|boolean)[][]`, `range?`                       |
| `write_values`         | `spreadsheet_id`, `range`, `values: unknown[][]`    | `value_input_option='USER_ENTERED'`                                     | `updated_range?`, `updated_rows?`, `updated_cells?`                      |
| `update_values`        | same as write_values                                | same                                                                    | same                                                                     |
| `append_values`        | `spreadsheet_id`, `range`, `values`                 | `insert_data_option='INSERT_ROWS'`, `value_input_option='USER_ENTERED'` | `table_range?`, `updated_range?`, `updated_rows?`, `updated_cells?`      |
| `clear_values`         | `spreadsheet_id`, `range`                           |                                                                         | `cleared_range?`                                                         |
| `batch_read_values`    | `spreadsheet_id`, `ranges: string[]`                |                                                                         | `value_ranges?: {range, values}[]`                                       |
| `batch_update_values`  | `spreadsheet_id`, `value_ranges: {range, values}[]` | `value_input_option='USER_ENTERED'`                                     | `total_updated_cells?`, `responses?[]`                                   |
| `get_spreadsheet_info` | `spreadsheet_id`                                    | `include_grid_data=false`                                               | `spreadsheet?: {spreadsheetId, properties?, sheets?[], spreadsheetUrl?}` |
| `create_spreadsheet`   | `title`                                             | `sheet_titles=['Sheet1']`                                               | `spreadsheet?` (same shape) — SETUP-ONLY, never in handle()              |
| `add_sheet`            | `spreadsheet_id`, `sheet_title`                     | `row_count=1000`, `column_count=26`                                     | `sheet_id?`, `sheet_title?`                                              |
| `delete_sheet`         | `spreadsheet_id`, `sheet_id: number`                |                                                                         | `deleted_sheet_id?`                                                      |

`values` is an array of ROWS, each an array of cells. Nulls sanitize to `''`.

### 4.2 GmailBubble — `gmail`

`packages/bubble-core/src/bubbles/service-bubble/gmail.ts:984-998` (class), params union `:203-728`, results `:731-970`. Credential: `GMAIL_CRED` (gmail.ts:2151-2162). 18 operations; the flow-relevant ones:

| operation                         | required                                             | key optional                                                                                                                              | result.data                                     |
| --------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `send_email`                      | `to: string[]`, `subject`                            | `body_text` (markdown auto-converts to HTML), `body_html`, `cc`, `bcc`, `thread_id`, `attachments: {filename, mime_type, data(base64)}[]` | `message_id?`, `thread_id?`                     |
| `create_draft`                    | IDENTICAL param set to send_email (gmail.ts:402-464) | same                                                                                                                                      | `draft?: {id, message}`                         |
| `send_draft`                      | `draft_id`                                           |                                                                                                                                           | `message_id?`, `thread_id?`                     |
| `list_emails`                     | none                                                 | `query`, `label_ids`, `max_results=100` (1-500), `include_details=true`                                                                   | `messages?: GmailMessage[]`, `next_page_token?` |
| `search_emails`                   | `query`                                              | `max_results=50`                                                                                                                          | `messages?[]`, `next_page_token?`               |
| `get_email`                       | `message_id`                                         | `format='full'`                                                                                                                           | `message?`                                      |
| `get_thread`                      | `thread_id`                                          | `format='full'`                                                                                                                           | `thread?: {id, messages?}`                      |
| `mark_as_read` / `mark_as_unread` | `message_ids: string[]`                              |                                                                                                                                           | `modified_messages?: string[]`                  |
| `trash_email` / `delete_email`    | `message_id`                                         |                                                                                                                                           | `trashed_message_id?` / `deleted_message_id?`   |

Body params are `body_text` / `body_html`, NOT `body`/`html`. At least one of the two is required at runtime (gmail.ts:1516-1518). Returned messages are cleaned: read the decoded plaintext at `message.textContent`, plus `snippet` and essential headers only; raw base64 body data is stripped (gmail.ts:1234-1267).

### 4.3 GoogleDriveBubble — `google-drive`

`packages/bubble-core/src/bubbles/service-bubble/google-drive.ts:916-930` (class), params union `:336-696`, results `:699-903`. Credential: `GOOGLE_DRIVE_CRED` (:2192-2203). 12 operations:

| operation       | required                                          | key optional                                                            | result.data                                                        |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `upload_file`   | `name`, `content` (base64 or plain text)          | `mimeType`, `parent_folder_id`, `convert_to_google_docs=false`          | `file?: {id, name, mimeType, webViewLink?, ...}`                   |
| `download_file` | `file_id`                                         | `export_format` (REQUIRED at runtime for Google Workspace files)        | `content?` (text or base64), `filename?`, `mimeType?`              |
| `list_files`    | none                                              | `folder_id`, `query`, `max_results=100`, `order_by='modifiedTime desc'` | `files?[]`, `next_page_token?`                                     |
| `create_folder` | `name`                                            | `parent_folder_id`                                                      | `folder?: {id, name, webViewLink?}` — SETUP-ONLY for fixed folders |
| `delete_file`   | `file_id`                                         | `permanent=false` (trash)                                               | `deleted_file_id?`                                                 |
| `get_file_info` | `file_id`                                         | `include_permissions=false`                                             | `file?`, `permissions?[]`                                          |
| `share_file`    | `file_id`                                         | `email_address`, `role='reader'`, `type='user'`                         | `permission_id?`, `share_link?`                                    |
| `move_file`     | `file_id`                                         | `new_parent_folder_id`                                                  | `file?`                                                            |
| `get_doc`       | `document_id`                                     | `tab_id`                                                                | `document?`, `plainText?`                                          |
| `update_doc`    | `document_id`, `content` (markdown auto-detected) | `mode='replace'\|'append'`                                              | `documentId?`, `revisionId?`                                       |
| `replace_text`  | `document_id`, `replacements: {find, replace}[]`  | `tab_id`                                                                | `replacements_made?`                                               |
| `copy_doc`      | `document_id`, `new_name`                         | `parent_folder_id`                                                      | `new_document_id?`, `new_document_url?`                            |

File IDs and links live inside nested objects (`file.id`, `file.webViewLink`), never top-level.

### 4.4 TelegramBubble — `telegram`

`packages/bubble-core/src/bubbles/service-bubble/telegram.ts:793-838` (class), params union `:84-495`, results `:665-789`. Credential: `TELEGRAM_BOT_TOKEN` (:845-858). 13 operations; key ones:

| operation        | required                            | key optional                                                                                                  | result.data                                      |
| ---------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `send_message`   | `chat_id: string\|number`, `text`   | `parse_mode: 'HTML'\|'Markdown'\|'MarkdownV2'`, `disable_notification`, `reply_to_message_id`, `reply_markup` | `ok`, `message?: {message_id, chat, text?, ...}` |
| `send_photo`     | `chat_id`, `photo` (file_id/URL)    | `caption`, `parse_mode`                                                                                       | `message?`                                       |
| `send_document`  | `chat_id`, `document` (file_id/URL) | `caption`                                                                                                     | `message?`                                       |
| `edit_message`   | `text`                              | `chat_id`, `message_id`                                                                                       | `message?`                                       |
| `delete_message` | `chat_id`, `message_id: number`     |                                                                                                               | ok/success only                                  |
| `get_chat`       | `chat_id`                           |                                                                                                               | `chat?`                                          |
| `get_me`         | none                                |                                                                                                               | `user?`                                          |

Results carry both `ok` (Telegram API) and `success`.

### 4.5 AIAgentBubble — `ai-agent`

`packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts:494-503` (class), params `:296-407`, result `:408-445`. NOT a discriminated union; one param shape:

- `message: string` (required). The prompt. Include all context explicitly; do not expect the agent to infer.
- `systemPrompt?: string` (default 'You are a helpful AI assistant').
- `model: { model, maxTokens?=64000, maxRetries?=3, jsonMode?=false }`. Always include. `model.model` is `'provider/model-name'` from a fixed enum (`packages/bubble-shared-schemas/src/ai-models.ts:4-41`). The enum lists `anthropic/*`, `google/*`, `openrouter/*` too, but **the deployed runtime only has an OpenAI key — use `openai/gpt-5-mini` (or `openai/gpt-5`); other providers fail at execution (golden rule 1.3).** Do NOT pass `temperature` for gpt-5 models. Example: `model: { model: 'openai/gpt-5-mini', maxTokens: 10000 }`.
- `tools?: [{ name: 'web-search-tool' } , { name: 'web-scrape-tool' }]` — available names include web-search-tool, web-scrape-tool, web-crawl-tool, web-extract-tool (ai-agent.ts:333-338).
- `expectedOutputSchema?: ZodSchema` — pass the Zod value directly; forces JSON mode (see golden rule 1.3).
- `maxIterations?=80`, `conversationHistory?`, `images?`.

Result (`result.data`): `response: string` (ALWAYS a string; JSON string under JSON mode), `toolCalls: {tool, input, output}[]`, `iterations: number`, `success`, `error` (ai-agent.ts:408-445). Model credentials (OPENAI_CRED / ANTHROPIC_CRED / GOOGLE_GEMINI_CRED) resolve by provider prefix (:781-830) and are system-injected; never ask the user for an LLM key.

### 4.6 WebSearchTool — `web-search-tool`

`packages/bubble-core/src/bubbles/tool-bubble/web-search-tool.ts:63-72`. Params (:12-37): `query` (required), `limit=10`, `location?`, `categories?: ('research'\|'pdf'\|'github')[]`. Result data (:40-56): `results: {title, url, content}[]`, `totalResults`, `success`, `error`. Credential: FIRECRAWL_API_KEY (system-injected). Usable directly (`new WebSearchTool({query}).action()`) or as an ai-agent tool.

### 4.7 WebScrapeTool — `web-scrape-tool`

`packages/bubble-core/src/bubbles/tool-bubble/web-scrape-tool.ts:81-88`. Params (:37-56): `url` (required, valid URL), `format='markdown'|'html'`, `onlyMainContent=true`. Result data (:59-74): `content: string`, `title`, `url`, `success`, `error`. Credential: FIRECRAWL_API_KEY (system-injected).

### 4.8 NotionBubble — `notion`

`packages/bubble-core/src/bubbles/service-bubble/notion/notion.ts:1163-1174` (class), params union `:322-886`, results `:889-1157`. Credential: `NOTION_OAUTH_TOKEN` with `NOTION_API` fallback (:1233-1242). 18 operations; flow-relevant:

| operation                 | required                                                                             | key optional                                                                                       | result.data                                                |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `search`                  | none                                                                                 | `query` (title match), `filter: {value:'page'\|'data_source', property:'object'}`, `page_size=100` | `results?[]`, `next_cursor?`, `has_more?`                  |
| `create_page`             | `parent` ({type:'database_id',database_id} auto-resolves to data source; or page_id) | `properties`, `children` (blocks), `icon`                                                          | `page?: {id, url, properties, ...}`                        |
| `retrieve_page`           | `page_id`                                                                            |                                                                                                    | `page?`                                                    |
| `update_page`             | `page_id`                                                                            | `properties`, `archived`                                                                           | `page?`                                                    |
| `query_data_source`       | `data_source_id` OR `database_id` (one required at runtime, :1629-1636)              | `filter`, `sorts`, `page_size=100`                                                                 | `results?[]`, `next_cursor?`, `has_more?`                  |
| `retrieve_database`       | `database_id`                                                                        |                                                                                                    | `database?` incl. `data_sources[]` and merged `properties` |
| `append_block_children`   | `block_id`, `children` (1-100 blocks, `{object:'block', type, <type>:{...}}`)        | `after`                                                                                            | `blocks?[]`                                                |
| `retrieve_block_children` | `block_id`                                                                           | `page_size=100`                                                                                    | `blocks?[]`                                                |

Notion API version 2025-09-03: databases contain `data_sources`; "database query" is `query_data_source`. Page properties are polymorphic; traverse with the narrowing helpers (section 2), e.g. title at `properties.Title.title[0].plain_text` with every level optional.

### 4.9 HttpBubble — `http` (generic HTTP client)

`packages/bubble-core/src/bubbles/service-bubble/http.ts:120-126`. Params (:18-80): `url` (required), `method='GET'`, `headers?`, `body?` (string or JSON object; objects auto-JSON with Content-Type), `timeout=30000`, `authType='none'|'bearer'|'basic'|'api-key'|'api-key-header'|'custom'|'query-param'`, `responseType='auto'|'text'|'binary'`. Result data (:86-116): `status`, `body: string` (base64 when `isBase64: true`), `json?: unknown` (parsed when JSON), `contentType`, `success` (HTTP 2xx), `error`. Credential: `CUSTOM_AUTH_KEY` or any provided (wildcard, :160-173).

---

## 5. Credential model

- `CredentialType` is an enum in `packages/bubble-shared-schemas/src/types.ts:3` (`GOOGLE_SHEETS_CRED`, `GMAIL_CRED`, `GOOGLE_DRIVE_CRED`, `TELEGRAM_BOT_TOKEN`, `NOTION_OAUTH_TOKEN`, `OPENAI_CRED`, `ANTHROPIC_CRED`, `FIRECRAWL_API_KEY`, ...).
- Flows NEVER pass credentials. Every bubble's param schema has an optional `credentials` record, but the runtime matches and injects credentials into each recognized bubble call site automatically. Never read `process.env`, never put keys in the payload (prompts rule 10).
- SYSTEM credentials are injected from the server environment, not connected per user: `OPENAI_CRED`, `ANTHROPIC_CRED`, `GOOGLE_GEMINI_CRED`, `OPENROUTER_CRED`, `FIREWORKS_CRED`, `FIRECRAWL_API_KEY`, `RESEND_CRED`, Cloudflare R2 keys, `APIFY_CRED`, `CRUSTDATA_API_KEY`, `FULLENRICH_API_KEY` (`packages/bubble-shared-schemas/src/credential-schema.ts:884-901`). So ai-agent, web-search-tool, and web-scrape-tool work with zero user credential setup.
- User-connected (OAuth/API-key) credentials per bubble: sheets → `GOOGLE_SHEETS_CRED`, gmail → `GMAIL_CRED`, drive → `GOOGLE_DRIVE_CRED`, telegram → `TELEGRAM_BOT_TOKEN`, notion → `NOTION_OAUTH_TOKEN`/`NOTION_API`.

---

## 6. Worked example: cron research digest (obeys every golden rule)

Daily flow: searches the web for a topic, has an AI agent distill the findings into a fixed shape, appends one row to an existing spreadsheet, and pings the user on Telegram. The spreadsheet is fixed infrastructure, so its ID arrives as an input; nothing is created in-flow.

```typescript
import type { BubbleTriggerEventRegistry } from '@bubblelab/shared-schemas';
import {
  BubbleFlow,
  AIAgentBubble,
  GoogleSheetsBubble,
  TelegramBubble,
  WebSearchTool,
  safeParseJson,
} from '@bubblelab/bubble-core';
import { z } from 'zod';
import type { CronEvent } from '@bubblelab/shared-schemas';

export interface ResearchDigestPayload extends CronEvent {
  /**
   * @header Research topic
   * @hint What topic should be researched every morning?
   */
  topic?: string;
  /**
   * @header Digest spreadsheet
   * @hint Which spreadsheet should each day's digest be added to?
   * @canBeGoogleFile true
   */
  spreadsheet_id?: string;
  /**
   * @header Your Telegram chat
   * @hint Where should the daily summary message be sent?
   * @fromUserProfile telegramChatId
   */
  telegram_chat_id?: string;
}

const digestSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  source_url: z.string(),
});

export class DailyResearchDigestFlow extends BubbleFlow<'schedule/cron'> {
  readonly cronSchedule = '0 13 * * 1-5'; // 9am ET = 13:00 UTC (user named ET; see 1.7)

  constructor() {
    super(
      'daily-research-digest',
      'Searches the web for a topic each weekday, appends a digest row to a spreadsheet, and notifies the user on Telegram'
    );
  }

  async handle(payload: ResearchDigestPayload) {
    const {
      topic = 'AI agent frameworks',
      spreadsheet_id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
      telegram_chat_id = '123456789',
    } = payload;

    const findings = await this.searchTopic(topic);
    if (findings.length === 0) {
      return { appended: false, reason: 'No search results found' };
    }

    const digest = await this.distillFindings(topic, findings);
    if (digest === null) {
      return { appended: false, reason: 'Could not distill the findings' };
    }

    const rowAdded = await this.appendDigestRow(spreadsheet_id, digest);
    const notified = await this.notifyUser(telegram_chat_id, digest);

    return {
      appended: rowAdded,
      notified,
      headline: digest.headline,
    };
  }

  // Searches the web for fresh coverage of the chosen topic
  private async searchTopic(
    topic: string
  ): Promise<{ title: string; url: string; content: string }[]> {
    const searchResult = await new WebSearchTool({
      query: `${topic} latest news`,
      limit: 10,
    }).action();
    if (!searchResult.success || !searchResult.data) return [];
    return searchResult.data.results;
  }

  // Condenses the search results into one headline, summary, and source link
  private async distillFindings(
    topic: string,
    findings: { title: string; url: string; content: string }[]
  ): Promise<z.infer<typeof digestSchema> | null> {
    const findingsText = findings
      .map((f) => `${f.title} (${f.url}): ${f.content}`)
      .join('\n');
    const result = await new AIAgentBubble({
      message: `From these search results about "${topic}", pick the single most significant development. Reply with a headline, a two-sentence summary, and the source link.\n\n${findingsText}`,
      expectedOutputSchema: digestSchema,
      model: { model: 'openai/gpt-5-mini', maxTokens: 10000 }, // openai-only runtime; see 1.3
    }).action();
    if (!result.success || !result.data?.response) return null;
    return safeParseJson(result.data.response, digestSchema) ?? null;
  }

  // Adds one dated row with the digest to the tracking spreadsheet
  private async appendDigestRow(
    spreadsheetId: string,
    digest: z.infer<typeof digestSchema>
  ): Promise<boolean> {
    const appendResult = await new GoogleSheetsBubble({
      operation: 'append_values',
      spreadsheet_id: spreadsheetId,
      range: 'Sheet1!A:D',
      values: [
        [
          new Date().toISOString().slice(0, 10),
          digest.headline,
          digest.summary,
          digest.source_url,
        ],
      ],
    }).action();
    return appendResult.success;
  }

  // Sends the day's headline and summary to the user's own Telegram chat
  private async notifyUser(
    chatId: string,
    digest: z.infer<typeof digestSchema>
  ): Promise<boolean> {
    const sendResult = await new TelegramBubble({
      operation: 'send_message',
      chat_id: chatId,
      text: `${digest.headline}\n\n${digest.summary}\n${digest.source_url}`,
    }).action();
    return sendResult.success;
  }
}
```

Why this satisfies the rules: the spreadsheet ID is a payload input (no in-flow creation); reads (search, AI) precede writes (append, send); the Telegram message goes to the user's own profile-backed chat, so send safety allows a direct send; the AI output crosses into typed data only through `safeParseJson` with the same schema passed as `expectedOutputSchema`; every bubble sits at an anchor position inside its own private method; handle() contains only orchestration, an if guard, and a return; no casts, no credentials, no placeholders (defaults are realistic examples).

---

## Evaluation note

A raw Claude Code instance writing against this doc has no access to the in-project ESLint rules, the bubbleflow-validation tool, or the runtime re-parser. Evaluate its output on DESIGN correctness against the contracts above (anchor shapes, setup/repeatable boundary, param names, result access, structured-output pattern), not on whether it compiles inside the repo.

## Sources (repo paths, branch state as of 2026-07-28)

- `packages/bubble-core/src/bubble-flow/bubble-flow-class.ts` (BubbleFlow, cronSchedule, handle)
- `packages/bubble-shared-schemas/src/trigger.ts` (event registry, CronEvent, WebhookEvent, Slack events)
- `packages/bubble-core/src/utils/codegen-narrow.ts` (safeParseJson, narrowing helpers)
- `packages/bubble-core/src/bubbles/service-bubble/ai-agent.ts`, `packages/bubble-shared-schemas/src/ai-models.ts`
- `packages/bubble-core/src/bubbles/service-bubble/google-sheets/google-sheets.schema.ts`, `gmail.ts`, `google-drive.ts`, `telegram.ts`, `notion/notion.ts`, `http.ts`
- `packages/bubble-core/src/bubbles/tool-bubble/web-search-tool.ts`, `web-scrape-tool.ts`
- `packages/bubble-runtime/src/extraction/BubbleParser.ts` (JSDoc field tags)
- `packages/bubble-shared-schemas/src/types.ts`, `credential-schema.ts` (CredentialType, SYSTEM_CREDENTIALS)
- `apps/bubblelab-api/src/config/bubbleflow-generation-prompts.ts` (execution contract and rules 1-31)
- `packages/bubble-shared-schemas/src/mock-data-generator.ts` (BubbleResult envelope)
