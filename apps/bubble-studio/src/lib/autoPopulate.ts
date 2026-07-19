/**
 * Setup-field auto-population from saved credentials.
 *
 * A setup input whose value is knowable from an already-connected credential (e.g.
 * `gmailAccountEmail` when a Google credential carries the connected account's email in its
 * OAuth metadata) is PRE-FILLED instead of left blank — still editable, defaulted.
 *
 * Population is conservative: only values that are real account identifiers recorded on the
 * credential row (`metadata.email`, persisted by the API's Google OAuth callback via the OIDC
 * UserInfo endpoint) are used. A credential's display NAME is never guessed into an email
 * field. Fields the user already filled are never overwritten.
 *
 * Field → credential-type mapping reuses `getAccountCredentialTypesForField` (FU-8), so the
 * same heuristic drives both the account dropdown and the pre-filled default.
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
  source: 'oauth_account_email';
}

/** True when the input still needs a value (unset or blank — never overwrite user input). */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Compute the fields that can be pre-filled from saved credentials. Pure — callers apply the
 * results (and emit telemetry) themselves.
 */
export function computeAutoPopulatedFields(
  schemaFields: readonly AutoPopulateSchemaField[],
  credentials: readonly CredentialResponse[],
  currentInputs: Record<string, unknown>
): AutoPopulatedField[] {
  const populated: AutoPopulatedField[] = [];
  for (const field of schemaFields) {
    if (field.type !== undefined && field.type !== 'string') continue;
    if (!isBlank(currentInputs[field.name])) continue;

    const accountTypes = getAccountCredentialTypesForField(field.name);
    if (!accountTypes) continue;

    const match = credentials.find((cred) => {
      if (!accountTypes.includes(cred.credentialType as CredentialType)) {
        return false;
      }
      const metadata = cred.metadata as { email?: string } | undefined;
      return typeof metadata?.email === 'string' && metadata.email.length > 0;
    });
    if (!match) continue;

    const email = (match.metadata as { email: string }).email;
    populated.push({
      field: field.name,
      value: email,
      credentialId: match.id,
      credentialType: match.credentialType as CredentialType,
      credentialName: match.name,
      source: 'oauth_account_email',
    });
  }
  return populated;
}
