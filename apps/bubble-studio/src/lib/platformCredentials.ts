/**
 * Effective credential classification (S1), studio side. The API's
 * GET /credentials/platform-types reports which declared-SYSTEM credential
 * types its environment actually backs; every binding surface (Setup tab,
 * node dropdown, auto-bind, suite proposals, run gate, chat cred widget,
 * curated node view) consults isPlatformProvided instead of the raw
 * SYSTEM_CREDENTIALS set, so a declared-SYSTEM type the platform cannot
 * provide (e.g. FIRECRAWL_API_KEY with no server env) binds/defaults/shows
 * like any user credential.
 *
 * Fallback: while the server set has not loaded, the declared
 * SYSTEM_CREDENTIALS set answers — the conservative pre-load behavior, so
 * env-backed credentials never flash a "Missing" badge.
 */
import {
  SYSTEM_CREDENTIALS,
  type CredentialType,
} from '@bubblelab/shared-schemas';

let loadedPlatformTypes: ReadonlySet<string> | null = null;

/**
 * Store the server-reported platform-provided set. Called by
 * usePlatformCredentialTypes on query success; pure call sites (flow
 * validation, curated view derivation) read it through isPlatformProvided.
 */
export function setPlatformCredentialTypes(
  types: readonly string[] | null
): void {
  loadedPlatformTypes = types === null ? null : new Set(types);
}

/** The currently loaded server set, when the query has answered. */
export function getLoadedPlatformCredentialTypes(): ReadonlySet<string> | null {
  return loadedPlatformTypes;
}

/**
 * Whether the platform provides this credential type from its own env.
 * `platformTypes` overrides (pure/unit-test call sites thread it); otherwise
 * the module-cached server set answers; otherwise the declared
 * SYSTEM_CREDENTIALS fallback.
 */
export function isPlatformProvided(
  credentialType: string,
  platformTypes?: ReadonlySet<string> | null
): boolean {
  const effective =
    platformTypes !== undefined ? platformTypes : loadedPlatformTypes;
  if (effective) return effective.has(credentialType);
  return SYSTEM_CREDENTIALS.has(credentialType as CredentialType);
}
