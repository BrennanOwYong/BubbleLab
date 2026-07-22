/**
 * Default credential binding ("zero clicks for the single-account case").
 *
 * For every step (bubble) that requires a credential of type T with no binding
 * yet, these pure functions decide which connected credential to bind:
 * - exactly one credential of type T exists -> bind it (reason 'only_credential')
 * - several exist -> bind the most recently created one (reason
 *   'default_of_many'); the chooser stays available so the user can switch
 * - none exist, but a credential of another type carries a STORED
 *   derived-credential record covering T (its granted scopes serve T) ->
 *   bind it (reason 'derived_record'); useSuiteBindings probe-confirms after
 * - none at all -> no binding (the Connect affordance handles it)
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
} from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';

export type AutoBindReason =
  | 'only_credential'
  | 'default_of_many'
  | 'derived_record';

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
      // Exact-type credentials first; with none connected, credentials whose
      // STORED derived-credential records cover the type stand in (e.g. a
      // Gmail credential whose granted scopes serve a Google Sheets step) —
      // the API already verified and persisted that coverage, so the binding
      // needs no probe. useSuiteBindings still confirms it live afterwards.
      const exactCandidates = getCredentialsOfType(
        input.credentials,
        credentialType
      );
      const candidates =
        exactCandidates.length > 0
          ? exactCandidates
          : getDerivedRecordCandidates(input.credentials, credentialType);
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
        reason:
          exactCandidates.length === 0
            ? 'derived_record'
            : exactCandidates.length === 1
              ? 'only_credential'
              : 'default_of_many',
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
  /**
   * True when the proposed credential carries a STORED derived-credential
   * record for the required type (the API already verified and persisted the
   * coverage) — such proposals bind on flow load without waiting for a probe.
   */
  hasDerivedRecord: boolean;
}

/**
 * Whether a credential's STORED derived-credential records cover
 * `credentialType` (the persisted parent→derived relationship the API keeps
 * in lockstep with the granted scopes).
 */
export function credentialCoversTypeByRecord(
  credential: CredentialResponse,
  credentialType: string
): boolean {
  return (credential.derivedCredentials ?? []).some(
    (record) => record.derivedCredentialType === credentialType
  );
}

/**
 * Credentials of a DIFFERENT type whose stored derived-credential records
 * cover `credentialType` — the pre-verified stand-ins computeAutoBindings
 * falls back to when no exact-type credential is connected.
 */
export function getDerivedRecordCandidates(
  credentials: CredentialResponse[],
  credentialType: string
): CredentialResponse[] {
  return credentials.filter(
    (credential) =>
      credential.credentialType !== credentialType &&
      credentialCoversTypeByRecord(credential, credentialType)
  );
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
 * Every (bubble, credentialType) slot a sibling-type credential of the same
 * OAuth provider should serve — unfilled slots no exact-type credential can
 * cover (default rule's pick), plus slots ALREADY bound to a sibling (the
 * derived-record auto-bind), proposed with that same credential so the live
 * scope-check confirms the binding. Non-provider-grouped types never yield
 * proposals. Callers scope-verify a proposal and roll back on failure.
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
      const provider = getOAuthProvider(credentialType as CredentialType);
      if (!provider) continue;
      const candidates = getProviderSuiteCandidates(
        input.credentials,
        credentialType
      );

      const existing = selected[credentialType];
      // A slot already bound to a SIBLING-type credential (the derived-record
      // auto-bind path) still needs the live scope-check as confirmation —
      // propose that same credential. A slot bound to an exact-type credential
      // (or any credential outside the provider group) is settled.
      let boundSibling: CredentialResponse | undefined;
      if (existing !== undefined && existing !== null) {
        boundSibling = candidates.find(
          (candidate) => candidate.id === existing
        );
        if (!boundSibling) continue;
      } else {
        // Exact-type credentials exist -> the normal auto-bind path owns the slot.
        if (
          getCredentialsOfType(input.credentials, credentialType).length > 0
        ) {
          continue;
        }
      }
      if (candidates.length === 0) continue;
      // Candidates whose STORED derived-credential record covers the required
      // type come first: the persisted relationship is the source of truth, so
      // a record-holding sibling wins over one that would need a fresh probe.
      const withRecord = candidates.filter((candidate) =>
        credentialCoversTypeByRecord(candidate, credentialType)
      );
      const pool = withRecord.length > 0 ? withRecord : candidates;
      const chosen =
        boundSibling ??
        (pool.length === 1 ? pool[0] : pickDefaultCredential(pool));
      if (!chosen) continue;
      proposals.push({
        bubbleKey,
        requiredCredentialType: credentialType,
        provider,
        credentialId: chosen.id,
        credentialName: chosen.name,
        sourceCredentialType: chosen.credentialType,
        candidateCount: candidates.length,
        hasDerivedRecord: credentialCoversTypeByRecord(chosen, credentialType),
      });
    }
  }
  return proposals;
}

// ── Suite coverage (credentials page provenance) ─────────────────────────────

export interface SuiteCoverageEntry {
  /** The sibling credential type in the same OAuth provider group. */
  credentialType: CredentialType;
  /** Display label for the sibling type (e.g. 'Google Sheets'). */
  label: string;
}

/**
 * The sibling types this credential serves, read from its STORED
 * derived-credential records ("this Google Drive credential also grants
 * Google Sheets"). The API materializes the records from the granted scopes
 * on connect / scope-sync / re-consent and delivers them on GET /credentials
 * — nothing is recomputed client-side, so the label always matches what the
 * suite binding will use. Credentials with no records return [].
 */
export function getStoredSuiteCoverage(
  credential: CredentialResponse
): SuiteCoverageEntry[] {
  return (credential.derivedCredentials ?? []).map((record) => ({
    credentialType: record.derivedCredentialType as CredentialType,
    label:
      CREDENTIAL_TYPE_CONFIG[record.derivedCredentialType as CredentialType]
        ?.label ?? record.derivedCredentialType,
  }));
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
 * One credential per tool type: bind `credentialId` to EVERY step requiring
 * `credentialType`, overwriting any existing per-step selection. Both the
 * setup panel's connect/switch path and the bubble node's add-credential
 * modal route through this, so a credential added anywhere serves every
 * instance of the tool. Returns the bubble keys bound; callers pass the
 * execution store's setCredential, and usePersistCredentialBindings picks
 * the store change up and persists it (PUT /bubble-flow/:id).
 */
export function bindCredentialToAllSteps(
  flow: {
    bubbleParameters?: Record<string, ParsedBubbleWithInfo> | null;
    requiredCredentials?: Record<string, CredentialType[] | string[]> | null;
  },
  credentialType: string,
  credentialId: number,
  setCredential: (
    bubbleKey: string,
    credentialType: string,
    credentialId: number
  ) => void
): string[] {
  const keys = getBubbleKeysRequiringType(
    flow.bubbleParameters ?? {},
    flow.requiredCredentials ?? {},
    credentialType
  );
  for (const bubbleKey of keys) {
    setCredential(bubbleKey, credentialType, credentialId);
  }
  return keys;
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
