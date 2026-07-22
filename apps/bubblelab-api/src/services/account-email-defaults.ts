/**
 * Account-email defaults for flow setup fields (the gmailAccountEmail 0/1/many
 * rule, server-side).
 *
 * A setup field naming an account (e.g. `gmailAccountEmail`) should default to
 * the account email of the user's credential for that tool — but only when the
 * choice is unambiguous. Per required credential type:
 * - exactly ONE credential of that type AND it carries `metadata.email`
 *   (persisted by the Google OAuth callback / lazy backfill via OIDC UserInfo)
 *   -> that email is the default,
 * - zero or several credentials, or a sole credential without a recorded
 *   email -> no entry; the field stays blank and the user picks.
 *
 * The map rides the GET /bubble-flow/:id response as `accountEmailDefaults`
 * (see bubbleFlowDetailsResponseSchema), keyed by credential type so the
 * studio's field->credential-type heuristic can look defaults up directly.
 * The runtime never consumes the value — Gmail/Sheets bubbles authenticate
 * with the OAuth token alone (`users/me`); this is display/default metadata.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import {
  SYSTEM_CREDENTIALS,
  OPTIONAL_CREDENTIALS,
  type CredentialType,
} from '@bubblelab/shared-schemas';
import { extractMetadataEmail } from './oauth-service.js';

/**
 * Resolve, per required credential type, the account email a setup field
 * should default to. `requiredCredentials` is the bubbleKey -> credential
 * types map produced by `extractRequiredCredentials`.
 */
export async function resolveAccountEmailDefaults(
  userId: string,
  requiredCredentials: Record<string, CredentialType[]>
): Promise<Record<string, string>> {
  const requiredTypes = [
    ...new Set(
      Object.values(requiredCredentials)
        .flat()
        .filter(
          (type) =>
            !SYSTEM_CREDENTIALS.has(type) && !OPTIONAL_CREDENTIALS.has(type)
        )
    ),
  ];
  if (requiredTypes.length === 0) return {};

  const rows = await db
    .select({
      credentialType: userCredentials.credentialType,
      metadata: userCredentials.metadata,
    })
    .from(userCredentials)
    .where(
      and(
        eq(userCredentials.userId, userId),
        inArray(userCredentials.credentialType, requiredTypes as string[])
      )
    );

  const byType = new Map<string, { count: number; email?: string }>();
  for (const row of rows) {
    const entry = byType.get(row.credentialType) ?? { count: 0 };
    entry.count += 1;
    if (entry.count === 1) {
      entry.email = extractMetadataEmail(row.metadata);
    } else {
      entry.email = undefined; // several credentials: ambiguous, no default
    }
    byType.set(row.credentialType, entry);
  }

  const defaults: Record<string, string> = {};
  for (const [credentialType, entry] of byType) {
    if (entry.count === 1 && entry.email) {
      defaults[credentialType] = entry.email;
    }
  }
  return defaults;
}
