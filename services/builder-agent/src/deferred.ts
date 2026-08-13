/**
 * Deferred-setup resolution for blocked_on_credential build threads.
 *
 * State machine invariant: a build_thread that is blocked_on_credential STAYS
 * blocked across turns until this module resolves it — resolution means the
 * missing credential is now connected AND the persisted deferred setup script
 * ran to completion (an empty script resolves as soon as the credential
 * exists). Nothing else may transition a thread out of blocked; unrelated
 * turns must never clear the marker (builder.ts skips its 'building' write
 * when the thread is blocked).
 *
 * deferred_setup is kept intact throughout: while blocked, the original
 * script, credentialType and blocked status are never touched; failed
 * attempts only annotate it with lastAttempt {at, reason, trigger} so the
 * thread endpoint shows why the gap is still open (FE1 auditability). On
 * success it is annotated with resolvedAt + resolvedBy + results rather than
 * deleted, so the gap's history stays auditable. resolvedBy records which
 * trigger closed the gap: 'turn-start' (a user message on the blocked
 * thread) or 'credential-added' (the API's credentials-changed notify, FE1).
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { GluuClient } from './gluu-client.ts';
import type { Credential } from './gluu-client.ts';
import {
  pickSheetsCredential,
  provisionSpreadsheet,
  seedRows,
} from './provision.ts';
import { buildThreads, db } from './db.ts';
import type { BuildThread } from './db.ts';
import { config } from './config.ts';

const deferredStepSchema = z.object({
  action: z.string(),
  args: z.record(z.string(), z.unknown()),
  storeAs: z.string(),
});

const deferredSetupSchema = z
  .object({
    credentialType: z.string(),
    deferredSetupScript: z.array(deferredStepSchema),
    reportedAt: z.string(),
  })
  .loose();

const provisionArgsSchema = z.object({
  title: z.string().min(1),
  tabs: z.array(z.string().min(1)).optional(),
});

const seedRowsArgsSchema = z.object({
  spreadsheetId: z.string().min(1),
  tabName: z.string().min(1),
  rows: z.array(z.array(z.string())).min(1),
});

/** True when a connected credential can serve the reported-missing type. */
function credentialAvailable(type: string, credentials: Credential[]): boolean {
  if (type === 'GOOGLE_SHEETS_CRED') {
    return pickSheetsCredential(credentials) !== undefined;
  }
  return credentials.some((c) => c.credentialType === type);
}

/**
 * Substitute `$<storeAs>` string args with ids produced by earlier steps, so
 * a deferred script can chain (e.g. seed_rows into the spreadsheet a prior
 * provision_spreadsheet step will create).
 */
function substituteArgs(
  args: Record<string, unknown>,
  produced: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] =
      typeof value === 'string' && value.startsWith('$')
        ? (produced[value.slice(1)] ?? value)
        : value;
  }
  return out;
}

/** Which path attempted the resolution (persisted for auditability, FE1). */
export type DeferredTrigger = 'turn-start' | 'credential-added';

export interface DeferredResolution {
  resolved: boolean;
  reason: string;
  credentialType: string | null;
  results: Array<{ action: string; storeAs: string; output: unknown }>;
  trigger: DeferredTrigger;
}

/**
 * Annotate a still-blocked thread's deferred_setup with the failed attempt so
 * the thread endpoint surfaces WHY the gap is still open (e.g. a credential of
 * a different type was added). Annotation only: script, credentialType and
 * status stay untouched, per the sticky-blocked invariant above.
 */
async function recordFailedAttempt(
  thread: BuildThread,
  deferred: Record<string, unknown>,
  reason: string,
  trigger: DeferredTrigger
): Promise<void> {
  await db
    .update(buildThreads)
    .set({
      deferredSetup: {
        ...deferred,
        lastAttempt: { at: new Date().toISOString(), reason, trigger },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(buildThreads.subjectId, thread.subjectId),
        eq(buildThreads.agentKind, thread.agentKind)
      )
    );
}

/**
 * Attempt to resolve a blocked thread's deferred setup. Called at the start
 * of every turn on a blocked thread. Returns resolved=false (thread stays
 * blocked, deferred_setup untouched) unless the credential now exists and
 * every deferred step succeeded; then persists produced ids into the flow's
 * default_inputs (when the flow has code), marks deferred_setup resolved, and
 * lets the caller proceed as unblocked.
 */
export async function tryResolveDeferredSetup(
  thread: BuildThread,
  trigger: DeferredTrigger = 'turn-start'
): Promise<DeferredResolution> {
  const parsed = deferredSetupSchema.safeParse(thread.deferredSetup);
  if (!parsed.success) {
    // No parseable record to annotate — return without persisting an attempt.
    return {
      resolved: false,
      reason: 'deferred_setup record is missing or malformed; staying blocked',
      credentialType: null,
      results: [],
      trigger,
    };
  }
  const deferred = parsed.data;
  const client = new GluuClient(config.gluuApiUrl);

  // Every resolved:false exit below goes through fail() so the attempt is
  // persisted as a lastAttempt annotation on the thread's deferred_setup.
  const fail = async (
    reason: string,
    results: DeferredResolution['results'] = []
  ): Promise<DeferredResolution> => {
    await recordFailedAttempt(thread, deferred, reason, trigger);
    return {
      resolved: false,
      reason,
      credentialType: deferred.credentialType,
      results,
      trigger,
    };
  };

  const credentials = await client.listCredentials();
  if (!credentialAvailable(deferred.credentialType, credentials)) {
    return fail(`credential ${deferred.credentialType} is still not connected`);
  }

  const produced: Record<string, string> = {};
  const results: DeferredResolution['results'] = [];
  for (const step of deferred.deferredSetupScript) {
    const args = substituteArgs(step.args, produced);
    try {
      if (step.action === 'provision_spreadsheet') {
        const { title, tabs } = provisionArgsSchema.parse(args);
        const provisioned = await provisionSpreadsheet(client, title, tabs);
        produced[step.storeAs] = provisioned.spreadsheetId;
        results.push({
          action: step.action,
          storeAs: step.storeAs,
          output: provisioned,
        });
      } else if (step.action === 'seed_rows') {
        const seedArgs = seedRowsArgsSchema.parse(args);
        const seeded = await seedRows(
          client,
          seedArgs.spreadsheetId,
          seedArgs.tabName,
          seedArgs.rows
        );
        results.push({
          action: step.action,
          storeAs: step.storeAs,
          output: seeded,
        });
      } else {
        return fail(
          `unknown deferred action '${step.action}'; staying blocked`,
          results
        );
      }
    } catch (error) {
      return fail(
        `deferred step ${step.action} failed: ${error instanceof Error ? error.message : String(error)}`,
        results
      );
    }
  }

  // Persist produced ids as flow default_inputs (the setup-state invariant);
  // skipped when the flow has no code yet or the script produced nothing.
  // Page threads have no flow record — their produced ids reach the resumed
  // agent through the automatic-setup notice, which updates the spec.
  if (thread.agentKind === 'flow' && Object.keys(produced).length > 0) {
    const flow = await client.getFlow(thread.subjectId);
    if (flow.code !== '') {
      const result = await client.validateFlow({
        code: flow.code,
        flowId: thread.subjectId,
        options: {
          includeDetails: true,
          strictMode: true,
          syncInputsWithFlow: true,
        },
        defaultInputs: { ...flow.defaultInputs, ...produced },
        activateCron: flow.cronActive,
      });
      if (!result.valid) {
        return fail(
          `deferred setup ran but default_inputs persistence failed: ${result.errors?.join('; ') ?? 'unknown'}`,
          results
        );
      }
    }
  }

  await db
    .update(buildThreads)
    .set({
      status: 'building',
      deferredSetup: {
        ...deferred,
        resolvedAt: new Date().toISOString(),
        resolvedBy: trigger,
        results,
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(buildThreads.subjectId, thread.subjectId),
        eq(buildThreads.agentKind, thread.agentKind)
      )
    );

  return {
    resolved: true,
    reason: `credential ${deferred.credentialType} connected; deferred setup completed (${deferred.deferredSetupScript.length} step(s))`,
    credentialType: deferred.credentialType,
    results,
    trigger,
  };
}
