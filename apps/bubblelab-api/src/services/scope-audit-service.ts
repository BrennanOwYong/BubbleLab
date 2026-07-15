/**
 * Flow-level proactive scope audit (IR-6/7) — the API wiring around the pure audit in
 * `@bubblelab/bubble-core` (`utils/scope-audit.ts`).
 *
 * At validation ("build") time this service:
 * 1. walks the parsed bubbles, resolving each call site's `operation` param statically,
 * 2. collects the credential ids assigned to each bubble (from the validate request's
 *    `credentials` mapping and from `credentials` parameters already merged into the parsed
 *    bubbles),
 * 3. loads the referenced credential rows (user-owned only) and reads the scopes the OAuth
 *    flow recorded as granted (`user_credentials.oauth_scopes`, persisted by
 *    `oauth-service.ts`),
 * 4. audits each credential: union of the operations' `requiredScopes` (IR-8 metadata) diffed
 *    against the recorded grants.
 *
 * Outcome contract: `ok === false` iff a credential is verifiably missing a scope — the
 * validate route fails the build naming the scope and the operations that need it. Credentials
 * that cannot be verified (no recorded grants, or operations without documented scopes) yield
 * WARNINGS with an explicit "will only surface on first run" message — the honest degrade, not
 * a silent pass and not a false failure.
 */
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  auditCredentialScopes,
  type ScopeAuditCallSite,
} from '@bubblelab/bubble-core';
import type {
  BubbleOperationMetadata,
  FlowScopeAudit,
  ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';
import { getBubbleFactory } from './bubble-factory-instance.js';

type CredentialAssignment = Record<string, number | number[]>;

/** Resolve a bubble's `operation` param when it is a static string literal. */
function resolveStaticOperation(
  bubble: ParsedBubbleWithInfo
): string | undefined {
  const operationParam = bubble.parameters.find(
    (param) => param.name === 'operation'
  );
  if (!operationParam) return undefined;
  // The parser stores string literals unquoted with type 'string'; anything else
  // (variable, expression, template) is not statically resolvable.
  if (operationParam.type !== 'string') return undefined;
  return typeof operationParam.value === 'string'
    ? operationParam.value
    : undefined;
}

/** Credential ids assigned to a bubble via its merged `credentials` parameter. */
function credentialsFromParameters(
  bubble: ParsedBubbleWithInfo
): CredentialAssignment {
  const credentialsParam = bubble.parameters.find(
    (param) => param.name === 'credentials'
  );
  if (
    !credentialsParam ||
    typeof credentialsParam.value !== 'object' ||
    credentialsParam.value === null ||
    Array.isArray(credentialsParam.value)
  ) {
    return {};
  }
  const assignment: CredentialAssignment = {};
  for (const [credentialType, id] of Object.entries(credentialsParam.value)) {
    if (typeof id === 'number') assignment[credentialType] = id;
    else if (
      Array.isArray(id) &&
      id.every((entry) => typeof entry === 'number')
    ) {
      assignment[credentialType] = id as number[];
    }
  }
  return assignment;
}

/**
 * Request-level credential mapping for a bubble. Accepts keys by bubbleParameters record key
 * (variableId) or by variable name — the documented request example uses names.
 */
function credentialsFromRequest(
  requestCredentials:
    | Record<string | number, Record<string, number | number[]>>
    | undefined,
  bubbleKey: string,
  bubble: ParsedBubbleWithInfo
): CredentialAssignment {
  if (!requestCredentials) return {};
  return {
    ...(requestCredentials[bubbleKey] ?? {}),
    ...(requestCredentials[bubble.variableName] ?? {}),
    ...(requestCredentials[bubble.variableId] ?? {}),
  };
}

interface CredentialCallSites {
  credentialType: string;
  credentialId: number;
  callSites: ScopeAuditCallSite[];
}

export interface AuditFlowScopesOptions {
  bubbleParameters: Record<string | number, ParsedBubbleWithInfo>;
  requestCredentials?: Record<
    string | number,
    Record<string, number | number[]>
  >;
  userId: string;
}

export async function auditFlowScopes(
  options: AuditFlowScopesOptions
): Promise<FlowScopeAudit> {
  const factory = await getBubbleFactory();

  // Group the flow's call sites by the credential id they will execute under.
  const byCredential = new Map<string, CredentialCallSites>();
  for (const [bubbleKey, bubble] of Object.entries(
    options.bubbleParameters
  )) {
    const assignment: CredentialAssignment = {
      ...credentialsFromParameters(bubble),
      ...credentialsFromRequest(options.requestCredentials, bubbleKey, bubble),
    };
    const assignedIds = Object.entries(assignment).flatMap(
      ([credentialType, ids]) =>
        (Array.isArray(ids) ? ids : [ids]).map((id) => ({
          credentialType,
          id,
        }))
    );
    if (assignedIds.length === 0) continue;

    const metadata = factory.getMetadata(bubble.bubbleName);
    const callSite: ScopeAuditCallSite = {
      bubbleName: bubble.bubbleName,
      variableName: bubble.variableName,
      operation: resolveStaticOperation(bubble),
      operationMetadata: metadata?.operationMetadata as
        | BubbleOperationMetadata
        | undefined,
    };

    for (const { credentialType, id } of assignedIds) {
      const key = `${credentialType}:${id}`;
      let group = byCredential.get(key);
      if (!group) {
        group = { credentialType, credentialId: id, callSites: [] };
        byCredential.set(key, group);
      }
      group.callSites.push(callSite);
    }
  }

  const audit: FlowScopeAudit = { ok: true, results: [], errors: [], warnings: [] };
  if (byCredential.size === 0) return audit;

  // Load the referenced credential rows — user-owned only — for their recorded grants.
  const ids = [...new Set([...byCredential.values()].map((g) => g.credentialId))];
  const rows = await db
    .select({
      id: userCredentials.id,
      credentialType: userCredentials.credentialType,
      oauthScopes: userCredentials.oauthScopes,
    })
    .from(userCredentials)
    .where(
      and(
        inArray(userCredentials.id, ids),
        eq(userCredentials.userId, options.userId)
      )
    );
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  for (const group of byCredential.values()) {
    const row = rowsById.get(group.credentialId);
    // Unknown / unowned credential ids are another validator's concern; the scope audit
    // only audits rows it can read.
    if (!row) continue;

    const result = auditCredentialScopes({
      credentialType: group.credentialType,
      credentialId: group.credentialId,
      // null → undefined: no grants recorded means the provider exposes no scope metadata.
      grantedScopes: row.oauthScopes ?? undefined,
      callSites: group.callSites,
    });
    audit.results.push(result);
    if (result.status === 'missing_scopes') {
      audit.ok = false;
      audit.errors.push(result.message);
    } else if (
      result.status === 'unknown_grants' ||
      result.status === 'no_scope_metadata'
    ) {
      audit.warnings.push(result.message);
    }
  }

  return audit;
}
