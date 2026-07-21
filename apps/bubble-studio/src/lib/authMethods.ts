/**
 * Studio-side Connect UI helpers (IR-3/IR-4, FU-7, FU-8).
 *
 * Builds ConnectUiMethodOption lists per app so the Connect UI offers EVERY
 * auth method an app supports (e.g. Slack OAuth vs Slack bot token) instead of
 * one-method-per-credential-type.
 *
 * STUB NOTE: the authoritative per-bubble descriptors live in
 * @bubblelab/bubble-core (*.auth-methods.ts, served by
 * BubbleFactory.getMetadata().authMethods / buildConnectUiSpec). The studio
 * cannot import bubble-core (Node-only deps), and no API endpoint exposes the
 * ConnectUiSpec yet. Until that endpoint exists this module synthesizes
 * equivalent options from shared-schemas data (CREDENTIAL_TYPE_CONFIG,
 * OAUTH_PROVIDERS) plus a small kind-override table. Replace with an API fetch
 * when the backend exposes GET /bubbles/:name/connect-ui-spec.
 */
import {
  CredentialType,
  CREDENTIAL_TYPE_CONFIG,
  isOAuthCredential,
  isBrowserSessionCredential,
  getScopeDescriptions,
  sortByConvenience,
} from '@bubblelab/shared-schemas';
import type {
  AuthMethodKind,
  ConnectUiMethodOption,
  CredentialResponse,
} from '@bubblelab/shared-schemas';

/**
 * Apps that offer more than one way to sign in. Each group is ONE app; the
 * user picks a method and that decides which CredentialType gets created.
 * Mirrors the *.auth-methods.ts descriptors in bubble-core.
 */
const APP_METHOD_GROUPS: CredentialType[][] = [
  [CredentialType.SLACK_CRED, CredentialType.SLACK_API],
  [CredentialType.NOTION_OAUTH_TOKEN, CredentialType.NOTION_API],
  [CredentialType.AIRTABLE_OAUTH, CredentialType.AIRTABLE_CRED],
];

/** Kind overrides where the generic oauth/api_key guess is wrong. */
const KIND_OVERRIDES: Partial<Record<CredentialType, AuthMethodKind>> = {
  [CredentialType.SLACK_API]: 'api_key', // bot token pasted from api.slack.com
  [CredentialType.NOTION_API]: 'api_key', // internal integration secret
  [CredentialType.GITHUB_TOKEN]: 'pat',
  [CredentialType.DATABASE_CRED]: 'connection_string',
  [CredentialType.TELEGRAM_BOT_TOKEN]: 'api_key',
  [CredentialType.AIRTABLE_CRED]: 'pat',
};

function kindForCredentialType(type: CredentialType): AuthMethodKind {
  if (KIND_OVERRIDES[type]) return KIND_OVERRIDES[type] as AuthMethodKind;
  if (isOAuthCredential(type)) return 'oauth2';
  if (isBrowserSessionCredential(type)) return 'browser_session';
  return 'api_key';
}

/** All credential types belonging to the same app as `type` (self included). */
export function getAppCredentialTypes(type: CredentialType): CredentialType[] {
  const group = APP_METHOD_GROUPS.find((g) => g.includes(type));
  return group ?? [type];
}

/**
 * Every auth method the app owning `type` supports, most convenient first,
 * exactly one marked recommended. Shape matches ConnectUiSpec.methods.
 */
export function getConnectUiMethods(
  type: CredentialType
): ConnectUiMethodOption[] {
  const types = getAppCredentialTypes(type);
  const descriptors = types.map((credentialType) => {
    const config = CREDENTIAL_TYPE_CONFIG[credentialType];
    const kind = kindForCredentialType(credentialType);
    return {
      kind,
      credentialType,
      displayName:
        kind === 'oauth2'
          ? 'Sign in with OAuth (recommended for most users)'
          : kind === 'pat'
            ? 'Paste a personal access token'
            : kind === 'connection_string'
              ? 'Paste a connection string'
              : kind === 'browser_session'
                ? 'Log in through a guided browser session'
                : 'Paste an API key / token',
      description: config?.description,
      unverified: false,
    };
  });
  const sorted = sortByConvenience(descriptors);
  return sorted.map((d, index) => ({
    kind: d.kind,
    credentialType: d.credentialType,
    displayName: d.displayName,
    description: d.description,
    rank: index + 1,
    recommended: index === 0,
    collect: {
      kind: d.kind,
      scopes:
        d.kind === 'oauth2'
          ? getScopeDescriptions(d.credentialType).map((s) => ({
              scope: s.scope,
              description: s.description,
              defaultEnabled: s.defaultEnabled,
            }))
          : undefined,
    },
    source: 'manual' as const,
    citation:
      'Synthesized in-studio from CREDENTIAL_TYPE_CONFIG; authoritative descriptors: bubble-core *.auth-methods.ts',
  }));
}

// ── FU-7: Google suite ───────────────────────────────────────────────────────

/**
 * The Google credential types that share the single 'google' OAuth provider.
 * One Google sign-in with combined scopes covers every selected service.
 */
export const GOOGLE_SUITE_TYPES: CredentialType[] = [
  CredentialType.GMAIL_CRED,
  CredentialType.GOOGLE_DRIVE_CRED,
  CredentialType.GOOGLE_SHEETS_CRED,
  CredentialType.GOOGLE_CALENDAR_CRED,
];

export function isGoogleSuiteCredential(type: CredentialType): boolean {
  return GOOGLE_SUITE_TYPES.includes(type);
}

// ── FU-8: account dropdowns for flow inputs ─────────────────────────────────

/** Service hints inside a field name → the credential types whose connected
 * accounts can fill it. */
const ACCOUNT_FIELD_SERVICES: Array<{
  pattern: RegExp;
  types: CredentialType[];
}> = [
  { pattern: /gmail/i, types: [CredentialType.GMAIL_CRED] },
  { pattern: /calendar/i, types: [CredentialType.GOOGLE_CALENDAR_CRED] },
  { pattern: /drive/i, types: [CredentialType.GOOGLE_DRIVE_CRED] },
  { pattern: /sheets?/i, types: [CredentialType.GOOGLE_SHEETS_CRED] },
  { pattern: /google/i, types: GOOGLE_SUITE_TYPES },
];

/**
 * Decide whether a flow-input field names an account (gmailAccountEmail,
 * calendar_account, googleEmail, ...). Returns the credential types whose
 * connected accounts should populate the dropdown, or null for free text.
 */
export function getAccountCredentialTypesForField(
  fieldName: string
): CredentialType[] | null {
  if (!/account|email/i.test(fieldName)) return null;
  for (const { pattern, types } of ACCOUNT_FIELD_SERVICES) {
    if (pattern.test(fieldName)) return types;
  }
  return null;
}

export interface AccountOption {
  value: string;
  label: string;
}

/** Dropdown options from the user's connected credentials of the given types.
 * OAuth metadata carries the account email; the credential name is the
 * fallback. */
export function getAccountOptions(
  credentials: CredentialResponse[],
  types: CredentialType[]
): AccountOption[] {
  const seen = new Set<string>();
  const options: AccountOption[] = [];
  for (const cred of credentials) {
    if (!types.includes(cred.credentialType as CredentialType)) continue;
    const metadata = cred.metadata as { email?: string } | undefined;
    const value = metadata?.email ?? cred.name ?? '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: metadata?.email
        ? `${metadata.email}${cred.name ? ` (${cred.name})` : ''}`
        : (cred.name ?? value),
    });
  }
  return options;
}
