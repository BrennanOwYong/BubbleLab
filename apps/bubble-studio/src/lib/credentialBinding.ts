/**
 * Default credential binding ("zero clicks for the single-account case").
 *
 * For every step (bubble) that requires a credential of type T with no binding
 * yet, these pure functions decide which connected credential to bind:
 * - exactly one credential of type T exists -> bind it (reason 'only_credential')
 * - several exist -> bind the most recently created one (reason
 *   'default_of_many'); the chooser stays available so the user can switch
 * - none exist -> no binding (the Connect affordance handles it)
 *
 * Bindings are PER STEP: the execution store keys pendingCredentials by bubble
 * variableId, so two steps can hold different accounts of the same type. The
 * computation never overrides an existing selection and skips system/optional
 * credential types.
 *
 * Pure and side-effect free so it is unit-testable; useAutoBindCredentials
 * applies the result to the store and emits telemetry.
 */
import {
  SYSTEM_CREDENTIALS,
  OPTIONAL_CREDENTIALS,
  CredentialType,
  CREDENTIAL_TYPE_CONFIG,
  getOAuthProvider,
  getOAuthProviderGroupTypes,
  getDefaultScopes,
} from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';

export type AutoBindReason = 'only_credential' | 'default_of_many';

export interface AutoBinding {
  /** Key into pendingCredentials (bubble variableId as string). */
  bubbleKey: string;
  credentialType: string;
  credentialId: number;
  credentialName?: string;
  reason: AutoBindReason;
  /** Connected credentials of this exact type at decision time. */
  candidateCount: number;
}

export interface ComputeAutoBindingsInput {
  /** Flow bubbleParameters (keys mirror pendingCredentials keys). */
  bubbleParameters: Record<string, ParsedBubbleWithInfo>;
  /** requiredCredentials off the flow details (keyed like bubbleParameters). */
  requiredCredentials: Record<string, CredentialType[] | string[]>;
  /** Current per-bubble selections; existing entries are never overridden. */
  pendingCredentials: Record<string, Record<string, number>>;
  /** The user's connected credentials (GET /credentials). */
  credentials: CredentialResponse[];
}

/**
 * The store key a bubble's credential selections live under. Mirrors
 * BubbleNode's credentialsKey chain so auto-bound values render in the
 * per-step chooser.
 */
export function bindingKeyForBubble(
  bubble: ParsedBubbleWithInfo,
  fallbackKey: string
): string {
  return String(
    bubble.variableId || bubble.variableName || bubble.bubbleName || fallbackKey
  );
}

/** All connected credentials of one exact credential type. */
export function getCredentialsOfType(
  credentials: CredentialResponse[],
  credentialType: string
): CredentialResponse[] {
  return credentials.filter(
    (credential) => credential.credentialType === credentialType
  );
}

/**
 * The default among several credentials of one type: most recently created
 * (creation recency is the deterministic stand-in for most-recently-used;
 * the API records no per-credential usage timestamps). Ties and unparseable
 * timestamps fall back to the highest id.
 */
export function pickDefaultCredential(
  candidates: CredentialResponse[]
): CredentialResponse | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aValid = !Number.isNaN(aTime);
    const bValid = !Number.isNaN(bTime);
    if (aValid && bValid && aTime !== bTime) return bTime - aTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return b.id - a.id;
  })[0];
}

/** Display identity for a credential: OAuth account email first, then name. */
export function describeCredentialAccount(
  credential: CredentialResponse
): string {
  const metadata = credential.metadata as { email?: string } | undefined;
  if (metadata?.email) {
    return credential.name
      ? `${metadata.email} (${credential.name})`
      : metadata.email;
  }
  return credential.name ?? `${credential.credentialType} #${credential.id}`;
}

function requiredTypesForBubble(
  requiredCredentials: Record<string, CredentialType[] | string[]>,
  bubble: ParsedBubbleWithInfo,
  entryKey: string
): string[] {
  const byVariableId =
    bubble.variableId !== undefined && bubble.variableId !== null
      ? requiredCredentials[String(bubble.variableId)]
      : undefined;
  const types = byVariableId ?? requiredCredentials[entryKey] ?? [];
  return types.map((type) => String(type));
}

/**
 * Every missing (bubble, credentialType) slot that connected credentials can
 * fill, with the credential the default rule picks for it.
 */
export function computeAutoBindings(
  input: ComputeAutoBindingsInput
): AutoBinding[] {
  const bindings: AutoBinding[] = [];
  for (const [entryKey, bubble] of Object.entries(input.bubbleParameters)) {
    const bubbleKey = bindingKeyForBubble(bubble, entryKey);
    const selected = input.pendingCredentials[bubbleKey] ?? {};
    for (const credentialType of requiredTypesForBubble(
      input.requiredCredentials,
      bubble,
      entryKey
    )) {
      if (SYSTEM_CREDENTIALS.has(credentialType as CredentialType)) continue;
      if (OPTIONAL_CREDENTIALS.has(credentialType as CredentialType)) continue;
      const existing = selected[credentialType];
      if (existing !== undefined && existing !== null) continue;
      const candidates = getCredentialsOfType(
        input.credentials,
        credentialType
      );
      if (candidates.length === 0) continue;
      const chosen =
        candidates.length === 1
          ? candidates[0]
          : pickDefaultCredential(candidates);
      if (!chosen) continue;
      bindings.push({
        bubbleKey,
        credentialType,
        credentialId: chosen.id,
        credentialName: chosen.name,
        reason: candidates.length === 1 ? 'only_credential' : 'default_of_many',
        candidateCount: candidates.length,
      });
    }
  }
  return bindings;
}

// ── Suite-aware binding (same OAuth provider, different credential type) ─────
//
// Google Drive/Gmail/Sheets/Calendar are separate CredentialTypes but ONE OAuth
// provider issuing ONE token whose SCOPES decide capability. A credential of a
// sibling type in the provider group can therefore satisfy a step of another
// type — but only after its GRANTED scopes are verified against the step's
// required scopes (the proposal below is checked by useSuiteBindings before
// any binding happens; nothing binds on type membership alone).

export interface SuiteBindingProposal {
  /** Key into pendingCredentials (bubble variableId as string). */
  bubbleKey: string;
  /** The credential type the step requires (the binding key). */
  requiredCredentialType: string;
  /** OAuth provider shared by the required type and the proposed credential. */
  provider: string;
  /** The proposed credential (a sibling type in the same provider group). */
  credentialId: number;
  credentialName?: string;
  /** The proposed credential row's own type. */
  sourceCredentialType: string;
  /** Sibling-type candidates available at decision time. */
  candidateCount: number;
}

/**
 * OAuth credentials of a SIBLING type in the required type's provider group
 * (never the exact type — exact matches are the normal binding path).
 */
export function getProviderSuiteCandidates(
  credentials: CredentialResponse[],
  credentialType: string
): CredentialResponse[] {
  const groupTypes = getOAuthProviderGroupTypes(
    credentialType as CredentialType
  );
  if (groupTypes.length <= 1) return [];
  return credentials.filter(
    (credential) =>
      credential.isOauth === true &&
      credential.credentialType !== credentialType &&
      groupTypes.includes(credential.credentialType as CredentialType)
  );
}

/**
 * Every missing (bubble, credentialType) slot that NO exact-type credential can
 * fill but a sibling-type credential of the same OAuth provider could — with
 * the default rule's pick. Non-provider-grouped types never yield proposals.
 * Callers must scope-verify a proposal before binding it.
 */
export function computeSuiteBindingProposals(
  input: ComputeAutoBindingsInput
): SuiteBindingProposal[] {
  const proposals: SuiteBindingProposal[] = [];
  for (const [entryKey, bubble] of Object.entries(input.bubbleParameters)) {
    const bubbleKey = bindingKeyForBubble(bubble, entryKey);
    const selected = input.pendingCredentials[bubbleKey] ?? {};
    for (const credentialType of requiredTypesForBubble(
      input.requiredCredentials,
      bubble,
      entryKey
    )) {
      if (SYSTEM_CREDENTIALS.has(credentialType as CredentialType)) continue;
      if (OPTIONAL_CREDENTIALS.has(credentialType as CredentialType)) continue;
      const existing = selected[credentialType];
      if (existing !== undefined && existing !== null) continue;
      // Exact-type credentials exist -> the normal auto-bind path owns the slot.
      if (getCredentialsOfType(input.credentials, credentialType).length > 0) {
        continue;
      }
      const provider = getOAuthProvider(credentialType as CredentialType);
      if (!provider) continue;
      const candidates = getProviderSuiteCandidates(
        input.credentials,
        credentialType
      );
      if (candidates.length === 0) continue;
      const chosen =
        candidates.length === 1
          ? candidates[0]
          : pickDefaultCredential(candidates);
      if (!chosen) continue;
      proposals.push({
        bubbleKey,
        requiredCredentialType: credentialType,
        provider,
        credentialId: chosen.id,
        credentialName: chosen.name,
        sourceCredentialType: chosen.credentialType,
        candidateCount: candidates.length,
      });
    }
  }
  return proposals;
}

// ── Suite coverage (credentials page provenance) ─────────────────────────────

/** Scope comparison key: trailing-slash tolerant, case preserved (RFC 6749 §3.3). */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/** Identity scopes ride along on every Google authorization — capability-neutral. */
const IDENTITY_SCOPES = new Set(['openid', 'email', 'profile']);

export interface SuiteCoverageEntry {
  /** The sibling credential type in the same OAuth provider group. */
  credentialType: CredentialType;
  /** Display label for the sibling type (e.g. 'Google Sheets'). */
  label: string;
  /** True when the credential's recorded granted scopes cover every default scope of the sibling type. */
  covered: boolean;
  /** The sibling's default scopes the grant does not cover (empty when covered). */
  missingScopes: string[];
}

/**
 * Which sibling types of the credential's OAuth provider group its recorded
 * granted scopes cover ("this Google Drive credential also grants Google
 * Sheets"). Legibility for the suite-binding behavior: a flow needing a
 * covered sibling type binds through this credential instead of asking for a
 * new connection. Comparison uses the STORED oauthScopes — the scope-check
 * probe syncs those with the live grant, so covered entries reflect real
 * grants; no probe happens here. Types outside a multi-type provider group
 * return [].
 */
export function computeSuiteCoverage(
  credential: CredentialResponse
): SuiteCoverageEntry[] {
  if (credential.isOauth !== true) return [];
  const ownType = credential.credentialType as CredentialType;
  const groupTypes = getOAuthProviderGroupTypes(ownType);
  if (groupTypes.length <= 1) return [];
  const granted = new Set(
    (credential.oauthScopes ?? []).map((scope) => normalizeScope(scope))
  );
  if (granted.size === 0) return [];
  const entries: SuiteCoverageEntry[] = [];
  for (const siblingType of groupTypes) {
    if (siblingType === ownType) continue;
    const requiredScopes = getDefaultScopes(siblingType).filter(
      (scope) => !IDENTITY_SCOPES.has(scope)
    );
    if (requiredScopes.length === 0) continue;
    const missingScopes = requiredScopes.filter(
      (scope) => !granted.has(normalizeScope(scope))
    );
    entries.push({
      credentialType: siblingType,
      label: CREDENTIAL_TYPE_CONFIG[siblingType]?.label ?? siblingType,
      covered: missingScopes.length === 0,
      missingScopes,
    });
  }
  return entries;
}

/**
 * The bubble keys whose required credentials include `credentialType`
 * (setup-panel switch targets: switching an account rebinds every step that
 * needs the type).
 */
export function getBubbleKeysRequiringType(
  bubbleParameters: Record<string, ParsedBubbleWithInfo>,
  requiredCredentials: Record<string, CredentialType[] | string[]>,
  credentialType: string
): string[] {
  const keys: string[] = [];
  for (const [entryKey, bubble] of Object.entries(bubbleParameters)) {
    const types = requiredTypesForBubble(requiredCredentials, bubble, entryKey);
    if (types.includes(credentialType)) {
      keys.push(bindingKeyForBubble(bubble, entryKey));
    }
  }
  return [...new Set(keys)];
}

/**
 * The credential id currently bound for a type across the steps that need it.
 * Returns the id when every bound step agrees, null when steps disagree
 * (mixed per-step bindings), and undefined when nothing is bound yet.
 */
export function getBoundCredentialIdForType(
  pendingCredentials: Record<string, Record<string, number>>,
  bubbleKeys: string[],
  credentialType: string
): number | null | undefined {
  const boundIds = new Set<number>();
  for (const key of bubbleKeys) {
    const id = pendingCredentials[key]?.[credentialType];
    if (id !== undefined && id !== null) boundIds.add(id);
  }
  if (boundIds.size === 0) return undefined;
  if (boundIds.size === 1) return [...boundIds][0];
  return null;
}
