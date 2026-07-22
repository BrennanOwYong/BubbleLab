/**
 * Server-side deterministic credential auto-bind: the durable backstop that
 * makes auto-selected credentials correct on EVERY code path (create,
 * validation sync, Pearl generation save, manual run, webhook, cron, editor
 * load), not just an editor-mounted flow.
 *
 * Product rule: ONE credential per tool type — a flow that uses a tool
 * auto-uses the user's matching credential. For each required-credential slot
 * in bubbleParameters with no binding, the single BEST credential is chosen
 * deterministically:
 * 1. exact-type credentials win over derived coverage; among several, the
 *    most recently connected one (createdAt desc, id desc as the tiebreak),
 * 2. else credentials whose STORED derived-credential record covers the type
 *    (e.g. a Gmail credential whose granted scopes serve Google Sheets);
 *    among several covering parents (Gmail + Drive both covering Sheets), the
 *    most recently connected parent,
 * 3. zero candidates -> the slot stays unbound (nothing to bind; the studio's
 *    Connect affordance takes over).
 *
 * The bound credential_id ALWAYS points at the token-holding credential row
 * (the parent), never a derived record — execution resolves tokens by id.
 * Recency mirrors the studio's default-of-many rule, so the server and the
 * editor pick the same credential for the same state.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
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
 * Fill every unbound required-credential slot that has at least one covering
 * credential, picking the single best deterministically (see module doc).
 * Reads the database only when at least one slot is missing, so bound-through
 * flows cost nothing extra.
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

  // Exact-type candidates: the user's credential rows of the missing types,
  // most recently connected first (id desc breaks same-timestamp ties, so the
  // pick is total and deterministic).
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
    )
    .orderBy(desc(userCredentials.createdAt), desc(userCredentials.id));
  // First row seen per type = the most recently connected credential.
  const exactByType = new Map<string, number>();
  for (const row of exactRows) {
    if (!exactByType.has(row.credentialType)) {
      exactByType.set(row.credentialType, row.id);
    }
  }

  // Derived-record candidates: parent credentials whose STORED records cover
  // the missing types (the API keeps these rows in lockstep with the granted
  // scopes, so no live probe is needed here). Ordered by the PARENT
  // credential's connect time, so when several parents cover the same type
  // (e.g. Gmail + Drive both covering Sheets) the most recently connected
  // parent wins — one credential per tool, never a refusal.
  const derivedRows = await db
    .select({
      parentCredentialId: derivedCredentials.parentCredentialId,
      derivedCredentialType: derivedCredentials.derivedCredentialType,
    })
    .from(derivedCredentials)
    .innerJoin(
      userCredentials,
      eq(derivedCredentials.parentCredentialId, userCredentials.id)
    )
    .where(
      and(
        eq(derivedCredentials.userId, userId),
        inArray(derivedCredentials.derivedCredentialType, missingTypes)
      )
    )
    .orderBy(desc(userCredentials.createdAt), desc(userCredentials.id));
  const derivedByType = new Map<string, number>();
  for (const row of derivedRows) {
    if (!derivedByType.has(row.derivedCredentialType)) {
      derivedByType.set(row.derivedCredentialType, row.parentCredentialId);
    }
  }

  for (const slot of missingSlots) {
    const exactId = exactByType.get(slot.credentialType);
    if (exactId !== undefined) {
      bindCredentialOnBubble(slot.bubble, slot.credentialType, exactId);
      bound.push({
        bubbleKey: slot.bubbleKey,
        credentialType: slot.credentialType,
        credentialId: exactId,
        match: 'exact_type',
      });
      continue;
    }
    const parentId = derivedByType.get(slot.credentialType);
    if (parentId !== undefined) {
      bindCredentialOnBubble(slot.bubble, slot.credentialType, parentId);
      bound.push({
        bubbleKey: slot.bubbleKey,
        credentialType: slot.credentialType,
        credentialId: parentId,
        match: 'derived_record',
      });
    }
  }

  return { bubbleParameters, bound };
}
