/**
 * Derived-credential persistence: materializes "credential X's granted scopes
 * also serve sibling type Y" (suite coverage) as rows in `derived_credentials`
 * instead of recomputing it in every consumer.
 *
 * The coverage computation itself is `computeScopeCoverage` in shared-schemas —
 * the one implementation the studio's labels, the suite binding, and these
 * records all descend from. This service owns keeping the STORED records in
 * lockstep with the parent credential's `oauth_scopes`:
 * - connect (storeOAuthToken) and re-consent (applyIncrementalToken) sync after
 *   writing the probed grant,
 * - scope-sync (checkGrantedScopes probe) syncs after overwriting oauth_scopes,
 * - GET /credentials lazily backfills rows for credentials connected before
 *   this table existed (diff-only writes, no network),
 * - a revoked scope drops the record on the next sync; deleting the parent
 *   credential cascades the rows away (FK).
 */
import {
  computeScopeCoverage,
  getOAuthProvider,
  CredentialType,
} from '@bubblelab/shared-schemas';
import type { DerivedCredentialRecord } from '@bubblelab/shared-schemas';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { derivedCredentials, userCredentials } from '../db/schema.js';

/** The parent-credential columns the sync needs (subset of user_credentials). */
export interface DerivedSyncSource {
  id: number;
  userId: string;
  credentialType: string;
  isOauth: boolean | null;
  oauthProvider: string | null;
  oauthScopes: string[] | null;
}

/** The stored rows for one parent, as the API response record shape. */
function toRecord(row: {
  id: number;
  parentCredentialId: number;
  derivedCredentialType: string;
  provider: string;
  isDerived: boolean;
}): DerivedCredentialRecord {
  return {
    id: row.id,
    parentCredentialId: row.parentCredentialId,
    derivedCredentialType: row.derivedCredentialType,
    provider: row.provider,
    isDerived: row.isDerived,
  };
}

/**
 * The derived types the parent credential's CURRENT granted scopes cover.
 * Empty for non-OAuth rows, types outside a multi-type provider group, and
 * empty grants.
 */
export function computeDesiredDerivedTypes(
  source: DerivedSyncSource
): string[] {
  if (source.isOauth !== true) return [];
  const ownType = source.credentialType as CredentialType;
  return computeScopeCoverage(ownType, source.oauthScopes ?? [])
    .filter((entry) => entry.covered)
    .map((entry) => entry.credentialType as string);
}

/**
 * Reconcile the stored derived rows for one parent credential with its current
 * granted scopes: insert newly covered types, delete no-longer-covered ones.
 * Diff-only — an in-sync parent causes zero writes, so this is safe on hot
 * read paths (GET /credentials backfill). Returns the current rows.
 */
export async function syncDerivedCredentialsForSource(
  source: DerivedSyncSource
): Promise<DerivedCredentialRecord[]> {
  const provider =
    source.oauthProvider ??
    getOAuthProvider(source.credentialType as CredentialType) ??
    'unknown';
  const desired = new Set(computeDesiredDerivedTypes(source));

  const existing = await db.query.derivedCredentials.findMany({
    where: eq(derivedCredentials.parentCredentialId, source.id),
  });
  const existingTypes = new Set(
    existing.map((row) => row.derivedCredentialType)
  );

  const toInsert = [...desired].filter((type) => !existingTypes.has(type));
  const toDelete = existing
    .filter((row) => !desired.has(row.derivedCredentialType))
    .map((row) => row.id);

  if (toInsert.length > 0) {
    await db
      .insert(derivedCredentials)
      .values(
        toInsert.map((derivedCredentialType) => ({
          parentCredentialId: source.id,
          userId: source.userId,
          derivedCredentialType,
          provider,
          isDerived: true,
        }))
      )
      // Unique (parent, derived type) guards concurrent syncs of the same parent.
      .onConflictDoNothing();
  }
  if (toDelete.length > 0) {
    await db
      .delete(derivedCredentials)
      .where(inArray(derivedCredentials.id, toDelete));
  }

  if (toInsert.length === 0 && toDelete.length === 0) {
    return existing.map(toRecord);
  }
  const current = await db.query.derivedCredentials.findMany({
    where: eq(derivedCredentials.parentCredentialId, source.id),
  });
  return current.map(toRecord);
}

/**
 * Sync by credential id (write-path callers that only hold the id). A missing
 * or non-owned row syncs nothing and returns [].
 */
export async function syncDerivedCredentialsById(
  credentialId: number
): Promise<DerivedCredentialRecord[]> {
  const credential = await db.query.userCredentials.findFirst({
    where: eq(userCredentials.id, credentialId),
  });
  if (!credential) return [];
  return syncDerivedCredentialsForSource({
    id: credential.id,
    userId: credential.userId,
    credentialType: credential.credentialType,
    isOauth: credential.isOauth,
    oauthProvider: credential.oauthProvider,
    oauthScopes: credential.oauthScopes,
  });
}
