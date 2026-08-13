/**
 * U5 — Setup-tab completeness (the UI half of S1(c), BACKLOG U5).
 *
 * Pure derivation of the Setup panel's requirement list from a flow's
 * `requiredCredentials` map. The parser reports EVERY credential a flow needs
 * — nested agent tools included (S1 §0: `extractToolCredentials` puts
 * tool-level types under the agent's entry) — so completeness here means: one
 * card per required type, filtered ONLY by the effective platform-provided
 * classification (S1's `isPlatformProvided`) and the wildcard sentinel. A
 * nested-tool credential (e.g. FIRECRAWL_API_KEY via web-search-tool) derives
 * the same card a direct service bubble's credential does.
 *
 * F0.5 lens (PRODUCT-PRINCIPLES per-task table, U5 row): every card carries a
 * human `label` — the CREDENTIAL_TYPE_CONFIG product name, or a humanized
 * fallback — never the machine constant, so no `*_CRED` / SCREAMING_SNAKE
 * string reaches the render.
 *
 * FlowSetupPanel renders from this list and emits the same data as the
 * `setup.manifest_rendered` telemetry event (Pillar 2), so the acceptance
 * test asserts on the exact render-feeding data, never pixels.
 */
import {
  CredentialType,
  CREDENTIAL_TYPE_CONFIG,
} from '@bubblelab/shared-schemas';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import { isPlatformProvided } from './platformCredentials';

export interface SetupRequirement {
  credentialType: CredentialType;
  /** Human product name for the card (never the machine constant). */
  label: string;
  /** Humanized names of the steps that use the credential. */
  steps: string[];
}

/** 'slack-notification' / 'gmailSender' -> 'slack notification' / 'gmail sender' */
export function humanizeStepName(key: string): string {
  return key
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

/**
 * Fallback product name when CREDENTIAL_TYPE_CONFIG carries no label:
 * 'GOOGLE_DRIVE_CRED' -> 'Google Drive', 'FIRECRAWL_API_KEY' -> 'Firecrawl'.
 * Guarantees the F0.5 rule (no machine constant rendered) for any future
 * credential type added without a config entry.
 */
export function humanizeCredentialType(credentialType: string): string {
  return credentialType
    .replace(/_(CRED|API_KEY|TOKEN)$/i, '')
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** The card label for a credential type: config product name, human fallback. */
export function credentialTypeLabel(credentialType: CredentialType): string {
  return (
    CREDENTIAL_TYPE_CONFIG[credentialType]?.label ??
    humanizeCredentialType(credentialType)
  );
}

/**
 * Human display name for a requiredCredentials step key. The map keys by
 * variable id (numeric string) or variable name; a bubbleParameters entry
 * under the same key names the step (variableName, else bubbleName) so the
 * panel never shows a bare id. Falls back to humanizing the key itself.
 */
export function stepDisplayName(
  stepKey: string,
  bubbleParameters?: Record<
    string,
    Pick<ParsedBubbleWithInfo, 'variableName' | 'bubbleName'>
  >
): string {
  const bubble = bubbleParameters?.[stepKey];
  const name = bubble?.variableName || bubble?.bubbleName;
  return humanizeStepName(name || stepKey);
}

/**
 * Every credential the flow needs a user connection for, one entry per type,
 * in first-seen step order. Skips only:
 * - the wildcard sentinel (not a bindable slot), and
 * - types the platform provides from its own env (S1 effective
 *   classification; `platformTypes === undefined` falls back to the module
 *   cache / declared SYSTEM_CREDENTIALS via isPlatformProvided).
 */
export function deriveSetupRequirements(
  requiredCredentials: Record<string, CredentialType[]> | undefined,
  platformTypes?: ReadonlySet<string> | null,
  bubbleParameters?: Record<
    string,
    Pick<ParsedBubbleWithInfo, 'variableName' | 'bubbleName'>
  >
): SetupRequirement[] {
  const byType = new Map<CredentialType, Set<string>>();
  for (const [stepKey, types] of Object.entries(requiredCredentials ?? {})) {
    for (const type of types ?? []) {
      if (type === CredentialType.CREDENTIAL_WILDCARD) continue;
      if (isPlatformProvided(type, platformTypes)) continue;
      if (!byType.has(type)) byType.set(type, new Set());
      byType.get(type)!.add(stepDisplayName(stepKey, bubbleParameters));
    }
  }
  return [...byType.entries()].map(([credentialType, steps]) => ({
    credentialType,
    label: credentialTypeLabel(credentialType),
    steps: [...steps],
  }));
}
