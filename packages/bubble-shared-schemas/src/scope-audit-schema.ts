import { z } from '@hono/zod-openapi';

/**
 * Proactive scope audit result shapes (IR-6/7).
 *
 * At flow validation ("build") time the audit unions the `requiredScopes` declared by every
 * operation the flow calls (per-operation metadata, IR-8), diffs that union against the scopes
 * recorded as granted on the assigned credential row, and fails the build NAMING the missing
 * scope and the operations that need it — before the provider can reject a run midway.
 *
 * Honesty rule: when the audit cannot verify coverage it says so instead of passing silently.
 * Two distinct unverifiable cases exist and each carries its own status:
 * - `unknown_grants`: the credential row has no recorded scope grants (API keys and other
 *   credential types whose provider exposes no scope metadata / no introspection).
 * - `no_scope_metadata`: the operations themselves declare no `requiredScopes` (the vendor
 *   documents no scope vocabulary for them, or the bubble is not yet backfilled).
 * Both degrade to an explicit "will only surface on first run" message, never a fake pass.
 *
 * Scope encoding: one entry in `requiredScopes` is satisfiable by ANY of its `|`-separated
 * alternatives; ALL entries must be satisfied. See `operation-metadata-schema.ts`.
 */

export const SCOPE_AUDIT_STATUSES = [
  'pass',
  'missing_scopes',
  'unknown_grants',
  'no_scope_metadata',
] as const;

export const ScopeAuditStatusSchema = z
  .enum(SCOPE_AUDIT_STATUSES)
  .describe(
    "Outcome of auditing one credential: 'pass' (every required scope granted), 'missing_scopes' (build fails, missing scopes named), 'unknown_grants' (credential has no recorded scope grants — audit impossible, surfaces on first run), 'no_scope_metadata' (operations declare no scope requirements — audit impossible, surfaces on first run)"
  );

export type ScopeAuditStatus = z.infer<typeof ScopeAuditStatusSchema>;

/** A call site that contributes scope requirements: one bubble invocation resolved to an operation. */
export const ScopeAuditOperationRefSchema = z.object({
  bubbleName: z.string().describe('Registry name of the bubble'),
  variableName: z
    .string()
    .optional()
    .describe('Flow variable the bubble is assigned to, when known'),
  operation: z
    .string()
    .describe(
      "The resolved `operation` literal; '*' when the operation could not be resolved statically and the requirement was taken conservatively from every declared operation"
    ),
});

export type ScopeAuditOperationRef = z.infer<
  typeof ScopeAuditOperationRefSchema
>;

/** One required-scope entry: satisfied when the grant set contains ANY of `alternatives`. */
export const ScopeRequirementSchema = z.object({
  scope: z
    .string()
    .describe(
      "The requirement as declared (alternatives joined with '|'); satisfied by any one alternative"
    ),
  alternatives: z
    .array(z.string())
    .min(1)
    .describe('The individual scopes that each satisfy this requirement'),
  requiredBy: z
    .array(ScopeAuditOperationRefSchema)
    .min(1)
    .describe('The operations in the flow that need this scope'),
  satisfied: z
    .boolean()
    .describe(
      'Whether the granted scopes cover this requirement (always false under unknown_grants)'
    ),
});

export type ScopeRequirement = z.infer<typeof ScopeRequirementSchema>;

/** Audit result for a single credential referenced by the flow. */
export const CredentialScopeAuditSchema = z.object({
  credentialType: z
    .string()
    .describe("Credential type the audit ran against (e.g. 'GMAIL_CRED')"),
  credentialId: z
    .number()
    .optional()
    .describe('Database id of the credential row, when one was assigned'),
  status: ScopeAuditStatusSchema,
  grantedScopes: z
    .array(z.string())
    .optional()
    .describe(
      'Scopes recorded as granted on the credential row; absent when the provider exposes no scope metadata'
    ),
  requirements: z
    .array(ScopeRequirementSchema)
    .describe('Every scope requirement contributed by the audited call sites'),
  missingScopes: z
    .array(z.string())
    .describe(
      'The unsatisfied requirement entries (empty unless status is missing_scopes)'
    ),
  message: z
    .string()
    .describe(
      'Human-readable audit outcome: names missing scopes and the operations needing them, or states plainly why the audit could not verify coverage'
    ),
});

export type CredentialScopeAudit = z.infer<typeof CredentialScopeAuditSchema>;

/** Whole-flow audit: one entry per credential the flow references. */
export const FlowScopeAuditSchema = z.object({
  ok: z
    .boolean()
    .describe(
      'False iff at least one credential audit returned missing_scopes (the build must fail); unverifiable audits do not fail the build'
    ),
  results: z.array(CredentialScopeAuditSchema),
  errors: z
    .array(z.string())
    .describe('Build-failing messages (one per missing_scopes credential)'),
  warnings: z
    .array(z.string())
    .describe(
      'Honest-degrade messages for credentials whose coverage could not be verified'
    ),
});

export type FlowScopeAudit = z.infer<typeof FlowScopeAuditSchema>;
