/**
 * Setup-field auto-population from saved credentials.
 *
 * A setup input that names an account (e.g. `gmailAccountEmail`) REFERENCES the
 * credential serving that account: the field pre-fills from the credential the
 * flow's steps are bound to (falling back to any connected credential of the
 * matching types), so it is never blank while a credential is bound — still
 * editable, defaulted.
 *
 * Value precedence per credential: the account email recorded on the row
 * (`metadata.email`, persisted by the API's Google OAuth callback / backfill
 * via the OIDC UserInfo endpoint), else the credential's display NAME. The
 * name fallback exists because the Gmail/Sheets bubbles authenticate with the
 * OAuth token alone (`users/me` endpoints) — the field is display metadata,
 * and a visible credential reference beats an empty box that blocks the run.
 * The `source` field distinguishes the two so consumers can offer a
 * "reconnect to add the account email" upgrade for name-sourced values.
 * Nothing is ever invented: both values are real stored data off the
 * credential row. Fields the user already filled are never overwritten.
 *
 * Field → credential-type mapping reuses `getAccountCredentialTypesForField`
 * (FU-8), so the same heuristic drives the account dropdown and the
 * pre-filled default.
 */
import type { CredentialResponse } from '@bubblelab/shared-schemas';
import { getAccountCredentialTypesForField } from './authMethods';
import type { CredentialType } from '@bubblelab/shared-schemas';

export interface AutoPopulateSchemaField {
  name: string;
  type?: string;
}

export interface AutoPopulatedField {
  field: string;
  value: string;
  credentialId: number;
  credentialType: CredentialType;
  credentialName?: string;
  source: 'oauth_account_email' | 'credential_name';
}

/** True when the input still needs a value (unset or blank — never overwrite user input). */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function metadataEmail(credential: CredentialResponse): string | undefined {
  const metadata = credential.metadata as { email?: string } | undefined;
  return typeof metadata?.email === 'string' && metadata.email.length > 0
    ? metadata.email
    : undefined;
}

/**
 * The credential a field should reference, among those whose type matches the
 * field's account types: a step-bound credential wins (the field then mirrors
 * what the flow will run with), email-carrying rows break ties, connected
 * order breaks the rest.
 */
export function pickReferenceCredential(
  candidates: readonly CredentialResponse[],
  boundCredentialIds: ReadonlySet<number>
): CredentialResponse | undefined {
  const bound = candidates.filter((cred) => boundCredentialIds.has(cred.id));
  const pool = bound.length > 0 ? bound : candidates;
  return pool.find((cred) => metadataEmail(cred) !== undefined) ?? pool[0];
}

/**
 * Compute the fields that can be pre-filled from saved credentials. Pure — callers apply the
 * results (and emit telemetry) themselves.
 */
export function computeAutoPopulatedFields(
  schemaFields: readonly AutoPopulateSchemaField[],
  credentials: readonly CredentialResponse[],
  currentInputs: Record<string, unknown>,
  boundCredentialIds: ReadonlySet<number> = new Set()
): AutoPopulatedField[] {
  const populated: AutoPopulatedField[] = [];
  for (const field of schemaFields) {
    if (field.type !== undefined && field.type !== 'string') continue;
    if (!isBlank(currentInputs[field.name])) continue;

    const accountTypes = getAccountCredentialTypesForField(field.name);
    if (!accountTypes) continue;

    const candidates = credentials.filter((cred) =>
      accountTypes.includes(cred.credentialType as CredentialType)
    );
    const match = pickReferenceCredential(candidates, boundCredentialIds);
    if (!match) continue;

    const email = metadataEmail(match);
    const value = email ?? match.name;
    if (!value) continue;
    populated.push({
      field: field.name,
      value,
      credentialId: match.id,
      credentialType: match.credentialType as CredentialType,
      credentialName: match.name,
      source: email ? 'oauth_account_email' : 'credential_name',
    });
  }
  return populated;
}
