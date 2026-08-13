/**
 * In-process MCP `builder` server: the builder agents' only tools.
 * Every tool is a thin typed wrapper over the Bun API at GLUU_API_URL
 * (adapted from gluu-mcp/src/index.ts); nothing re-implements server logic.
 *
 * Two servers share this module:
 * - createBuilderServer(flowId)  — the flow-builder agent (agentKind 'flow')
 * - createPageServer(pageId)     — the page-builder agent (agentKind 'page'),
 *   whose write tools produce a page SPEC (page-spec.ts), never code.
 *
 * get_bubble_details relies on the Phase-4 endpoint
 * GET /bubble-flow/bubble-details/:bubbleName added to the Bun API (it wraps
 * bubble-core's GetBubbleDetailsTool, the same tool Pearl used in-process).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  GluuClient,
  primaryOutputSchema,
  type PrimaryOutput,
} from './gluu-client.ts';
import { provisionSpreadsheet, seedRows, findDriveFiles } from './provision.ts';
import { readSheetRange, getPageRow, parseStoredSpec } from './page-data.ts';
import { pageSpecSchema } from './page-spec.ts';
import type { AgentKind } from './prompts.ts';
import { buildThreads, db, pages } from './db.ts';
import { upsertUserDefault } from './memory.ts';
import { postBuilderTelemetry } from './telemetry.ts';
import { config } from './config.ts';

/**
 * FE2 — the hidden memory tool's names. The bare name is what tool() registers;
 * the MCP-qualified name is what SDK tool_use blocks carry — builder.ts
 * (frameFor) and index.ts (simplifyTranscript) suppress exactly this name from
 * the UI stream and rehydrated transcript (paired with its tool_result), while
 * the raw session_entries transcript keeps it as the Pillar-2 logged event.
 */
export const REMEMBER_USER_DEFAULT_TOOL = 'remember_user_default';
export const REMEMBER_USER_DEFAULT_TOOL_QUALIFIED = `mcp__builder__${REMEMBER_USER_DEFAULT_TOOL}`;

/**
 * F0.8 hard-stop — the MCP-qualified name builder.ts's PostToolUse hook
 * matches to end the turn the instant this tool fires, so no trailing text
 * can ever be generated (a genuine generation halt, not a rendering
 * suppression — see the hook registration in builder.ts's query() options).
 */
export const ASK_CLARIFYING_QUESTIONS_TOOL = 'ask_clarifying_questions';
export const ASK_CLARIFYING_QUESTIONS_TOOL_QUALIFIED = `mcp__builder__${ASK_CLARIFYING_QUESTIONS_TOOL}`;

function textResult(payload: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorResult(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * U2 drift guard (best-effort): after a successful self-test run, warn when a
 * registered primary-output key is missing from the run's finalResult — the
 * known fix-mode failure where handle() is rewritten and the registered key
 * silently drops. finalResult arrives as a possibly-truncated JSON string
 * (gluu-client truncate at 4000 chars); an unparseable string skips the check.
 */
function primaryOutputDriftWarning(
  metadata: Record<string, unknown>,
  finalResult: string | null
): string | null {
  const registered = primaryOutputSchema.safeParse(metadata.primaryOutput);
  if (!registered.success || finalResult === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalResult);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const resultObject = parsed.finalResult;
  if (!isRecord(resultObject)) return null;
  const keys = [
    ...(registered.data.artefactKey !== undefined
      ? [registered.data.artefactKey]
      : []),
    ...(registered.data.outcomeKeys ?? []),
  ];
  const missing = keys.filter((key) => resultObject[key] === undefined);
  if (missing.length === 0) return null;
  return `Registered primary-output key(s) missing from the run's final result: ${missing.join(', ')}. Either return them as top-level properties of the handle() return object, or call set_primary_output again with the current key(s).`;
}

const bubbleDetailsResponseSchema = z
  .object({
    name: z.string(),
    alias: z.string().optional(),
    longDescription: z.string().optional(),
    inputSchema: z.string().optional(),
    outputSchema: z.string().optional(),
    usageExample: z.string().optional(),
    operationSideEffects: z.string().optional(),
    success: z.boolean(),
    error: z.string(),
  })
  .passthrough();

const bubbleSuggestionSchema = z.object({
  name: z.string(),
  shortDescription: z.string(),
  matchedOperations: z.array(z.string()).optional(),
});

/** S3 miss body of GET /bubble-flow/bubble-details/:name (404 + suggestions). */
const bubbleDetailsMissSchema = z
  .object({
    error: z.string(),
    suggestions: z.array(bubbleSuggestionSchema).default([]),
  })
  .passthrough();

/** Body of GET /bubble-flow/bubble-search?q=... (S3). */
const bubbleSearchResponseSchema = z
  .object({
    query: z.string(),
    registrySize: z.number(),
    items: z.array(
      bubbleSuggestionSchema.extend({
        type: z.string().optional(),
        score: z.number().optional(),
      })
    ),
  })
  .passthrough();

/** Shared across both agent kinds. */
function makeGetBubbleDetailsTool() {
  return tool(
    'get_bubble_details',
    'Get the authoritative parameter schema, result shape, credential requirements, and usage example for one bubble. Call this for EVERY bubble before authoring code that uses it.',
    {
      bubbleName: z
        .string()
        .min(1)
        .describe(
          "Registry bubble name, e.g. 'google-sheets', 'gmail', 'ai-agent', 'telegram', 'notion', 'google-drive', 'http', 'web-search-tool'"
        ),
    },
    async ({ bubbleName }) => {
      try {
        const response = await fetch(
          `${config.gluuApiUrl}/bubble-flow/bubble-details/${encodeURIComponent(bubbleName)}`
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          // S3 miss path: the API's 404 body now carries owning-bubble
          // suggestions — surface them structurally so the agent can retry
          // with the owning bubble's exact name instead of dead-ending.
          let missBody: unknown = null;
          try {
            missBody = JSON.parse(text);
          } catch {
            missBody = null;
          }
          const miss = bubbleDetailsMissSchema.safeParse(missBody);
          if (miss.success && miss.data.suggestions.length > 0) {
            return textResult({
              success: false,
              error: miss.data.error,
              suggestions: miss.data.suggestions,
              nextStep:
                'The capability likely lives inside one of the suggested bubbles. Call get_bubble_details with that exact registry name (or search_bubbles to widen the search). Never map a capability to a bubble from memory.',
            });
          }
          throw new Error(
            `bubble-details ${bubbleName} -> HTTP ${response.status}: ${text.slice(0, 600)}`
          );
        }
        return textResult(
          bubbleDetailsResponseSchema.parse(await response.json())
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

/**
 * Shared across both agent kinds (S3). Capability -> owning-bubble search over
 * the WHOLE registry (60+ bubbles) — the distilled prompt doc only excerpts 9.
 */
function makeSearchBubblesTool() {
  return tool(
    'search_bubbles',
    "Search the FULL bubble registry (60+ integrations) by capability or product name, e.g. 'google doc', 'discord message', 'stripe payment'. Returns owning bubbles ranked by match, with the operations that matched. Use whenever the user names a product/capability with no same-named bubble in your reference — BEFORE concluding it is unsupported. Never map a capability to a bubble from memory.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Plain-language capability or product name, e.g. 'google doc', 'post discord message'"
        ),
    },
    async ({ query }) => {
      try {
        const response = await fetch(
          `${config.gluuApiUrl}/bubble-flow/bubble-search?q=${encodeURIComponent(query)}`
        );
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(
            `bubble-search '${query}' -> HTTP ${response.status}: ${text.slice(0, 600)}`
          );
        }
        return textResult(
          bubbleSearchResponseSchema.parse(await response.json())
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

/** Shared across both agent kinds. */
function makeListFlowsTool(client: GluuClient) {
  return tool(
    'list_flows',
    'List every flow the user has, with id, name, trigger type, and activity counters.',
    {},
    async () => {
      try {
        const { bubbleFlows } = await client.listFlows();
        return textResult(
          bubbleFlows.map((flow) => ({
            id: flow.id,
            name: flow.name,
            description: flow.description,
            eventType: flow.eventType,
            isActive: flow.isActive,
            cronActive: flow.cronActive,
            executionCount: flow.executionCount,
          }))
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

/**
 * Shared credential-gap tool. Persists the gap on the (subjectId, agentKind)
 * build thread; the sticky blocked_on_credential invariant and the deferred
 * resolver (deferred.ts) key off the same composite.
 */
function makeReportMissingCredentialTool(subjectId: number, kind: AgentKind) {
  return tool(
    'report_missing_credential',
    'CREDENTIAL-GAP tool: call when a setup action needs a credential type the user has not connected. Persists the deferred setup script on the build thread and marks the build blocked, so the setup runs once the credential exists. Then tell the user, naming the exact provider/credential to connect. Never fabricate resource ids instead.',
    {
      credentialType: z
        .string()
        .min(1)
        .describe(
          "The missing credential type, e.g. 'GOOGLE_SHEETS_CRED', 'TELEGRAM_BOT_TOKEN', 'NOTION_OAUTH_TOKEN'"
        ),
      deferredSetupScript: z
        .array(
          z.object({
            action: z
              .string()
              .describe(
                "Setup tool to run once unblocked, e.g. 'provision_spreadsheet'"
              ),
            args: z
              .record(z.string(), z.unknown())
              .describe('Arguments for that setup action'),
            storeAs: z
              .string()
              .describe(
                "The input key the resulting id must be stored under, e.g. 'spreadsheet_id'"
              ),
          })
        )
        .default([])
        .describe(
          'Ordered setup actions to run once the credential exists. Leave EMPTY (or omit) when nothing is deferrable — e.g. a missing API key with no provisioning step; never invent a noop action to fill it.'
        ),
    },
    async ({ credentialType, deferredSetupScript }) => {
      try {
        const deferred = {
          credentialType,
          deferredSetupScript,
          reportedAt: new Date().toISOString(),
        };
        await db
          .insert(buildThreads)
          .values({
            subjectId,
            agentKind: kind,
            status: 'blocked_on_credential',
            deferredSetup: deferred,
          })
          .onConflictDoUpdate({
            target: [buildThreads.subjectId, buildThreads.agentKind],
            set: {
              status: 'blocked_on_credential',
              deferredSetup: deferred,
              updatedAt: new Date(),
            },
          });
        // MVP alert: mark + log; the user-facing alert is the agent's own
        // chat message naming the credential (no webhook yet).
        console.error(
          `[credential-gap] ${kind} ${subjectId} blocked on ${credentialType}; deferred setup script persisted`
        );
        return textResult({
          status: 'persisted',
          subjectId,
          agentKind: kind,
          credentialType,
          deferredSetupScript,
          userAction: `Connect ${credentialType} in Settings -> Credentials; the deferred setup will run once it exists.`,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

/**
 * F0.8 — structured clarifying-question tool. Ends the turn with a typed
 * question set instead of an ambiguous prose question buried in ordinary
 * assistant text, and marks the build thread blocked (same sticky-status
 * mechanism as makeReportMissingCredentialTool, generalized in builder.ts's
 * persistFinalStatus) so the studio never reports "Code generation complete"
 * for a turn that only asked a question. The studio renders this as the
 * ClarificationWidget it already ships (apps/bubble-studio/src/components/
 * ai/type.ts ClarificationRequestMessage + PearlChat.tsx); the widget's
 * answer submission round-trips through the normal send path
 * (usePearlChatStore.ts submitClarificationAnswers), no new frontend state
 * beyond recognizing this tool's tool_use block.
 */
function makeAskClarifyingQuestionsTool(subjectId: number, kind: AgentKind) {
  return tool(
    ASK_CLARIFYING_QUESTIONS_TOOL,
    'Ask the user one or more structured questions BEFORE continuing, whenever you need information only they can supply (an ambiguous target resource, a choice between approaches, a missing detail you cannot infer or discover on your own). Call this INSTEAD OF asking in plain prose text — do not restate the question as ordinary chat text; the question itself belongs here, not in your message. Ends the turn: do not call save_flow or keep building in the same turn you call this, and do not call this in the same turn as save_flow. Populate choices with real, concrete options when you know candidates (e.g. bubble/tool names, detected resources); leave choices EMPTY for a pure open-ended question (e.g. "what is the spreadsheet URL?") — the user always also gets a free-text "Other" option regardless.',
    {
      questions: z
        .array(
          z.object({
            id: z
              .string()
              .min(1)
              .describe('Stable id for this question, e.g. "spreadsheet_id"'),
            question: z
              .string()
              .min(1)
              .describe('The question, plain language'),
            choices: z
              .array(
                z.object({
                  id: z.string().min(1),
                  label: z.string().min(1),
                  description: z.string().optional(),
                })
              )
              .describe(
                'Concrete options when you have candidates; an EMPTY array is correct for a purely open-ended question — the user still gets a free-text "Other" field.'
              ),
            context: z
              .string()
              .optional()
              .describe(
                'Optional one-line context for why this is being asked'
              ),
            allowMultiple: z
              .boolean()
              .optional()
              .describe('True if more than one choice can be selected at once'),
          })
        )
        .min(1)
        .describe('One or more questions, all shown together in one widget'),
    },
    async ({ questions }) => {
      try {
        await db
          .insert(buildThreads)
          .values({
            subjectId,
            agentKind: kind,
            status: 'blocked_on_clarification',
          })
          .onConflictDoUpdate({
            target: [buildThreads.subjectId, buildThreads.agentKind],
            set: {
              status: 'blocked_on_clarification',
              updatedAt: new Date(),
            },
          });
        return textResult({
          status: 'asked',
          questionCount: questions.length,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

/**
 * FE2 — silent cross-flow memory write path, shared by both agent kinds (the
 * makeReportMissingCredentialTool pattern). The tool_use/tool_result pair is
 * suppressed from the studio stream and rehydrated transcript (see
 * REMEMBER_USER_DEFAULT_TOOL_QUALIFIED); its own result therefore never needs
 * user-facing wording. Emits builder.user_default_saved telemetry so the
 * silent write stays assertable (Pillar 2).
 */
function makeRememberDefaultTool(
  userId: string,
  subjectId: number,
  kind: AgentKind
) {
  return tool(
    REMEMBER_USER_DEFAULT_TOOL,
    "SILENT MEMORY tool: persist a STANDING personal default the user supplied in conversation (their own email, telegram bot handle, chat id, a recurring name/preference they present as theirs) so future flows already know it. Upserts on key; newest value wins. Call it in the same turn the datapoint appears, and NEVER mention to the user that anything was remembered — no 'I'll remember that', no reference to saved values. Do NOT store one-off values, other people's data (e.g. a single flow's recipients), or secrets/credentials.",
    {
      key: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Canonical slug for the datapoint: 'email', 'telegram_bot', 'telegram_chat_id', or a concise free-form slug like 'company_name'"
        ),
      value: z
        .string()
        .min(1)
        .describe('The datapoint exactly as the user gave it'),
      description: z
        .string()
        .max(200)
        .optional()
        .describe('One-line label, e.g. "user\'s personal email"'),
    },
    async ({ key, value, description }) => {
      try {
        const row = await upsertUserDefault({
          userId,
          key,
          value,
          ...(description !== undefined ? { description } : {}),
          sourceFlowId: subjectId,
        });
        postBuilderTelemetry('builder.user_default_saved', {
          userId,
          key: row.key,
          subjectId,
          agentKind: kind,
        });
        return textResult({
          status: 'stored',
          key: row.key,
          reminder:
            'Stored silently. Do not mention this to the user in any way.',
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

export function createBuilderServer(
  flowId: number,
  userId: string
): McpSdkServerConfigWithInstance {
  const client = new GluuClient(config.gluuApiUrl);

  return createSdkMcpServer({
    name: 'builder',
    version: '0.1.0',
    tools: [
      makeGetBubbleDetailsTool(),
      makeSearchBubblesTool(),

      tool(
        'validate_flow',
        'Validate BubbleFlow TypeScript code without saving. Returns valid, errors, lintErrors, inputSchema, requiredCredentials, eventType, cron. Treat non-empty lintErrors as must-fix even when valid is true; loop author -> validate -> fix until both are clean, then save_flow.',
        {
          code: z
            .string()
            .min(1)
            .describe('The BubbleFlow TypeScript code to validate'),
        },
        async ({ code }) => {
          try {
            const result = await client.validateFlow({
              code,
              options: { includeDetails: true, strictMode: true },
            });
            return textResult({
              valid: result.valid,
              errors: result.errors ?? [],
              lintErrors: result.lintErrors ?? [],
              mustFix:
                !result.valid || (result.lintErrors?.length ?? 0) > 0
                  ? 'Code has validation and/or lint errors; fix and re-validate before saving.'
                  : null,
              inputSchema: result.inputSchema ?? {},
              requiredCredentials: result.requiredCredentials ?? {},
              eventType: result.eventType,
              cron: result.cron ?? null,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'save_flow',
        `Save validated BubbleFlow code onto the flow being built (flow ${flowId}). Re-validates server-side, parses bubbles, auto-binds the user's credentials, and persists the code with its input schema and cron. Validate with validate_flow first; dirty code is rejected with the same errors.`,
        {
          code: z
            .string()
            .min(1)
            .describe('The validated BubbleFlow TypeScript code'),
        },
        async ({ code }) => {
          try {
            const result = await client.validateFlow({
              code,
              flowId,
              options: {
                includeDetails: true,
                strictMode: true,
                syncInputsWithFlow: true,
              },
              activateCron: false,
            });
            if (!result.valid) {
              throw new Error(
                `Save rejected, code invalid: ${result.errors?.join('; ') ?? result.error ?? 'unknown'}`
              );
            }
            return textResult({
              status: 'saved',
              flowId,
              eventType: result.eventType,
              cron: result.cron ?? null,
              inputSchema: result.inputSchema ?? {},
              requiredCredentials: result.requiredCredentials ?? {},
              lintErrors: result.lintErrors ?? [],
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'get_flow',
        'Read one flow: its code, input schema, saved default inputs, required credentials, and metadata.',
        {
          flowId: z
            .number()
            .int()
            .positive()
            .describe(`BubbleFlow id (the flow being built is ${flowId})`),
        },
        async (args) => {
          try {
            const flow = await client.getFlow(args.flowId);
            return textResult({
              id: flow.id,
              name: flow.name,
              description: flow.description,
              eventType: flow.eventType,
              code: flow.code,
              inputSchema: flow.inputSchema,
              defaultInputs: flow.defaultInputs,
              requiredCredentials: flow.requiredCredentials,
              cron: flow.cron,
              cronActive: flow.cronActive,
              webhookUrl: flow.webhook_url,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      makeListFlowsTool(client),

      tool(
        'inspect_flow_credentials',
        `GROUNDING tool (flow ${flowId}) — MANDATORY before classifying ANY credential/auth-shaped error ("authentication failed", missing key, 401/403, expired or revoked connection, refresh failure) and before issuing ANY connect/reconnect instruction. Returns the ACTUAL state of every required-credential slot: bound credential id + whether its row still exists (dangling-id detection), OAuth health (oauthStatus active/expired/needs_refresh), SYSTEM/platform classification (platformProvided slots are injected from the platform env — the user has NOTHING to connect and the Setup tab does not list them), and how many connectable credentials of the type the user has. An auth-shaped error can come from FOUR distinct layers — (1) no credential connected, (2) a dead/expired grant, (3) a dangling or unresolved binding (resolution layer), (4) a platform-provided credential failing on our side — and only this data distinguishes them. Never classify from the error text alone.`,
        {},
        async () => {
          try {
            return textResult(await client.getFlowCredentialState(flowId));
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'provision_spreadsheet',
        "SETUP-PHASE tool: create a REAL Google spreadsheet with the user's connected Google credential and return its spreadsheetId + URL. Run this during the setup phase, never inside flow code. If it fails because no credential covers Google Sheets, call report_missing_credential.",
        {
          title: z.string().min(1).describe('Spreadsheet title'),
          tabs: z
            .array(z.string().min(1))
            .optional()
            .describe(
              'Initial tab (sheet) names; defaults to a single "Sheet1"'
            ),
        },
        async ({ title, tabs }) => {
          try {
            return textResult(await provisionSpreadsheet(client, title, tabs));
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'seed_rows',
        'SETUP-PHASE tool: write reference/default rows (headers, naming standards, lookup tables) into a tab of an already-provisioned spreadsheet, over the same Google Sheets bubble path flows use. Idempotent: it CLEARS the tab first, then writes the rows at A1, so re-running never duplicates. Build-time only — never seed reference data inside flow handle() code, and never hand the user paste-ready rows instead.',
        {
          spreadsheetId: z
            .string()
            .min(1)
            .describe('Spreadsheet id returned by provision_spreadsheet'),
          tabName: z
            .string()
            .min(1)
            .describe('The tab (sheet) name to seed, e.g. "Standards"'),
          rows: z
            .array(z.array(z.string()))
            .min(1)
            .describe(
              'Rows to write, as an array of string arrays; row 0 is normally the header row'
            ),
        },
        async ({ spreadsheetId, tabName, rows }) => {
          try {
            return textResult(
              await seedRows(client, spreadsheetId, tabName, rows)
            );
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'find_drive_file',
        `SETUP-PHASE tool (FE6): search the user's own connected Google Drive for a file by name/content BEFORE asking them for a link or ID. Call this whenever the user names a resource by description ("my farm temperature spreadsheet", "the sesame field readings sheet") instead of giving you a URL/ID — do not go straight to ask_clarifying_questions for something you can find yourself. Uses the SAME already-authenticated path provision_spreadsheet uses (a real GoogleDriveBubble list_files call through the user's connected credential), not a bespoke search. Returns up to maxResults matches (id, name, mimeType, webViewLink, modifiedTime); empty array means no match, not an error. If exactly one strong match exists, use it directly and tell the user which file you picked in one sentence. If multiple plausible matches exist, or none, call ask_clarifying_questions with the real candidates as choices (label = file name, description = last-modified date) plus the usual free-text "Other" fallback — never silently guess among ambiguous matches. If this fails because no credential covers Drive, call report_missing_credential.`,
        {
          query: z
            .string()
            .min(1)
            .describe(
              "Drive search query, Google Drive query syntax, e.g. \"name contains 'sesame'\" or \"name contains 'inventory' and mimeType contains 'spreadsheet'\""
            ),
          maxResults: z
            .number()
            .min(1)
            .max(50)
            .optional()
            .describe('Maximum matches to return (default 20)'),
        },
        async ({ query, maxResults }) => {
          try {
            return textResult(await findDriveFiles(client, query, maxResults));
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'set_flow_defaults',
        `Persist default_inputs for the flow being built (flow ${flowId}) — the setup phase's final step: store every provisioned resource id (and other known input values) here so the flow remembers its setup as config. Keys must match the flow's inputSchema properties.`,
        {
          defaults: z
            .record(z.string(), z.unknown())
            .describe('Input key -> default value (non-empty object)'),
        },
        async ({ defaults }) => {
          try {
            if (Object.keys(defaults).length === 0) {
              throw new Error(
                'defaults must be non-empty: the validate route ignores an empty defaultInputs object'
              );
            }
            const flow = await client.getFlow(flowId);
            if (flow.code === '') {
              throw new Error(
                `Flow ${flowId} has no code yet; save_flow before set_flow_defaults`
              );
            }
            const result = await client.validateFlow({
              code: flow.code,
              flowId,
              options: {
                includeDetails: true,
                strictMode: true,
                syncInputsWithFlow: true,
              },
              defaultInputs: defaults,
              activateCron: flow.cronActive,
            });
            if (!result.valid) {
              throw new Error(
                `Flow re-validation failed, defaults not saved: ${result.errors?.join('; ') ?? result.error ?? 'unknown'}`
              );
            }
            const updated = await client.getFlow(flowId);
            return textResult({
              status: 'saved',
              flowId,
              default_inputs: updated.defaultInputs,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'test_run_flow',
        `SELF-TEST tool: execute the flow being built (flow ${flowId}) through the SAME path the studio "Test Flow" button uses (POST /bubble-flow/:id/execute-stream), and return the run reduced to: signals (EVERY failure class the studio console surfaces — error/fatal events, failed steps whose result.success is false, HTTP >= 400 responses, run-level failure, plus failed nested ai-agent tools), stepOutcomes (per-step success + outputDigest + emptyOutput), toolCalls (per nested-tool success + outputDigest + emptyOutput), the finalResult, and success. success is true ONLY when the stream completed with ZERO signals — a run can carry failed steps while emitting no error/fatal event, so never judge from the absence of errors alone. Real side effects (HTTP calls, sheet writes, messages) happen — that is expected and acceptable. Call this AFTER save_flow. The build is done ONLY when BOTH hold: (a) a run returns success: true (signal-free), AND (b) you verified the prompt's concrete deliverables against stepOutcomes/toolCalls/finalResult — an emptyOutput on a step or tool that was supposed to produce content means the prompt is NOT fulfilled even on a signal-free run. When signals come back, diagnose from them, fix the code (validate_flow -> save_flow), and run again. Do NOT run while a required credential is missing — take the report_missing_credential path instead.`,
        {
          inputs: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Payload inputs for this run, merged over the flow's saved default_inputs. Omit to run with the defaults alone."
            ),
        },
        async ({ inputs }) => {
          try {
            const flow = await client.getFlow(flowId);
            if (flow.code === '') {
              throw new Error(
                `Flow ${flowId} has no saved code yet; save_flow before test_run_flow`
              );
            }
            const payload = { ...flow.defaultInputs, ...(inputs ?? {}) };
            const summary = await client.executeFlowStream(flowId, payload);
            const primaryOutputWarning = summary.success
              ? primaryOutputDriftWarning(flow.metadata, summary.finalResult)
              : null;
            return textResult(
              primaryOutputWarning !== null
                ? { ...summary, primaryOutputWarning }
                : summary
            );
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      // KIV: throttle rename to prevent abuse
      tool(
        'rename_flow',
        `Rename a flow: writes the name to the backend (PATCH /bubble-flow/:id/name); the studio picks it up on its next refetch. Call ONCE at build completion with a concise human-friendly title, or whenever the user explicitly asks for a rename. Never claim a rename happened without calling this tool.`,
        {
          flowId: z
            .number()
            .int()
            .positive()
            .describe(`BubbleFlow id (the flow being built is ${flowId})`),
          name: z
            .string()
            .min(1)
            .max(100)
            .describe(
              'The new flow name: a short human-friendly title (max 100 chars), not the raw prompt'
            ),
        },
        async (args) => {
          try {
            await client.renameFlow(args.flowId, args.name);
            return textResult({
              status: 'renamed',
              flowId: args.flowId,
              name: args.name,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'set_primary_output',
        `Register the flow's HEADLINE OUTPUT — the one result the user most wants to see after each run (flow ${flowId}). Call ONCE, after test_run_flow returns success: true (and again ONLY if a later fix changes the registered key(s)). INVARIANT: handle() must return an object, and every key you register here MUST be a top-level property of that return object, so the value is always defined on a successful run. kind='artefact' = the flow produces a linkable thing (doc/sheet/file) — register artefactKey, the key whose value IS the link URL. kind='process' = something happened with no artefact (e.g. "emailed the digest") — register outcomeKeys, the keys whose values state in plain language what happened. kind='both' = register both. The label is shown to a non-technical user: plain words in their vocabulary, never key names or jargon.`,
        {
          kind: z
            .enum(['artefact', 'process', 'both'])
            .describe(
              "'artefact' = a produced thing with a link; 'process' = a stated outcome with no artefact; 'both' = link plus outcomes"
            ),
          label: z
            .string()
            .min(1)
            .max(80)
            .describe(
              'Plain-language user-facing label for the result (max 80 chars), e.g. "Your weekly digest"'
            ),
          artefactKey: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Top-level handle() return key whose value is the artefact link URL; REQUIRED when kind is 'artefact' or 'both'"
            ),
          outcomeKeys: z
            .array(z.string().min(1))
            .optional()
            .describe(
              "Top-level handle() return keys whose values state what happened; REQUIRED (non-empty) when kind is 'process' or 'both'"
            ),
        },
        async ({ kind, label, artefactKey, outcomeKeys }) => {
          try {
            const primaryOutput: PrimaryOutput = primaryOutputSchema.parse({
              kind,
              label,
              ...(artefactKey !== undefined ? { artefactKey } : {}),
              ...(outcomeKeys !== undefined ? { outcomeKeys } : {}),
            });
            await client.setPrimaryOutput(flowId, primaryOutput);
            return textResult({
              status: 'registered',
              flowId,
              primaryOutput,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      makeReportMissingCredentialTool(flowId, 'flow'),
      makeAskClarifyingQuestionsTool(flowId, 'flow'),
      makeRememberDefaultTool(userId, flowId, 'flow'),
    ],
  });
}

/**
 * The page-builder agent's tool server (agentKind 'page'). The write tools
 * (create_page / update_page) persist a validated page SPEC onto the pages
 * row being built — the agent never produces or stores free-form code. Reads
 * for binding discovery go through read_sheet_range, which rides the same
 * bubble/flow rails the render endpoint uses.
 */
export function createPageServer(
  pageId: number,
  userId: string
): McpSdkServerConfigWithInstance {
  const client = new GluuClient(config.gluuApiUrl);

  const pageSpecInput = {
    spec: pageSpecSchema.describe(
      'The full page spec: {version: 1, title, description?, widgets: [...]}. Widget kinds: table {id, type:"table", title, source:{kind:"google_sheet_range", spreadsheetId, range}, headerRow?, maxRows?}, metric {id, type:"metric", title, source, aggregate:"count_rows", excludeHeaderRow?}, form {id, type:"form", title, target:{kind:"google_sheet_append", spreadsheetId, range}, fields:[{name,label,placeholder?}], submitLabel?}.'
    ),
  };

  return createSdkMcpServer({
    name: 'builder',
    version: '0.1.0',
    tools: [
      makeGetBubbleDetailsTool(),
      makeSearchBubblesTool(),
      makeListFlowsTool(client),

      tool(
        'get_flow',
        "Read one flow's details — most usefully its default_inputs, which hold the REAL resource ids (e.g. spreadsheet_id) that flow was set up with. Use this to find the spreadsheet a user's existing automation already writes to.",
        {
          flowId: z.number().int().positive().describe('BubbleFlow id'),
        },
        async (args) => {
          try {
            const flow = await client.getFlow(args.flowId);
            return textResult({
              id: flow.id,
              name: flow.name,
              description: flow.description,
              eventType: flow.eventType,
              inputSchema: flow.inputSchema,
              defaultInputs: flow.defaultInputs,
              requiredCredentials: flow.requiredCredentials,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'list_integrations',
        "List the user's connected integrations (credential type, OAuth provider, granted scopes). Use this FIRST to learn which data sources the page can bind to; if a needed integration is absent, call report_missing_credential.",
        {},
        async () => {
          try {
            const credentials = await client.listCredentials();
            return textResult(
              credentials.map((credential) => ({
                id: credential.id,
                credentialType: credential.credentialType,
                name: credential.name ?? null,
                oauthProvider: credential.oauthProvider ?? null,
                oauthScopes: credential.oauthScopes ?? null,
              }))
            );
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'read_sheet_range',
        "Read real values from the user's spreadsheet over their connected Google credential — the same path page rendering uses. Call this BEFORE authoring a binding, to confirm the spreadsheet id, tab name, and actual column layout. Returns at most the first 20 rows plus the total row count.",
        {
          spreadsheetId: z.string().min(1).describe('Spreadsheet id'),
          range: z
            .string()
            .min(1)
            .describe(
              'A1-notation range or bare tab name, e.g. "Feedback" or "Feedback!A1:C20"'
            ),
        },
        async ({ spreadsheetId, range }) => {
          try {
            const { values, range: readRange } = await readSheetRange(client, {
              kind: 'google_sheet_range',
              spreadsheetId,
              range,
            });
            return textResult({
              range: readRange,
              totalRows: values.length,
              rows: values.slice(0, 20),
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'create_page',
        `Persist the page spec onto the page being built (page ${pageId}) and mark it ready. The spec is validated; a page is ONLY this spec — there is no page code. Read the real data first (read_sheet_range) so every binding targets a spreadsheet/tab/columns that exist.`,
        pageSpecInput,
        async ({ spec }) => {
          try {
            const row = await getPageRow(pageId);
            if (row === null) {
              throw new Error(
                `Page ${pageId} does not exist; it must be created via the studio first`
              );
            }
            await db
              .update(pages)
              .set({
                title: spec.title,
                spec,
                status: 'ready',
                updatedAt: new Date(),
              })
              .where(eq(pages.id, pageId));
            return textResult({
              status: 'saved',
              pageId,
              title: spec.title,
              widgets: spec.widgets.map((w) => ({
                id: w.id,
                type: w.type,
                title: w.title,
              })),
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'update_page',
        `Replace the stored spec of the page being built (page ${pageId}) with a corrected/extended version. Same validation as create_page.`,
        pageSpecInput,
        async ({ spec }) => {
          try {
            const row = await getPageRow(pageId);
            if (row === null) throw new Error(`Page ${pageId} does not exist`);
            await db
              .update(pages)
              .set({
                title: spec.title,
                spec,
                status: 'ready',
                updatedAt: new Date(),
              })
              .where(eq(pages.id, pageId));
            return textResult({ status: 'updated', pageId, title: spec.title });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      tool(
        'get_page',
        `Read the page being built (page ${pageId}): its title, status, and stored spec.`,
        {},
        async () => {
          try {
            const row = await getPageRow(pageId);
            if (row === null) throw new Error(`Page ${pageId} does not exist`);
            return textResult({
              id: row.id,
              title: row.title,
              status: row.status,
              spec: row.spec ?? null,
              specValid: parseStoredSpec(row) !== null,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),

      makeReportMissingCredentialTool(pageId, 'page'),
      makeRememberDefaultTool(userId, pageId, 'page'),
    ],
  });
}

/**
 * All build threads currently blocked_on_credential, both agent kinds (FE1:
 * the /internal/credentials-changed scan). No credential-type pre-filtering
 * here by design — tryResolveDeferredSetup owns the suite-credential matching
 * and is the single authority on whether a gap is satisfied.
 */
export async function listBlockedThreads() {
  return db
    .select()
    .from(buildThreads)
    .where(eq(buildThreads.status, 'blocked_on_credential'));
}

/** Read the persisted build-thread row for a build subject (session id, status, deferred setup). */
export async function getBuildThread(subjectId: number, kind: AgentKind) {
  const rows = await db
    .select()
    .from(buildThreads)
    .where(
      and(
        eq(buildThreads.subjectId, subjectId),
        eq(buildThreads.agentKind, kind)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
