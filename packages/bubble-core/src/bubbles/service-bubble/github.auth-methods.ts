/**
 * Doc-derived auth methods for the 'github' bubble (IR-3/IR-4): a personal
 * access token is the one supported sign-in today (GITHUB_TOKEN).
 *
 * Evidence quotes fetched 2026-07-15 from GitHub's official docs; re-verify at
 * https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
 * before editing.
 */
import { CredentialType } from '@bubblelab/shared-schemas';
import type { AppAuthMethods } from '@bubblelab/shared-schemas';
import { inferAuthMethods } from '../../auth/infer-auth-methods.js';
import { bindInferredAuthMethods } from '../../auth/connect-ui-spec.js';

const GITHUB_AUTH_INFERENCE = inferAuthMethods([
  {
    kind: 'prose',
    docText:
      'Personal access tokens act as your identity (limited by the scopes or permissions you selected) when you make requests to the REST API. You can authenticate your request by sending the token in the Authorization header of your request: Authorization: Bearer YOUR-TOKEN.',
    citation:
      'https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api — "Personal access tokens act as your identity … when you make requests to the REST API"',
  },
]);

export const GITHUB_AUTH_METHODS: AppAuthMethods = bindInferredAuthMethods(
  GITHUB_AUTH_INFERENCE,
  [
    {
      kind: 'pat',
      credentialType: CredentialType.GITHUB_TOKEN,
      displayName: 'Paste a personal access token',
      description:
        'Create a fine-grained personal access token at github.com/settings/tokens and paste it here.',
      placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
      secretLabel: 'Personal access token',
      secretPlaceholder: 'github_pat_... or ghp_...',
      // GET /user identifies the authenticated user — a working-token probe.
      testRequest: { url: 'https://api.github.com/user', method: 'GET' },
    },
  ]
);
