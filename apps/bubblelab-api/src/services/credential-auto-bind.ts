/**
 * Server-side single-match credential auto-bind: the durable backstop that
 * makes auto-selected credentials correct on EVERY code path (create,
 * validation sync, Pearl generation save, manual run, webhook, cron), not just
 * an editor-mounted flow.
 *
 * For each required-credential slot in bubbleParameters with no binding, the
 * user's connected credentials decide:
 * - exactly ONE credential of the exact type -> bind it,
 * - no exact-type credential but exactly ONE credential whose STORED
 *   derived-credential record covers the type (e.g. a Gmail credential whose
 *   granted scopes serve Google Sheets) -> bind that parent credential,
 * - zero or several candidates -> leave the slot unbound (the studio's
 *   chooser / Connect affordance owns ambiguity; the server never guesses).
 *
 * The single-match rule is deliberately stricter than the studio's
 * default-of-many recency rule: a server-side guess between accounts would be
 * invisible until an execution used the wrong one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { derivedCredentials, userCredentials } from '../db/schema.js';
import {
  SYSTEM_CREDENTIALS,
  OPTIONAL_CREDENTIALS,
  BubbleParameterType,
  type CredentialType,
  type ParsedBubbleWithInfo,
} from '@bubblelab/shared-schemas';
import { extractRequiredCredentials } from './bubble-flow-parser.js';

export interface AutoBoundSlot {
  /** bubbleParameters record key of the bound bubble. */
  bubbleKey: string;
  credentialType: CredentialType;
  credentialId: number;
  match: 'exact_type' | 'derived_record';
}

export interface AutoBindResult {
  /** The input record with bound slots filled (same object identity). */
  bubbleParameters: Record<string, ParsedBubbleWithInfo>;
  /** Every slot this call bound; empty when nothing was missing or bindable. */
  bound: AutoBoundSlot[];
}

/** The credential types already bound (numeric id or id array) on a bubble. */
function boundTypesForBubble(bubble: ParsedBubbleWithInfo): Set<string> {
  const bound = new Set<string>();
  const credentialsParam = bubble.parameters.find(
    (p) => p.name === 'credentials'
  );
  if (
    credentialsParam &&
    typeof credentialsParam.value === 'object' &&
    credentialsParam.value !== null
  ) {
    for (const [credType, value] of Object.entries(
      credentialsParam.value as Record<string, unknown>
    )) {
      if (
        typeof value === 'number' ||
        (Array.isArray(value) && value.length > 0)
      ) {
        bound.add(credType);
      }
    }
  }
  return bound;
}

/** Write a credential id under a type on a bubble's credentials parameter. */
function bindCredentialOnBubble(
  bubble: ParsedBubbleWithInfo,
  credentialType: CredentialType,
  credentialId: number
): void {
  let credentialsParam = bubble.parameters.find(
    (p) => p.name === 'credentials'
  );
  if (!credentialsParam) {
    credentialsParam = {
      name: 'credentials',
      value: {},
      type: BubbleParameterType.OBJECT,
    };
    bubble.parameters.push(credentialsParam);
  }
  if (
    typeof credentialsParam.value !== 'object' ||
    credentialsParam.value === null
  ) {
    credentialsParam.value = {};
  }
  (credentialsParam.value as Record<string, number>)[credentialType] =
    credentialId;
}

/**
 * Fill every unbound required-credential slot the user's credentials decide
 * unambiguously (see module doc). Reads the database only when at least one
 * slot is missing, so bound-through flows cost nothing extra.
 */
export async function autoBindMissingCredentials(
  userId: string,
  bubbleParameters: Record<string, ParsedBubbleWithInfo>
): Promise<AutoBindResult> {
  const bound: AutoBoundSlot[] = [];
  const requiredCredentials = extractRequiredCredentials(bubbleParameters);

  // Collect missing (bubbleKey, credentialType) slots before touching the DB.
  const missingSlots: Array<{
    bubbleKey: string;
    bubble: ParsedBubbleWithInfo;
    credentialType: CredentialType;
  }> = [];
  for (const [bubbleKey, types] of Object.entries(requiredCredentials)) {
    const bubble = bubbleParameters[bubbleKey];
    if (!bubble) continue;
    const alreadyBound = boundTypesForBubble(bubble);
    for (const credentialType of types) {
      if (SYSTEM_CREDENTIALS.has(credentialType)) continue;
      if (OPTIONAL_CREDENTIALS.has(credentialType)) continue;
      if (alreadyBound.has(credentialType)) continue;
      missingSlots.push({ bubbleKey, bubble, credentialType });
    }
  }
  if (missingSlots.length === 0) {
    return { bubbleParameters, bound };
  }

  const missingTypes = [
    ...new Set(missingSlots.map((slot) => slot.credentialType as string)),
  ];

  // Exact-type candidates: the user's credential rows of the missing types.
  const exactRows = await db
    .select({
      id: userCredentials.id,
      credentialType: userCredentials.credentialType,
    })
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        inArray(userCredentials.credentialType, missingTypes)
      )
    );
  const exactByType = new Map<string, number[]>();
  for (const row of exactRows) {
    const ids = exactByType.get(row.credentialType) ?? [];
    ids.push(row.id);
    exactByType.set(row.credentialType, ids);
  }

  // Derived-record candidates: parent credentials whose STORED records cover
  // the missing types (the API keeps these rows in lockstep with the granted
  // scopes, so no live probe is needed here).
  const derivedRows = await db
    .select({
      parentCredentialId: derivedCredentials.parentCredentialId,
      derivedCredentialType: derivedCredentials.derivedCredentialType,
    })
    .from(derivedCredentials)
    .where(
      and(
        eq(derivedCredentials.userId, userId),
        inArray(derivedCredentials.derivedCredentialType, missingTypes)
      )
    );
  const derivedByType = new Map<string, number[]>();
  for (const row of derivedRows) {
    const ids = derivedByType.get(row.derivedCredentialType) ?? [];
    if (!ids.includes(row.parentCredentialId)) ids.push(row.parentCredentialId);
    derivedByType.set(row.derivedCredentialType, ids);
  }

  for (const slot of missingSlots) {
    const exact = exactByType.get(slot.credentialType) ?? [];
    if (exact.length === 1) {
      bindCredentialOnBubble(slot.bubble, slot.credentialType, exact[0]);
      bound.push({
        bubbleKey: slot.bubbleKey,
        credentialType: slot.credentialType,
        credentialId: exact[0],
        match: 'exact_type',
      });
      continue;
    }
    if (exact.length > 1) continue;
    const derived = derivedByType.get(slot.credentialType) ?? [];
    if (derived.length === 1) {
      bindCredentialOnBubble(slot.bubble, slot.credentialType, derived[0]);
      bound.push({
        bubbleKey: slot.bubbleKey,
        credentialType: slot.credentialType,
        credentialId: derived[0],
        match: 'derived_record',
      });
    }
  }

  return { bubbleParameters, bound };
}
