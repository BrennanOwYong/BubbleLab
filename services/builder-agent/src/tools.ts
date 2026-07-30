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
import { GluuClient } from './gluu-client.ts';
import { provisionSpreadsheet, seedRows } from './provision.ts';
import { readSheetRange, getPageRow, parseStoredSpec } from './page-data.ts';
import { pageSpecSchema } from './page-spec.ts';
import type { AgentKind } from './prompts.ts';
import { buildThreads, db, pages } from './db.ts';
import { config } from './config.ts';

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
          throw new Error(
            `bubble-details ${bubbleName} -> HTTP ${response.status}: ${text.slice(0, 300)}`
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

export function createBuilderServer(
  flowId: number
): McpSdkServerConfigWithInstance {
  const client = new GluuClient(config.gluuApiUrl);

  return createSdkMcpServer({
    name: 'builder',
    version: '0.1.0',
    tools: [
      makeGetBubbleDetailsTool(),

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
        `SELF-TEST tool: execute the flow being built (flow ${flowId}) through the SAME path the studio "Test Flow" button uses (POST /bubble-flow/:id/execute-stream), and return the same outcome the user sees in the run popup: every error/fatal event (with the failing bubble and message), the final result, and success. Real side effects (HTTP calls, sheet writes, messages) happen — that is expected and acceptable. Call this AFTER save_flow; the build is done ONLY once a run returns success: true. When errors come back, diagnose from them, fix the code (validate_flow -> save_flow), and run again. Do NOT run while a required credential is missing — take the report_missing_credential path instead.`,
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
            return textResult(await client.executeFlowStream(flowId, payload));
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

      makeReportMissingCredentialTool(flowId, 'flow'),
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
  pageId: number
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
    ],
  });
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
