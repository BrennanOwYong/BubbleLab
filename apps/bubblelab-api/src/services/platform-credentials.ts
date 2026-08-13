/**
 * Effective credential classification (S1): a declared-SYSTEM credential type
 * is *platform-provided* only when the platform can actually inject it — its
 * env var (per CREDENTIAL_ENV_MAP, with the credential-type spelling accepted
 * as a fallback) is set on this process. Declared-SYSTEM types with no env
 * backing behave as USER credentials everywhere: auto-bind/heal serves them,
 * the studio shows a Setup card and a dropdown default, and Execute blocks
 * until one is connected — identical to GOOGLE_DRIVE_CRED.
 *
 * Cached once per process (env does not change at runtime; a changed .env
 * needs an API restart, same as execution.ts env reads).
 */
import {
  SYSTEM_CREDENTIALS,
  getPlatformProvidedCredentials,
  type CredentialType,
} from '@bubblelab/shared-schemas';

let cached: Set<CredentialType> | null = null;

export function platformProvidedCredentialTypes(): ReadonlySet<CredentialType> {
  if (!cached) {
    cached = getPlatformProvidedCredentials(process.env);
    const reclassified = [...SYSTEM_CREDENTIALS]
      .filter((type) => !cached!.has(type))
      .sort();
    // Observable classification event (Pillar 2): one log per process states
    // which declared-SYSTEM types the platform backs and which now behave as
    // user credentials.
    console.log(
      `[platform-credentials] platform-provided: [${[...cached].sort().join(', ')}]; declared-SYSTEM reclassified as user credentials: [${reclassified.join(', ')}]`
    );
  }
  return cached;
}

/** Test seam: forget the cached classification so env changes take effect. */
export function resetPlatformProvidedCredentialTypes(): void {
  cached = null;
}
