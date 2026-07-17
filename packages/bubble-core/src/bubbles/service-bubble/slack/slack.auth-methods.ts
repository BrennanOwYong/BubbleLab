/**
 * Doc-derived auth methods for the 'slack' bubble (IR-3/IR-4).
 *
 * Slack's SLACK_CRED (OAuth) vs SLACK_API (pasted bot token) were two
 * overlapping credential systems for one app. Here they become two METHODS of
 * one app: OAuth with a scope picker (recommended) or pasting a bot token,
 * and the user's pick decides which CredentialType is created.
 *
 * Evidence quotes fetched 2026-07-15 from Slack's official docs; re-verify
 * there before editing:
 * - https://docs.slack.dev/authentication/tokens/ (token types)
 * - https://docs.slack.dev/apis/web-api/ (bearer usage)
 */
import {
  CredentialType,
  getScopeDescriptions,
} from '@bubblelab/shared-schemas';
import type { AppAuthMethods } from '@bubblelab/shared-schemas';
import { inferAuthMethods } from '../../../auth/infer-auth-methods.js';
import { bindInferredAuthMethods } from '../../../auth/connect-ui-spec.js';

const SLACK_AUTH_INFERENCE = inferAuthMethods([
  {
    kind: 'prose',
    docText:
      'Installing with OAuth. We prefer tokens to be sent in the Authorization HTTP header of your outbound requests: Authorization: Bearer xoxp-xxxxxxxxx-xxxx. OAuth 2.0 is used to obtain tokens.',
    citation:
      'https://docs.slack.dev/apis/web-api/ — "transmit your token as a bearer token in the Authorization HTTP header"; https://docs.slack.dev/authentication/installing-with-oauth/',
  },
  {
    kind: 'prose',
    docText:
      'Bot tokens ascribe to a granular permission model to request only the scopes you need. User tokens represent workspace members.',
    citation:
      'https://docs.slack.dev/authentication/tokens/ — "Bot tokens ascribe to a granular permission model to request only the scopes you need."',
  },
]);

export const SLACK_AUTH_METHODS: AppAuthMethods = bindInferredAuthMethods(
  SLACK_AUTH_INFERENCE,
  [
    {
      kind: 'oauth2',
      credentialType: CredentialType.SLACK_CRED,
      displayName: 'Connect Slack workspace (OAuth)',
      description:
        'Approve BubbleLab in a Slack popup and pick the permissions to grant — no token handling.',
      scopes: getScopeDescriptions(CredentialType.SLACK_CRED).map(
        ({ scope, description, defaultEnabled }) => ({
          scope,
          description,
          defaultEnabled,
        })
      ),
      // Slack's token verifier: https://docs.slack.dev/reference/methods/auth.test
      testRequest: { url: 'https://slack.com/api/auth.test', method: 'POST' },
    },
    {
      kind: 'api_key',
      credentialType: CredentialType.SLACK_API,
      displayName: 'Paste a bot token',
      description:
        'Paste an xoxb- bot token from your Slack app config. Use this when you already run your own Slack app.',
      placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
      secretLabel: 'Bot token',
      secretPlaceholder: 'xoxb-...',
      testRequest: { url: 'https://slack.com/api/auth.test', method: 'POST' },
    },
  ]
);
