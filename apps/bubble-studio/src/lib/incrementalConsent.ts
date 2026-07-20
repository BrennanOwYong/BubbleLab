/**
 * Incremental OAuth re-consent runner: adds MISSING scopes to an EXISTING
 * credential's grant. The API authorizes with Google's
 * include_granted_scopes=true (the returned token also covers every previously
 * granted scope) and the callback UPDATES the credential row — no new
 * credential row is created and existing bindings keep working.
 *
 * Popup mechanics mirror CredentialsPage's connect flow: the provider redirects
 * to the API callback, the API redirects the popup to the frontend, and
 * OAuthCallback writes `oauthResult` into this window's sessionStorage before
 * closing the popup.
 *
 * Reference (incremental authorization / include_granted_scopes):
 * https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth
 */
import { credentialsApi } from '../services/credentialsApi';

export interface IncrementalConsentInput {
  provider: string;
  /** The existing credential row the scopes are ADDED to. */
  credentialId: number;
  /** The credential row's own type (the API re-derives it server-side). */
  credentialType: string;
  /** The missing scopes to request; prior grants accumulate automatically. */
  scopes: string[];
}

export interface IncrementalConsentResult {
  success: boolean;
  error?: string;
}

const POPUP_POLL_INTERVAL_MS = 1000;

export async function runIncrementalConsent(
  input: IncrementalConsentInput
): Promise<IncrementalConsentResult> {
  const { authUrl } = await credentialsApi.initiateOAuth(
    input.provider,
    input.credentialType,
    undefined,
    input.scopes,
    input.credentialId
  );

  const popup = window.open(
    authUrl,
    'oauth-popup',
    'width=500,height=600,scrollbars=yes,resizable=yes'
  );
  if (!popup) {
    return {
      success: false,
      error: 'Popup blocked — allow popups for this site and retry',
    };
  }

  return new Promise<IncrementalConsentResult>((resolve) => {
    const checkClosed = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(checkClosed);
      const oauthResult = sessionStorage.getItem('oauthResult');
      if (!oauthResult) {
        resolve({ success: false, error: 'Re-consent was cancelled' });
        return;
      }
      sessionStorage.removeItem('oauthResult');
      try {
        const result = JSON.parse(oauthResult) as {
          success?: boolean;
          error?: string;
        };
        resolve(
          result.success === true
            ? { success: true }
            : { success: false, error: result.error ?? 'Re-consent failed' }
        );
      } catch {
        resolve({ success: false, error: 'Unreadable re-consent result' });
      }
    }, POPUP_POLL_INTERVAL_MS);
  });
}
