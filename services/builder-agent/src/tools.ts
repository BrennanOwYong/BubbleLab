/**
 * In-process MCP `builder` server: the flow-builder agent's only tools.
 * Every tool is a thin typed wrapper over the Bun API at GLUU_API_URL
 * (adapted from gluu-mcp/src/index.ts); nothing re-implements server logic.
 *
 * get_bubble_details relies on the Phase-4 endpoint
 * GET /bubble-flow/bubble-details/:bubbleName added to the Bun API (it wraps
 * bubble-core's GetBubbleDetailsTool, the same tool Pearl used in-process).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { GluuClient } from './gluu-client.ts';
import { provisionSpreadsheet } from './provision.ts';
import { buildThreads, db } from './db.ts';
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

export function createBuilderServer(
  flowId: number
): McpSdkServerConfigWithInstance {
  const client = new GluuClient(config.gluuApiUrl);

  return createSdkMcpServer({
    name: 'builder',
    version: '0.1.0',
    tools: [
      tool(
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
      ),

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

      tool(
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
        'report_missing_credential',
        'CREDENTIAL-GAP tool: call when a setup action needs a credential type the user has not connected. Persists the deferred setup script on the build thread and marks the flow blocked, so the setup runs once the credential exists. Then tell the user, naming the exact provider/credential to connect. Never fabricate resource ids instead.',
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
                    "The flow input key the resulting id must be stored under via set_flow_defaults, e.g. 'spreadsheet_id'"
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
                flowId,
                status: 'blocked_on_credential',
                deferredSetup: deferred,
              })
              .onConflictDoUpdate({
                target: buildThreads.flowId,
                set: {
                  status: 'blocked_on_credential',
                  deferredSetup: deferred,
                  updatedAt: new Date(),
                },
              });
            // MVP alert: mark + log; the user-facing alert is the agent's own
            // chat message naming the credential (no webhook yet).
            console.error(
              `[credential-gap] flow ${flowId} blocked on ${credentialType}; deferred setup script persisted`
            );
            return textResult({
              status: 'persisted',
              flowId,
              credentialType,
              deferredSetupScript,
              userAction: `Connect ${credentialType} in Settings -> Credentials; the deferred setup will run once it exists.`,
            });
          } catch (error) {
            return errorResult(error);
          }
        }
      ),
    ],
  });
}

/** Read the persisted build-thread row for a flow (session id, status, deferred setup). */
export async function getBuildThread(flowId: number) {
  const rows = await db
    .select()
    .from(buildThreads)
    .where(eq(buildThreads.flowId, flowId))
    .limit(1);
  return rows[0] ?? null;
}
