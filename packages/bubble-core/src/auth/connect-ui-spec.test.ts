import { describe, it, expect } from 'vitest';
import {
  applyScopeRequirementsToConnectUiSpec,
  buildConnectUiSpec,
  resolveAuthChoice,
  strategyForDescriptor,
} from './connect-ui-spec.js';
import type { DiscoveredScopeRequirement } from '@bubblelab/shared-schemas';
import { SLACK_AUTH_METHODS } from '../bubbles/service-bubble/slack/slack.auth-methods.js';
import { NOTION_AUTH_METHODS } from '../bubbles/service-bubble/notion/notion.auth-methods.js';
import { GITHUB_AUTH_METHODS } from '../bubbles/service-bubble/github.auth-methods.js';
import { POSTGRESQL_AUTH_METHODS } from '../bubbles/service-bubble/postgresql.auth-methods.js';
import { SlackBubble } from '../bubbles/service-bubble/slack/slack.js';
import { GithubBubble } from '../bubbles/service-bubble/github.js';
import { NotionBubble } from '../bubbles/service-bubble/notion/notion.js';
import { PostgreSQLBubble } from '../bubbles/service-bubble/postgresql.js';
import type {
  AuthHttpTransport,
  OutboundAuthRequest,
} from './auth-method-strategy.js';
import {
  AppAuthMethodsSchema,
  BUBBLE_CREDENTIAL_OPTIONS,
  ConnectUiSpecSchema,
  CredentialType,
} from '@bubblelab/shared-schemas';

const APP_METHOD_FILES = [
  { bubbleName: 'slack', methods: SLACK_AUTH_METHODS },
  { bubbleName: 'notion', methods: NOTION_AUTH_METHODS },
  { bubbleName: 'github', methods: GITHUB_AUTH_METHODS },
  { bubbleName: 'postgresql', methods: POSTGRESQL_AUTH_METHODS },
] as const;

describe('one app, several sign-in methods, most convenient first (acceptance criterion)', () => {
  it('slack offers TWO methods — OAuth (recommended) and a pasted bot token', () => {
    const spec = buildConnectUiSpec('slack', SLACK_AUTH_METHODS);
    expect(spec.methods).toHaveLength(2);
    expect(spec.methods.map((m) => m.kind)).toEqual(['oauth2', 'api_key']);
    expect(spec.recommendedKind).toBe('oauth2');
    expect(spec.methods[0]?.recommended).toBe(true);
    expect(spec.methods[1]?.recommended).toBe(false);
    // The two methods bind to the two previously-confusing credential systems.
    expect(spec.methods[0]?.credentialType).toBe(CredentialType.SLACK_CRED);
    expect(spec.methods[1]?.credentialType).toBe(CredentialType.SLACK_API);
  });

  it('notion also offers two methods, OAuth recommended over the integration secret', () => {
    const spec = buildConnectUiSpec('notion', NOTION_AUTH_METHODS);
    expect(spec.methods.map((m) => m.kind)).toEqual(['oauth2', 'api_key']);
    expect(spec.methods[0]?.credentialType).toBe(
      CredentialType.NOTION_OAUTH_TOKEN
    );
    expect(spec.methods[1]?.credentialType).toBe(CredentialType.NOTION_API);
  });

  it('the Connect UI spec renders from collect(): scope picker for oauth2, secret field for api_key', () => {
    const spec = buildConnectUiSpec('slack', SLACK_AUTH_METHODS);
    const oauth = spec.methods[0];
    // The oauth2 option carries the scope picker (from the provider scope
    // catalogue), not text fields.
    expect(oauth?.collect.scopes?.length).toBeGreaterThan(0);
    expect(oauth?.collect.scopes?.some((s) => s.scope === 'chat:write')).toBe(
      true
    );
    expect(oauth?.collect.fields).toBeUndefined();
    // The api_key option asks for exactly one secret field with the vendor's
    // token format as placeholder.
    const apiKey = spec.methods[1];
    expect(apiKey?.collect.fields).toHaveLength(1);
    expect(apiKey?.collect.fields?.[0]).toMatchObject({
      secret: true,
      placeholder: 'xoxb-...',
    });
    // The whole spec is schema-valid for the studio to consume.
    expect(ConnectUiSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("the user's choice is honored: picking a method selects its bound CredentialType, accepted by the bubble", () => {
    const oauthChoice = resolveAuthChoice(SLACK_AUTH_METHODS, 'oauth2');
    const tokenChoice = resolveAuthChoice(SLACK_AUTH_METHODS, 'api_key');
    expect(oauthChoice.descriptor.credentialType).toBe(
      CredentialType.SLACK_CRED
    );
    expect(tokenChoice.descriptor.credentialType).toBe(
      CredentialType.SLACK_API
    );
    // Both bound types are accepted by the slack bubble today — the choice
    // flows through the existing credential system with no new plumbing.
    expect(BUBBLE_CREDENTIAL_OPTIONS['slack']).toContain(
      oauthChoice.descriptor.credentialType
    );
    expect(BUBBLE_CREDENTIAL_OPTIONS['slack']).toContain(
      tokenChoice.descriptor.credentialType
    );
    // A kind the app does not offer is refused, naming what IS offered.
    expect(() => resolveAuthChoice(SLACK_AUTH_METHODS, 'basic')).toThrow(
      'oauth2, api_key'
    );
  });

  it('the chosen strategy authenticates the probe the chosen way (bot token vs OAuth token)', async () => {
    const seen: OutboundAuthRequest[] = [];
    const transport: AuthHttpTransport = (req) => {
      seen.push(req);
      return Promise.resolve({ status: 200, body: '{"ok":true}' });
    };
    const tokenChoice = resolveAuthChoice(
      SLACK_AUTH_METHODS,
      'api_key',
      transport
    );
    await tokenChoice.strategy.test({ secret: 'xoxb-pasted' });
    const oauthChoice = resolveAuthChoice(
      SLACK_AUTH_METHODS,
      'oauth2',
      transport
    );
    await oauthChoice.strategy.test({ secret: 'xoxb-from-oauth' });
    // Both probe Slack's documented verifier with a bearer header carrying
    // the credential the USER'S CHOICE produced.
    expect(seen.map((r) => r.url)).toEqual([
      'https://slack.com/api/auth.test',
      'https://slack.com/api/auth.test',
    ]);
    expect(seen[0]?.headers['Authorization']).toBe('Bearer xoxb-pasted');
    expect(seen[1]?.headers['Authorization']).toBe('Bearer xoxb-from-oauth');
  });
});

describe('doc-grounding guard — every offered method carries its citation', () => {
  it.each(APP_METHOD_FILES)(
    '$bubbleName: descriptors are schema-valid, cited, and bound to accepted credential types',
    ({ bubbleName, methods }) => {
      const parsed = AppAuthMethodsSchema.parse(methods);
      for (const descriptor of parsed) {
        expect(descriptor.citation.length).toBeGreaterThan(0);
        expect(descriptor.citation).toMatch(/https?:\/\//);
        expect(descriptor.confidence).toBeGreaterThan(0);
        expect(
          BUBBLE_CREDENTIAL_OPTIONS[
            bubbleName as keyof typeof BUBBLE_CREDENTIAL_OPTIONS
          ]
        ).toContain(descriptor.credentialType);
      }
    }
  );

  it('the four app bubbles declare the methods as their static authMethods (factory-reachable)', () => {
    expect(SlackBubble.authMethods).toBe(SLACK_AUTH_METHODS);
    expect(NotionBubble.authMethods).toBe(NOTION_AUTH_METHODS);
    expect(GithubBubble.authMethods).toBe(GITHUB_AUTH_METHODS);
    expect(PostgreSQLBubble.authMethods).toBe(POSTGRESQL_AUTH_METHODS);
  });

  it('github offers pat, postgresql offers connection_string (single-method apps)', () => {
    const github = buildConnectUiSpec('github', GITHUB_AUTH_METHODS);
    expect(github.methods.map((m) => m.kind)).toEqual(['pat']);
    expect(github.recommendedKind).toBe('pat');
    const postgres = buildConnectUiSpec('postgresql', POSTGRESQL_AUTH_METHODS);
    expect(postgres.methods.map((m) => m.kind)).toEqual(['connection_string']);
  });

  it('a descriptor for an unimplemented kind fails loudly, naming the implemented kinds', () => {
    expect(() =>
      strategyForDescriptor({
        kind: 'browser_session',
        credentialType: CredentialType.LINKEDIN_CRED,
        displayName: 'Guided login',
        source: 'manual',
        citation: 'human assertion',
        confidence: 1,
      })
    ).toThrow('no strategy implementation');
  });

  it('scope discovery threads into the spec: exactly the required scopes are enabled, unsatisfiable ones appended (IR-6/7)', () => {
    const spec = buildConnectUiSpec('slack', SLACK_AUTH_METHODS);
    const requirements: DiscoveredScopeRequirement[] = [
      {
        // Satisfied by a scope the picker already offers.
        scope: 'chat:write',
        alternatives: ['chat:write'],
        requiredBy: [
          { bubbleName: 'slack', variableName: 'notify', operation: 'send_message' },
        ],
      },
      {
        // No picker scope satisfies it → appended, defaultEnabled, named after its ops.
        scope: 'workflow.steps:execute',
        alternatives: ['workflow.steps:execute'],
        requiredBy: [{ bubbleName: 'slack', operation: 'run_workflow_step' }],
      },
    ];
    const threaded = applyScopeRequirementsToConnectUiSpec(spec, requirements);
    const oauth = threaded.methods.find((m) => m.kind === 'oauth2');
    const scopes = oauth?.collect.scopes ?? [];
    // Exactly the required scopes are enabled; every other curated scope is off.
    const enabled = scopes.filter((s) => s.defaultEnabled).map((s) => s.scope);
    expect(enabled.sort()).toEqual(['chat:write', 'workflow.steps:execute']);
    // The appended entry names the operations that need it.
    const appended = scopes.find((s) => s.scope === 'workflow.steps:execute');
    expect(appended?.description).toContain('slack.run_workflow_step');
    // Non-oauth2 methods and the original spec are untouched.
    const apiKey = threaded.methods.find((m) => m.kind === 'api_key');
    expect(apiKey).toEqual(spec.methods.find((m) => m.kind === 'api_key'));
    expect(
      spec.methods
        .find((m) => m.kind === 'oauth2')
        ?.collect.scopes?.some((s) => s.scope === 'workflow.steps:execute')
    ).toBe(false);
    // No requirements → pass-through.
    expect(applyScopeRequirementsToConnectUiSpec(spec, [])).toBe(spec);
  });

  it('postgresql connection-string test enforces the libpq-documented schemes end-to-end', async () => {
    const choice = resolveAuthChoice(
      POSTGRESQL_AUTH_METHODS,
      'connection_string'
    );
    expect(
      (
        await choice.strategy.test({
          secret: 'postgresql://user:pass@db.example:5432/prod',
        })
      ).ok
    ).toBe(true);
    expect(
      (await choice.strategy.test({ secret: 'mongodb://db.example/x' })).ok
    ).toBe(false);
  });
});
