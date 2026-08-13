/**
 * connectCredentialViaPopup — open the OAuth consent popup for a credential
 * type and resolve once a real result is known.
 *
 * Used by the in-conversation "Connect" button (the builder agent's
 * report_missing_credential affordance) so the user can add a missing
 * credential without leaving the chat. Mirrors CreateCredentialModal's OAuth
 * handling in pages/CredentialsPage.tsx exactly: after the popup closes, it
 * reads the `oauthResult` sessionStorage key written by OAuthCallback.tsx
 * (success with the created credential, or a real failure message) rather
 * than assuming a closed popup means success. A popup closed without ever
 * writing a result (abandoned/cancelled) is reported as cancelled, not
 * silently treated as connected.
 */
import { getOAuthProvider } from '@bubblelab/shared-schemas';
import type {
  CredentialResponse,
  CredentialType,
} from '@bubblelab/shared-schemas';
import { credentialsApi } from '../services/credentialsApi';

interface OAuthPopupResult {
  success: boolean;
  error?: string;
  credential?: CredentialResponse;
}

export async function connectCredentialViaPopup(
  credentialType: string
): Promise<CredentialResponse | undefined> {
  const provider = getOAuthProvider(credentialType as CredentialType);
  if (!provider) {
    throw new Error(
      `${credentialType} is not an OAuth credential; add it from the Setup tab.`
    );
  }

  const { authUrl, state } = await credentialsApi.initiateOAuth(
    provider,
    credentialType,
    credentialType
  );

  // The client-side OAuth callback reads this to match the returning popup.
  sessionStorage.setItem(
    'pendingOAuthCredential',
    JSON.stringify({ name: credentialType, credentialType, state })
  );

  const popup = window.open(
    authUrl,
    'oauth-popup',
    'width=500,height=600,scrollbars=yes,resizable=yes'
  );

  return new Promise<CredentialResponse | undefined>((resolve, reject) => {
    const checkClosed = setInterval(() => {
      if (!popup?.closed) return;
      clearInterval(checkClosed);

      const oauthResult = sessionStorage.getItem('oauthResult');
      if (!oauthResult) {
        sessionStorage.removeItem('pendingOAuthCredential');
        reject(new Error('OAuth connection was cancelled'));
        return;
      }

      sessionStorage.removeItem('oauthResult');
      sessionStorage.removeItem('pendingOAuthCredential');

      const result = JSON.parse(oauthResult) as OAuthPopupResult;
      if (result.success) {
        resolve(result.credential);
      } else {
        reject(new Error(result.error || 'OAuth connection failed'));
      }
    }, 600);
  });
}
