/**
 * Setup provisioning + build-completion messaging for the generate route.
 *
 * PROVISIONING: a plan can declare resources that must be created just for
 * this flow (plan.setupResources on the Coffee plan — canonical case: a
 * Google Sheet the flow pipes answers into). After a successful build this
 * module creates each declared resource with the creator's connected
 * credential (reusing the existing GoogleSheetsBubble create_spreadsheet
 * operation — no new Google client) and returns the created id keyed by the
 * resource's target inputKey. The route persists those ids into
 * bubble_flows.default_inputs, the structure the Setup form reads, so the
 * field arrives prefilled with a real id and the first run cannot fail on a
 * missing spreadsheet.
 *
 * Guarantees:
 * - Idempotent: a key that already has a value in defaultInputs, or a prior
 *   provisioning record with a resourceId, is never re-created.
 * - Non-blocking: every failure is caught, recorded on the provisioning
 *   record, and leaves the field blank — generation never crashes or blocks
 *   on provisioning.
 *
 * DONE MESSAGE: buildWorkflowDoneMessage shapes the programmatic system
 * message the route appends to metadata.conversationMessages when a build
 * finishes, carrying a persisted Date.now() timestamp (proof of build
 * duration) and, when required inputs are still missing, the Setup field
 * descriptors the studio form renders.
 *
 * References (Sheets create semantics implemented by the reused bubble):
 * - https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create
 *   (see packages/bubble-core/.../google-sheets.metadata.ts References block)
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { derivedCredentials, userCredentials } from '../db/schema.js';
import {
  CredentialType,
  type ConversationEntry,
  type SetupFieldDescriptor,
  type SetupResource,
  type WorkflowDoneMessage,
} from '@bubblelab/shared-schemas';
import { GoogleSheetsBubble } from '@bubblelab/bubble-core';
import { oauthService } from './oauth-service.js';

/** Provenance record persisted at metadata.setupProvisioning[inputKey]. */
export interface SetupProvisioningRecord {
  kind: SetupResource['kind'];
  status: 'created' | 'failed' | 'skipped_no_credential';
  title: string;
  /** Real id of the created resource (spreadsheetId for google_spreadsheet). */
  resourceId?: string;
  /** Direct link to the created resource when the API returned one. */
  url?: string;
  /** The token-holding credential row used to create the resource. */
  credentialId?: number;
  error?: string;
  provisionedAt: string;
}

export type SetupProvisioningState = Record<string, SetupProvisioningRecord>;

export interface ProvisionOutcome {
  /** inputKey -> created resource id; merge into bubble_flows.default_inputs. */
  defaultInputs: Record<string, string>;
  /** inputKey -> provenance; merge into metadata.setupProvisioning. */
  provisioning: SetupProvisioningState;
}

/**
 * The trigger signal: the latest plan message in the conversation that
 * declares setupResources. The Coffee planner emits plan.setupResources when
 * the plan needs an item created just for this flow (the planner prompt owns
 * instructing the model; this schema field is where the declaration lands).
 */
export function extractSetupResources(
  messages: ConversationEntry[] | undefined
): SetupResource[] {
  if (!messages) return [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ('type' in message && message.type === 'plan') {
      return message.plan.setupResources ?? [];
    }
  }
  return [];
}

/**
 * The credential used to create resources: the user's most recently connected
 * GOOGLE_SHEETS_CRED row, else the most recently connected parent credential
 * whose derived record covers GOOGLE_SHEETS_CRED (e.g. a Drive credential
 * granting Sheets scope) — the same exact-then-derived recency rule
 * credential-auto-bind uses, so provisioning and execution pick the same
 * credential for the same state.
 */
export async function resolveSheetsCredentialId(
  userId: string
): Promise<number | undefined> {
  const exact = await db
    .select({ id: userCredentials.id })
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        eq(userCredentials.credentialType, CredentialType.GOOGLE_SHEETS_CRED)
      )
    )
    .orderBy(desc(userCredentials.createdAt), desc(userCredentials.id))
    .limit(1);
  if (exact[0]) return exact[0].id;

  const derived = await db
    .select({ parentCredentialId: derivedCredentials.parentCredentialId })
    .from(derivedCredentials)
    .innerJoin(
      userCredentials,
      eq(derivedCredentials.parentCredentialId, userCredentials.id)
    )
    .where(
      and(
        eq(derivedCredentials.userId, userId),
        eq(
          derivedCredentials.derivedCredentialType,
          CredentialType.GOOGLE_SHEETS_CRED
        )
      )
    )
    .orderBy(desc(userCredentials.createdAt), desc(userCredentials.id))
    .limit(1);
  return derived[0]?.parentCredentialId;
}

/** Result of one create call; injectable so tests never touch the network. */
export interface CreatedResource {
  resourceId: string;
  url?: string;
}

export type ResourceCreator = (
  resource: SetupResource,
  accessToken: string
) => Promise<CreatedResource>;

/**
 * Default creator: the existing GoogleSheetsBubble create_spreadsheet
 * operation with the user's OAuth token.
 */
export const createGoogleSpreadsheet: ResourceCreator = async (
  resource,
  accessToken
) => {
  const bubble = new GoogleSheetsBubble({
    operation: 'create_spreadsheet',
    title: resource.title,
    ...(resource.sheetTitles && resource.sheetTitles.length > 0
      ? { sheet_titles: resource.sheetTitles }
      : {}),
    credentials: { [CredentialType.GOOGLE_SHEETS_CRED]: accessToken },
  });
  const result = await bubble.action();
  const spreadsheet = result.data?.spreadsheet;
  if (!result.success || !spreadsheet?.spreadsheetId) {
    throw new Error(
      result.error || result.data?.error || 'Spreadsheet creation failed'
    );
  }
  return {
    resourceId: spreadsheet.spreadsheetId,
    url: spreadsheet.spreadsheetUrl,
  };
};

/**
 * Create every declared resource that does not already have an id. Never
 * throws: failures degrade to a blank field plus a provenance record with the
 * error, so the Setup form asks the user instead of the run crashing.
 */
export async function provisionSetupResources(
  userId: string,
  resources: SetupResource[],
  existingDefaultInputs: Record<string, unknown>,
  existingProvisioning: SetupProvisioningState,
  creator: ResourceCreator = createGoogleSpreadsheet
): Promise<ProvisionOutcome> {
  const outcome: ProvisionOutcome = { defaultInputs: {}, provisioning: {} };
  if (resources.length === 0) return outcome;

  for (const resource of resources) {
    const key = resource.inputKey;
    // Idempotency: an id already recorded for this field (from a prior
    // generation or a user-entered value) is never re-created.
    const existingValue = existingDefaultInputs[key];
    if (typeof existingValue === 'string' && existingValue.length > 0) continue;
    if (existingProvisioning[key]?.resourceId) {
      // The record exists but defaultInputs lost the value — re-assert it.
      outcome.defaultInputs[key] = existingProvisioning[key].resourceId;
      continue;
    }

    const base = {
      kind: resource.kind,
      title: resource.title,
      provisionedAt: new Date().toISOString(),
    };
    try {
      const credentialId = await resolveSheetsCredentialId(userId);
      if (!credentialId) {
        outcome.provisioning[key] = {
          ...base,
          status: 'skipped_no_credential',
          error:
            'No connected Google Sheets credential; connect one and re-generate or fill the field manually',
        };
        continue;
      }
      const accessToken = await oauthService.getValidToken(credentialId);
      if (!accessToken) {
        outcome.provisioning[key] = {
          ...base,
          status: 'failed',
          credentialId,
          error: 'Could not obtain a valid OAuth token for the credential',
        };
        continue;
      }
      const created = await creator(resource, accessToken);
      outcome.defaultInputs[key] = created.resourceId;
      outcome.provisioning[key] = {
        ...base,
        status: 'created',
        resourceId: created.resourceId,
        url: created.url,
        credentialId,
      };
      console.debug(
        `[SetupProvisioning] Created ${resource.kind} '${resource.title}' -> ${key}=${created.resourceId}`
      );
    } catch (error) {
      outcome.provisioning[key] = {
        ...base,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      console.error(
        `[SetupProvisioning] Failed to create ${resource.kind} for input '${key}':`,
        error
      );
    }
  }
  return outcome;
}

/** "spreadsheetId" -> "Spreadsheet Id"; "sheet_name" -> "Sheet Name". */
export function humanizeInputKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Minimal JSON-schema surface of bubble_flows.input_schema. header/hint/
 * fromUserProfile are lifted from the payload interface's @header/@hint/
 * @fromUserProfile JSDoc tags by BubbleParser.
 */
interface FlowInputSchema {
  properties?: Record<
    string,
    {
      type?: string;
      description?: string;
      header?: string;
      hint?: string;
      fromUserProfile?: string;
    }
  >;
  required?: string[];
}

export interface SetupFieldSummary {
  /** Every flow input as a Setup form descriptor, known values filled. */
  fields: SetupFieldDescriptor[];
  /** The subset of required inputs with no known value. */
  missingRequired: SetupFieldDescriptor[];
}

/**
 * Field descriptors { key, header, hint, value?, fromUserProfile? } for the
 * Setup form, built from the flow's input JSON schema plus the known
 * defaults (provisioned ids, user-saved defaultInputs, profile values).
 * header/hint prefer the schema's JSDoc-lifted tags and fall back to
 * key-humanization/property description. value is omitted for unfilled
 * fields.
 */
export function buildSetupFieldDescriptors(
  inputSchema: unknown,
  defaultInputs: Record<string, unknown>
): SetupFieldSummary {
  const schema = (inputSchema ?? {}) as FlowInputSchema;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const fields: SetupFieldDescriptor[] = [];
  const missingRequired: SetupFieldDescriptor[] = [];
  for (const [key, property] of Object.entries(properties)) {
    const known = defaultInputs[key];
    const value =
      known === undefined || known === null || known === ''
        ? undefined
        : String(known);
    const fromUserProfile =
      property.fromUserProfile === 'email' ||
      property.fromUserProfile === 'telegramChatId'
        ? property.fromUserProfile
        : undefined;
    const descriptor: SetupFieldDescriptor = {
      key,
      header: property.header ?? humanizeInputKey(key),
      hint: property.hint ?? property.description ?? '',
      ...(value !== undefined ? { value } : {}),
      ...(fromUserProfile !== undefined ? { fromUserProfile } : {}),
    };
    fields.push(descriptor);
    if (required.has(key) && value === undefined) {
      missingRequired.push(descriptor);
    }
  }
  return { fields, missingRequired };
}

/**
 * The programmatic build-completion message, discriminated on role+kind (NOT
 * the CoffeeMessage `type` field — the studio's renderer matches this exact
 * shape). timestampMs (Date.now() ms) is persisted with the message —
 * durable proof of when the build finished.
 * - every required input known -> kind 'workflow-done'
 * - required inputs missing -> kind 'workflow-done-needs-info' with the FULL
 *   field list (known values included) so the form renders complete.
 */
export function buildWorkflowDoneMessage(
  summary: SetupFieldSummary,
  timestampMs: number
): WorkflowDoneMessage {
  const needsInfo = summary.missingRequired.length > 0;
  return needsInfo
    ? {
        role: 'system',
        kind: 'workflow-done-needs-info',
        timestampMs,
        text: 'Workflow done, but I still need some information',
        fields: summary.fields,
      }
    : {
        role: 'system',
        kind: 'workflow-done',
        timestampMs,
        text: 'Workflow done! Check it out now',
      };
}
