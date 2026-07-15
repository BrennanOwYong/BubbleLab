/**
 * Backfill script: doc-grounded per-operation side-effect metadata (IR-8).
 *
 * Repeatable mechanism, not hand-typing: for each target bubble the script walks the params
 * schema's discriminated union on `operation`, gathers documentation prose for each operation
 * (curated vendor-doc quote first, the operation's own `.describe()` prose as fallback), runs the
 * deterministic doc classifier (`src/utils/side-effect-classifier.ts` — the HTTP method is never
 * the signal), and emits a colocated, reviewable
 * `src/bubbles/service-bubble/<name>.metadata.ts` file exporting a typed
 * `BubbleOperationMetadata` map. Every emitted classification carries a non-empty source +
 * citation. Operations with no doc signal fail safe to `write` with `unverified: true`.
 *
 * Run (after `pnpm build:types`):
 *   pnpm --filter @bubblelab/bubble-core backfill:operation-metadata
 *
 * The generated files are committed and imported by each bubble class as its static
 * `operationMetadata` — colocated per integration, no central registry location.
 *
 * ## References (vendor doc roots used for citations; verified 2026-07-15)
 * - Resend:          https://resend.com/docs/api-reference/emails/send-email
 * - Gmail:           https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
 * - Google Calendar: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
 * - Google Drive:    https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy
 * - GitHub REST:     https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
 * - Airtable:        https://airtable.com/developers/web/api/create-records
 */

import { writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { BubbleFactory } from '../dist/bubble-factory.js';
import {
  classifySideEffect,
  ClassificationError,
  type SideEffectEvidence,
} from '../dist/utils/side-effect-classifier.js';
import {
  OperationSideEffectMetadataSchema,
  type BubbleName,
  type OperationSideEffectMetadata,
} from '@bubblelab/shared-schemas';

interface OperationCitation {
  /** Deep link to the vendor's reference page for this exact operation. */
  url: string;
  /** The vendor's own description of the operation (the prose the classifier reads). */
  quote: string;
}

interface BubbleDocSource {
  /** Vendor API reference root, recorded in fallback citations. */
  docRoot: string;
  operations: Record<string, OperationCitation>;
}

/**
 * Curated vendor-doc citations per bubble/operation. The quote is the classification input;
 * the URL makes the claim auditable. Missing entries fall back to the operation's schema
 * `.describe()` prose (still cited, lower trust).
 */
const VENDOR_DOCS: Partial<Record<BubbleName, BubbleDocSource>> = {
  resend: {
    docRoot: 'https://resend.com/docs/api-reference/emails',
    operations: {
      send_email: {
        url: 'https://resend.com/docs/api-reference/emails/send-email',
        quote: 'Start sending emails through the Resend Email API.',
      },
      send_batch_emails: {
        url: 'https://resend.com/docs/api-reference/emails/send-batch-emails',
        quote: 'Trigger up to 100 batch emails at once.',
      },
      get_email_status: {
        url: 'https://resend.com/docs/api-reference/emails/retrieve-email',
        quote: 'Retrieve a single email.',
      },
    },
  },
  gmail: {
    docRoot:
      'https://developers.google.com/workspace/gmail/api/reference/rest/v1',
    operations: {
      send_email: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send',
        quote:
          'Sends the specified message to the recipients in the To, Cc, and Bcc headers.',
      },
      get_email: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get',
        quote: 'Gets the specified message.',
      },
      list_emails: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list',
        quote: "Lists the messages in the user's mailbox.",
      },
      search_emails: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list',
        quote: "Lists the messages in the user's mailbox.",
      },
      delete_email: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete',
        quote:
          'Immediately and permanently deletes the specified message. This operation cannot be undone.',
      },
      trash_email: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash',
        quote: 'Moves the specified message to the trash.',
      },
      get_attachment: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get',
        quote: 'Gets the specified message attachment.',
      },
      mark_as_read: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify',
        quote: 'Modifies the labels on the specified message.',
      },
      mark_as_unread: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify',
        quote: 'Modifies the labels on the specified message.',
      },
      modify_message_labels: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify',
        quote: 'Modifies the labels on the specified message.',
      },
      modify_thread_labels: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/modify',
        quote:
          'Modifies the labels applied to the thread. This applies to all messages in the thread.',
      },
      create_draft: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create',
        quote: 'Creates a new draft with the DRAFT label.',
      },
      send_draft: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send',
        quote:
          'Sends the specified, existing draft to the recipients in the To, Cc, and Bcc headers.',
      },
      list_drafts: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list',
        quote: "Lists the drafts in the user's mailbox.",
      },
      list_threads: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list',
        quote: "Lists the threads in the user's mailbox.",
      },
      list_labels: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/list',
        quote: "Lists all labels in the user's mailbox.",
      },
      create_label: {
        url: 'https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create',
        quote: 'Creates a new label.',
      },
    },
  },
  'google-calendar': {
    docRoot:
      'https://developers.google.com/workspace/calendar/api/v3/reference',
    operations: {
      list_events: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/list',
        quote: 'Returns events on the specified calendar.',
      },
      get_event: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/get',
        quote: 'Returns an event based on its Google Calendar ID.',
      },
      create_event: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/insert',
        quote: 'Creates an event.',
      },
      update_event: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/update',
        quote: 'Updates an event.',
      },
      delete_event: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/events/delete',
        quote: 'Deletes an event.',
      },
      list_calendars: {
        url: 'https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list',
        quote: "Returns the calendars on the user's calendar list.",
      },
    },
  },
  'google-drive': {
    docRoot:
      'https://developers.google.com/workspace/drive/api/reference/rest/v3',
    operations: {
      upload_file: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create',
        quote: 'Creates a new file.',
      },
      download_file: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get',
        quote: "Gets a file's metadata or content by ID.",
      },
      list_files: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list',
        quote: "Lists the user's files.",
      },
      create_folder: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create',
        quote: 'Creates a new file.',
      },
      delete_file: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete',
        quote:
          'Permanently deletes a file owned by the user without moving it to the trash.',
      },
      get_file_info: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get',
        quote: "Gets a file's metadata or content by ID.",
      },
      share_file: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create',
        quote: 'Creates a permission for a file or shared drive.',
      },
      move_file: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update',
        quote: "Updates a file's metadata and/or content.",
      },
      copy_doc: {
        url: 'https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy',
        quote:
          'Creates a copy of a file and applies any requested updates with patch semantics.',
      },
      get_doc: {
        url: 'https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get',
        quote: 'Gets the latest version of the specified document.',
      },
      update_doc: {
        url: 'https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate',
        quote: 'Applies one or more updates to the document.',
      },
      replace_text: {
        url: 'https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate',
        quote: 'Applies one or more updates to the document.',
      },
    },
  },
  github: {
    docRoot: 'https://docs.github.com/en/rest',
    operations: {
      create_issue: {
        url: 'https://docs.github.com/en/rest/issues/issues#create-an-issue',
        quote:
          'Create an issue. Any user with pull access to a repository can create an issue.',
      },
      create_issue_comment: {
        url: 'https://docs.github.com/en/rest/issues/comments#create-an-issue-comment',
        quote:
          'Create an issue comment. You can use the REST API to create comments on issues and pull requests.',
      },
      create_pr_comment: {
        url: 'https://docs.github.com/en/rest/issues/comments#create-an-issue-comment',
        quote:
          'Create an issue comment. You can use the REST API to create comments on issues and pull requests.',
      },
      get_file: {
        url: 'https://docs.github.com/en/rest/repos/contents#get-repository-content',
        quote: 'Gets the contents of a file or directory in a repository.',
      },
      get_directory: {
        url: 'https://docs.github.com/en/rest/repos/contents#get-repository-content',
        quote: 'Gets the contents of a file or directory in a repository.',
      },
      get_pull_request: {
        url: 'https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request',
        quote:
          'Get a pull request. Lists details of a pull request by providing its number.',
      },
      get_repository: {
        url: 'https://docs.github.com/en/rest/repos/repos#get-a-repository',
        quote: 'Get a repository.',
      },
      list_issues: {
        url: 'https://docs.github.com/en/rest/issues/issues#list-repository-issues',
        quote: 'List issues in a repository. Only open issues will be listed.',
      },
      list_pull_requests: {
        url: 'https://docs.github.com/en/rest/pulls/pulls#list-pull-requests',
        quote:
          'List pull requests. Lists pull requests in a specified repository.',
      },
      list_repositories: {
        url: 'https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user',
        quote:
          'List repositories for the authenticated user. Lists repositories that the authenticated user has explicit permission to access.',
      },
    },
  },
  airtable: {
    docRoot: 'https://airtable.com/developers/web/api',
    operations: {
      list_records: {
        url: 'https://airtable.com/developers/web/api/list-records',
        quote: 'List records in a table.',
      },
      get_record: {
        url: 'https://airtable.com/developers/web/api/get-record',
        quote: 'Retrieve a single record.',
      },
      create_records: {
        url: 'https://airtable.com/developers/web/api/create-records',
        quote: 'Creates multiple records.',
      },
      update_records: {
        url: 'https://airtable.com/developers/web/api/update-multiple-records',
        quote:
          'Updates up to 10 records, or upserts them when performUpsert is set.',
      },
      delete_records: {
        url: 'https://airtable.com/developers/web/api/delete-multiple-records',
        quote: 'Deletes records given an array of record ids.',
      },
      list_bases: {
        url: 'https://airtable.com/developers/web/api/list-bases',
        quote: 'Returns the list of bases the token can access.',
      },
      get_base_schema: {
        url: 'https://airtable.com/developers/web/api/get-base-schema',
        quote: 'Returns the schema of the tables in the specified base.',
      },
      create_table: {
        url: 'https://airtable.com/developers/web/api/create-table',
        quote:
          'Creates a new table and returns the schema for the newly created table.',
      },
      update_table: {
        url: 'https://airtable.com/developers/web/api/update-table',
        quote: 'Updates the name and/or description of a table.',
      },
      create_field: {
        url: 'https://airtable.com/developers/web/api/create-field',
        quote:
          'Creates a new column and returns the schema for the newly created column.',
      },
      update_field: {
        url: 'https://airtable.com/developers/web/api/update-field',
        quote: 'Updates the name and/or description of a field.',
      },
    },
  },
};

const TARGET_BUBBLES = Object.keys(VENDOR_DOCS) as BubbleName[];

interface ExtractedOperation {
  operation: string;
  description?: string;
}

/** Walk a params schema and pull each operation literal + its `.describe()` prose. */
function extractOperations(schema: unknown): ExtractedOperation[] {
  const operations: ExtractedOperation[] = [];
  if (!schema || typeof schema !== 'object' || !('_def' in schema)) {
    return operations;
  }
  const def = (schema as z.ZodTypeAny)._def;
  if (def.typeName !== 'ZodDiscriminatedUnion') return operations;
  const discriminator = def.discriminator as string;
  for (const option of def.options as z.ZodTypeAny[]) {
    if (!option || typeof option !== 'object' || !('shape' in option)) {
      continue;
    }
    const shape = (option as z.ZodObject<z.ZodRawShape>).shape;
    const discriminatorField = shape[discriminator];
    if (!discriminatorField) continue;
    const literalDef = (discriminatorField as z.ZodTypeAny)._def;
    if (literalDef.typeName !== 'ZodLiteral') continue;
    operations.push({
      operation: String(literalDef.value),
      description: literalDef.description,
    });
  }
  return operations;
}

function classifyOperation(
  bubbleName: BubbleName,
  op: ExtractedOperation,
  docSource: BubbleDocSource
): OperationSideEffectMetadata {
  const evidence: SideEffectEvidence[] = [];
  const citation = docSource.operations[op.operation];
  if (citation) {
    evidence.push({
      kind: 'prose',
      docText: citation.quote,
      citation: `${citation.url} — "${citation.quote}"`,
    });
  }
  if (op.description && op.description.trim().length > 0) {
    evidence.push({
      kind: 'prose',
      docText: op.description,
      citation: `packages/bubble-core/src/bubbles/service-bubble/${bubbleName}.ts#operation:${op.operation} — "${op.description}" (schema prose; vendor doc root: ${docSource.docRoot})`,
    });
  }
  try {
    return classifySideEffect(evidence);
  } catch (error) {
    if (!(error instanceof ClassificationError)) throw error;
    // Fail-safe: no doc signal → 'write', conservative destructive default
    // (mirrors the MCP spec default destructiveHint ?? true), flagged unverified.
    return {
      sideEffect: 'write',
      destructive: true,
      idempotent: false,
      confidence: 0.2,
      source: 'manual',
      citation: `UNVERIFIED — no doc signal found for operation '${op.operation}'; fail-safe write default pending human review (vendor doc root: ${docSource.docRoot})`,
      unverified: true,
    };
  }
}

function toConstantCase(bubbleName: string): string {
  return bubbleName.replace(/-/g, '_').toUpperCase();
}

function renderMetadataFile(
  bubbleName: BubbleName,
  entries: Record<string, OperationSideEffectMetadata>
): string {
  const constName = `${toConstantCase(bubbleName)}_OPERATION_METADATA`;
  const body = JSON.stringify(entries, null, 2)
    // JSON → TS: quote keys only when needed, keep string values quoted
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:');
  return `/**
 * Doc-grounded per-operation side-effect metadata for the '${bubbleName}' bubble (IR-8).
 *
 * GENERATED by scripts/backfill-operation-metadata.ts — regenerate with:
 *   pnpm --filter @bubblelab/bubble-core backfill:operation-metadata
 * Review the citations when the vendor API or the bubble's operations change; do not edit the
 * classifications without updating the citation that grounds them.
 *
 * Binding rule: 'write' iff the docs say the operation CREATES A NEW RECORD (even as a side
 * effect); 'read_with_side_effects' when the docs indicate mutation without record creation
 * (update/delete/mark — 'destructive' carries the delete signal); 'read' when the docs indicate
 * no mutation. The HTTP method is never the signal.
 */
import type { BubbleOperationMetadata } from '@bubblelab/shared-schemas';

export const ${constName}: BubbleOperationMetadata = ${body};
`;
}

async function main(): Promise<void> {
  const factory = new BubbleFactory();
  await factory.registerDefaults();

  const outDir = resolve(process.cwd(), 'src/bubbles/service-bubble');
  let failures = 0;

  for (const bubbleName of TARGET_BUBBLES) {
    const metadata = factory.getMetadata(bubbleName);
    const docSource = VENDOR_DOCS[bubbleName];
    if (!metadata || !docSource) {
      console.error(`❌ ${bubbleName}: not registered or no doc source`);
      failures++;
      continue;
    }
    const operations = extractOperations(metadata.schema);
    if (operations.length === 0) {
      console.error(
        `❌ ${bubbleName}: no operations found (params schema is not a discriminated union on 'operation')`
      );
      failures++;
      continue;
    }

    const entries: Record<string, OperationSideEffectMetadata> = {};
    for (const op of operations) {
      const classification = classifyOperation(bubbleName, op, docSource);
      // Belt and braces: every emitted entry must satisfy the shared schema
      entries[op.operation] =
        OperationSideEffectMetadataSchema.parse(classification);
    }

    const outPath = join(outDir, `${bubbleName}.metadata.ts`);
    writeFileSync(outPath, renderMetadataFile(bubbleName, entries), 'utf8');

    const summary = Object.entries(entries)
      .map(
        ([op, m]) =>
          `${op}=${m.sideEffect}${m.unverified ? '(UNVERIFIED)' : ''}`
      )
      .join(', ');
    console.log(`✅ ${bubbleName} (${operations.length} ops): ${summary}`);
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
