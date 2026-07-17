/**
 * Proactive scope audit (IR-6/7): pure build-time verification that the scopes a flow's
 * operations require are covered by the scopes granted on the assigned credential.
 *
 * BubbleLab previously enforced scopes REACTIVELY only — granted scopes were stored but
 * display-only, and a missing scope surfaced as a provider rejection mid-run. This module makes
 * the check proactive: union the per-operation `requiredScopes` (IR-8 metadata) across the
 * flow's call sites, diff against the credential's recorded grants, and fail the build naming
 * the exact missing scope and the operations that need it.
 *
 * Honesty rule — the audit never fakes a pass:
 * - Credential has no recorded grants (API keys; providers without scope introspection) →
 *   `unknown_grants`, with an explicit "will only surface on first run" message.
 * - Operations declare no `requiredScopes` (vendor documents no scope vocabulary, or the bubble
 *   is not yet backfilled) → `no_scope_metadata`, same explicit degrade.
 *
 * Scope encoding (see `operation-metadata-schema.ts`): each `requiredScopes` entry is one
 * requirement; ALL entries must hold; within an entry `|` separates alternatives, ANY one of
 * which satisfies it. This mirrors vendors like Google that publish per-method accepted-scope
 * sets ("requires one of the following OAuth scopes").
 *
 * Design ported from the reference implementation's `packages/auth/src/scope-audit.ts`
 * (pass / missing_scopes / unknown_grants triad), extended with `no_scope_metadata` and the
 * any-of alternatives encoding for Google-style scope sets.
 */

import type {
  BubbleOperationMetadata,
  CredentialScopeAudit,
  ScopeAuditOperationRef,
  ScopeRequirement,
} from '@bubblelab/shared-schemas';

/** One bubble invocation the audit inspects. */
export interface ScopeAuditCallSite {
  /** Registry name of the bubble (e.g. 'gmail'). */
  bubbleName: string;
  /** Flow variable name, when known — carried into requirement attribution. */
  variableName?: string;
  /**
   * The statically resolved `operation` param value, or undefined when the operation is
   * dynamic (variable/expression). Dynamic operations are audited conservatively: every
   * operation the bubble declares scope metadata for contributes its requirements.
   */
  operation?: string;
  /** The bubble class's static per-operation metadata (IR-8), when declared. */
  operationMetadata?: BubbleOperationMetadata;
}

export interface AuditCredentialScopesInput {
  /** Credential type the call sites resolve against (e.g. 'GMAIL_CRED'). */
  credentialType: string;
  /** Database id of the credential row, when one is assigned. */
  credentialId?: number;
  /**
   * Scopes recorded as granted on the credential. `undefined` means the provider exposes no
   * scope metadata for this credential (API keys without introspection, OAuth rows persisted
   * before scopes were recorded) — the audit degrades honestly instead of guessing.
   */
  grantedScopes?: string[];
  /** The call sites in the flow that use this credential. */
  callSites: ScopeAuditCallSite[];
}

/**
 * Scope comparison key: trims whitespace and a trailing '/' so that
 * 'https://mail.google.com/' and 'https://mail.google.com' compare equal.
 * Case is preserved — OAuth scope strings are case-sensitive per RFC 6749 §3.3.
 */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** Split a requirement entry into its '|'-separated alternatives. */
export function scopeAlternatives(entry: string): string[] {
  return entry
    .split('|')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

interface RequirementAccumulator {
  scope: string;
  alternatives: string[];
  requiredBy: ScopeAuditOperationRef[];
}

/**
 * Union the scope requirements contributed by the given call sites, deduplicated by
 * requirement entry, each carrying the operations that need it.
 */
export function collectScopeRequirements(
  callSites: readonly ScopeAuditCallSite[]
): RequirementAccumulator[] {
  const byEntry = new Map<string, RequirementAccumulator>();

  for (const site of callSites) {
    const metadata = site.operationMetadata;
    if (!metadata) continue;

    // Static operation → that operation's requirements. Dynamic operation → conservative
    // union over every operation that declares requirements ('*' marks the attribution).
    const resolved: Array<{ operation: string; entries: string[] }> = [];
    if (site.operation !== undefined) {
      const entry = metadata[site.operation];
      if (entry?.requiredScopes && entry.requiredScopes.length > 0) {
        resolved.push({
          operation: site.operation,
          entries: entry.requiredScopes,
        });
      }
    } else {
      for (const [operation, entry] of Object.entries(metadata)) {
        if (entry.requiredScopes && entry.requiredScopes.length > 0) {
          resolved.push({
            operation: `${operation} (operation not statically resolvable — audited conservatively)`,
            entries: entry.requiredScopes,
          });
        }
      }
    }

    for (const { operation, entries } of resolved) {
      for (const entry of entries) {
        const key = scopeAlternatives(entry).map(normalizeScope).join('|');
        let accumulator = byEntry.get(key);
        if (!accumulator) {
          accumulator = {
            scope: entry,
            alternatives: scopeAlternatives(entry),
            requiredBy: [],
          };
          byEntry.set(key, accumulator);
        }
        const ref: ScopeAuditOperationRef = {
          bubbleName: site.bubbleName,
          variableName: site.variableName,
          operation,
        };
        const alreadyListed = accumulator.requiredBy.some(
          (existing) =>
            existing.bubbleName === ref.bubbleName &&
            existing.variableName === ref.variableName &&
            existing.operation === ref.operation
        );
        if (!alreadyListed) accumulator.requiredBy.push(ref);
      }
    }
  }

  return [...byEntry.values()];
}

function describeOperations(refs: readonly ScopeAuditOperationRef[]): string {
  return refs
    .map((ref) =>
      ref.variableName
        ? `${ref.bubbleName}.${ref.operation} (${ref.variableName})`
        : `${ref.bubbleName}.${ref.operation}`
    )
    .join(', ');
}

function credentialLabel(input: AuditCredentialScopesInput): string {
  return input.credentialId !== undefined
    ? `${input.credentialType} (credential #${input.credentialId})`
    : input.credentialType;
}

/**
 * Audit one credential's granted scopes against the requirements of the call sites using it.
 * Pure — the caller supplies the call sites, metadata, and the credential row's grants.
 */
export function auditCredentialScopes(
  input: AuditCredentialScopesInput
): CredentialScopeAudit {
  const requirements = collectScopeRequirements(input.callSites);
  const label = credentialLabel(input);

  if (requirements.length === 0) {
    return {
      credentialType: input.credentialType,
      credentialId: input.credentialId,
      status: 'no_scope_metadata',
      grantedScopes: input.grantedScopes,
      requirements: [],
      missingScopes: [],
      message:
        `Scope audit skipped for ${label}: the operations this flow uses declare no scope ` +
        `requirements, so there is nothing to verify against. A permission mismatch can only ` +
        `surface on first run, as a provider authorization error.`,
    };
  }

  if (input.grantedScopes === undefined) {
    return {
      credentialType: input.credentialType,
      credentialId: input.credentialId,
      status: 'unknown_grants',
      grantedScopes: undefined,
      requirements: requirements.map((requirement) => ({
        ...requirement,
        satisfied: false,
      })),
      missingScopes: [],
      message:
        `Scope audit skipped for ${label}: the provider exposes no scope metadata for this ` +
        `credential (no granted scopes are recorded), so the pre-flight check cannot verify ` +
        `coverage. A permission mismatch can only surface on first run, as a provider ` +
        `authorization error. This is a metadata gap, not a verified pass.`,
    };
  }

  const granted = new Set(input.grantedScopes.map(normalizeScope));
  const audited: ScopeRequirement[] = requirements.map((requirement) => ({
    ...requirement,
    satisfied: requirement.alternatives.some((alternative) =>
      granted.has(normalizeScope(alternative))
    ),
  }));

  const missing = audited.filter((requirement) => !requirement.satisfied);
  if (missing.length === 0) {
    return {
      credentialType: input.credentialType,
      credentialId: input.credentialId,
      status: 'pass',
      grantedScopes: [...input.grantedScopes],
      requirements: audited,
      missingScopes: [],
      message: `Scope audit passed for ${label}: every scope required by the flow's operations is granted.`,
    };
  }

  const detail = missing
    .map((requirement) => {
      const scopeText =
        requirement.alternatives.length > 1
          ? `"${requirement.alternatives[0]}" (or any of: ${requirement.alternatives
              .map((alternative) => `"${alternative}"`)
              .join(', ')})`
          : `"${requirement.alternatives[0]}"`;
      return `${scopeText} — required by ${describeOperations(requirement.requiredBy)}`;
    })
    .join('; ');

  return {
    credentialType: input.credentialType,
    credentialId: input.credentialId,
    status: 'missing_scopes',
    grantedScopes: [...input.grantedScopes],
    requirements: audited,
    missingScopes: missing.map((requirement) => requirement.scope),
    message:
      `Missing OAuth scope(s) on ${label}: ${detail}. ` +
      `Re-connect the credential granting the missing scope(s), then validate again.`,
  };
}
