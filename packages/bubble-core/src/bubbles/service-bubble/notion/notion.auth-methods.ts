/**
 * Doc-derived auth methods for the 'notion' bubble (IR-3/IR-4): OAuth for a
 * workspace connection (recommended) or pasting an internal integration
 * secret — NOTION_OAUTH_TOKEN vs NOTION_API become two methods of one app.
 *
 * Evidence quotes fetched 2026-07-15 from Notion's official docs; re-verify at
 * https://developers.notion.com/docs/authorization before editing.
 */
import { CredentialType } from '@bubblelab/shared-schemas';
import type { AppAuthMethods } from '@bubblelab/shared-schemas';
import { inferAuthMethods } from '../../../auth/infer-auth-methods.js';
import { bindInferredAuthMethods } from '../../../auth/connect-ui-spec.js';

const NOTION_AUTH_INFERENCE = inferAuthMethods([
  {
    kind: 'prose',
    docText:
      'Public connections use the OAuth 2.0 protocol. Internal connections use a static installation access token: include the installation access token in the Authorization header with every API request.',
    citation:
      'https://developers.notion.com/docs/authorization — "public connections use the OAuth 2.0 protocol"; "include the installation access token in the Authorization header with every API request"',
  },
]);

export const NOTION_AUTH_METHODS: AppAuthMethods = bindInferredAuthMethods(
  NOTION_AUTH_INFERENCE,
  [
    {
      kind: 'oauth2',
      credentialType: CredentialType.NOTION_OAUTH_TOKEN,
      displayName: 'Connect Notion workspace (OAuth)',
      description:
        'Authorize BubbleLab in a Notion popup and choose which pages it can access.',
      // Notion access is governed by page/database sharing, not OAuth scopes.
      scopes: [],
      // Verifier: GET /v1/users/me returns the bot user for the token.
      // https://developers.notion.com/reference/get-self
      testRequest: { url: 'https://api.notion.com/v1/users/me', method: 'GET' },
    },
    {
      kind: 'api_key',
      credentialType: CredentialType.NOTION_API,
      displayName: 'Paste an internal integration secret',
      description:
        'Paste the secret from your internal Notion integration (Settings → Connections → Develop or manage integrations).',
      placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
      secretLabel: 'Internal integration secret',
      secretPlaceholder: 'ntn_... or secret_...',
      testRequest: { url: 'https://api.notion.com/v1/users/me', method: 'GET' },
    },
  ]
);
