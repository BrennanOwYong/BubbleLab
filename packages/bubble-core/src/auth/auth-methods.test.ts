import { describe, it, expect } from 'vitest';
import {
  ApiKeyAuthMethod,
  BasicAuthMethod,
  ConnectionStringAuthMethod,
  MultiFieldAuthMethod,
  PatAuthMethod,
  type AuthHttpTransport,
  type OutboundAuthRequest,
} from './auth-method-strategy.js';
import { OAuth2AuthMethod, refreshTokenOf } from './oauth2-strategy.js';
import { AuthInferenceError, inferAuthMethods } from './infer-auth-methods.js';
import {
  AuthMethodDescriptorSchema,
  encodeCredentialPayload,
  sortByConvenience,
} from '@bubblelab/shared-schemas';

/** Transport double that records requests and returns a scripted response. */
function recordingTransport(
  status = 200,
  body = '{}'
): { transport: AuthHttpTransport; seen: OutboundAuthRequest[] } {
  const seen: OutboundAuthRequest[] = [];
  return {
    seen,
    transport: (req) => {
      seen.push(req);
      return Promise.resolve({ status, body });
    },
  };
}

describe('AuthMethod strategies — collect() drives the Connect UI, applyToRequest places the secret', () => {
  it('api_key: one secret field, header placement with scheme (RFC 6750 bearer)', async () => {
    const { transport, seen } = recordingTransport();
    const method = new ApiKeyAuthMethod({
      placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
      testRequest: { url: 'https://slack.com/api/auth.test', method: 'POST' },
      placeholder: 'xoxb-...',
      transport,
    });

    const spec = method.collect();
    expect(spec.kind).toBe('api_key');
    expect(spec.fields).toHaveLength(1);
    expect(spec.fields?.[0]).toMatchObject({
      name: 'api_key',
      secret: true,
      placeholder: 'xoxb-...',
    });

    const result = await method.test({ secret: 'xoxb-token' });
    expect(result.ok).toBe(true);
    expect(seen[0]?.headers['Authorization']).toBe('Bearer xoxb-token');
    expect(seen[0]?.url).toBe('https://slack.com/api/auth.test');
  });

  it('api_key: query placement lands in query, never in headers', () => {
    const method = new ApiKeyAuthMethod({
      placement: { in: 'query', name: 'key' },
      testRequest: { url: 'https://example.com/probe' },
    });
    const req: OutboundAuthRequest = {
      url: 'https://example.com/x',
      method: 'GET',
      headers: {},
      query: {},
    };
    method.applyToRequest({ secret: 's3cret' }, req);
    expect(req.query['key']).toBe('s3cret');
    expect(Object.keys(req.headers)).toHaveLength(0);
  });

  it('pat: bearer placement and a failing probe surfaces the HTTP status', async () => {
    const { transport } = recordingTransport(
      401,
      '{"message":"Bad credentials"}'
    );
    const method = new PatAuthMethod({
      placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
      testRequest: { url: 'https://api.github.com/user' },
      transport,
    });
    expect(method.collect().fields?.[0]?.name).toBe('token');
    const result = await method.test({ secret: 'ghp_bad' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('basic: RFC 7617 — Authorization: Basic base64(user:password)', async () => {
    const { transport, seen } = recordingTransport();
    const method = new BasicAuthMethod({
      testRequest: { url: 'https://example.com/me' },
      transport,
    });
    expect(method.collect().fields?.map((f) => f.name)).toEqual([
      'username',
      'password',
    ]);
    const secret = encodeCredentialPayload(
      JSON.stringify({ username: 'aladdin', password: 'opensesame' })
    );
    const result = await method.test({ secret });
    expect(result.ok).toBe(true);
    // RFC 7617 §2 worked example value for aladdin:opensesame.
    expect(seen[0]?.headers['Authorization']).toBe(
      `Basic ${Buffer.from('aladdin:opensesame').toString('base64')}`
    );
  });

  it('basic: missing password fails the test without a network call', async () => {
    const { transport, seen } = recordingTransport();
    const method = new BasicAuthMethod({
      testRequest: { url: 'https://example.com/me' },
      transport,
    });
    const secret = encodeCredentialPayload(JSON.stringify({ username: 'x' }));
    const result = await method.test({ secret });
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('multi_field: N labelled fields, per-field placement, missing field errors', async () => {
    const { transport, seen } = recordingTransport();
    const method = new MultiFieldAuthMethod({
      fields: [
        {
          name: 'access_key',
          label: 'Access key',
          secret: false,
          placement: { in: 'header', name: 'X-Access-Key' },
        },
        {
          name: 'secret_key',
          label: 'Secret key',
          secret: true,
          placement: { in: 'header', name: 'X-Secret-Key' },
        },
      ],
      testRequest: { url: 'https://example.com/probe' },
      transport,
    });
    expect(method.collect().fields).toHaveLength(2);

    const full = encodeCredentialPayload(
      JSON.stringify({ access_key: 'AK', secret_key: 'SK' })
    );
    await method.test({ secret: full });
    expect(seen[0]?.headers['X-Access-Key']).toBe('AK');
    expect(seen[0]?.headers['X-Secret-Key']).toBe('SK');

    const partial = encodeCredentialPayload(
      JSON.stringify({ access_key: 'AK' })
    );
    const result = await method.test({ secret: partial });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('secret_key');
  });

  it('connection_string: accepts documented schemes, rejects others (libpq: postgresql:// or postgres://)', async () => {
    const method = new ConnectionStringAuthMethod({
      allowedSchemes: ['postgresql:', 'postgres:'],
    });
    expect(
      (await method.test({ secret: 'postgresql://u:p@localhost:5432/db' })).ok
    ).toBe(true);
    expect(
      (await method.test({ secret: 'postgres://u:p@localhost/db' })).ok
    ).toBe(true);
    const wrong = await method.test({ secret: 'mysql://u:p@localhost/db' });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain('mysql:');
    expect((await method.test({ secret: 'not a uri' })).ok).toBe(false);
  });
});

describe('oauth2 strategy — scope picker, bearer, RFC 6749 §6 refresh with rotation', () => {
  const scopes = [
    { scope: 'chat:write', description: 'Send messages', defaultEnabled: true },
    { scope: 'channels:read', description: 'List channels' },
  ];

  it('collect() returns the scope picker options', () => {
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://slack.com/api/auth.test', method: 'POST' },
    });
    const spec = method.collect();
    expect(spec.kind).toBe('oauth2');
    expect(spec.scopes?.map((s) => s.scope)).toEqual([
      'chat:write',
      'channels:read',
    ]);
  });

  it('applies the bearer header and probes with it', async () => {
    const { transport, seen } = recordingTransport();
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://slack.com/api/auth.test', method: 'POST' },
      transport,
    });
    await method.test({ secret: 'xoxb-access' });
    expect(seen[0]?.headers['Authorization']).toBe('Bearer xoxb-access');
  });

  it('refresh(): form-encoded grant_type=refresh_token, rotation persisted', async () => {
    const { transport, seen } = recordingTransport(
      200,
      JSON.stringify({
        access_token: 'new-access',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rotated-refresh',
        scope: 'chat:write channels:read',
      })
    );
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://slack.com/api/auth.test' },
      tokenUrl: 'https://provider.example/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      transport,
    });
    const next = await method.refresh({
      secret: 'old-access',
      metadata: { refreshToken: 'old-refresh' },
    });
    const sent = new URLSearchParams(seen[0]?.body ?? '');
    expect(seen[0]?.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('old-refresh');
    expect(next.secret).toBe('new-access');
    expect(refreshTokenOf(next)).toBe('rotated-refresh');
    expect(next.grantedScopes).toEqual(['chat:write', 'channels:read']);
    expect(next.expiresAt).toBeInstanceOf(Date);
  });

  it('refresh(): Google-style response omitting refresh_token keeps the prior one', async () => {
    const { transport } = recordingTransport(
      200,
      JSON.stringify({
        access_token: 'new-access',
        token_type: 'Bearer',
        expires_in: 3599,
      })
    );
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://example.com/probe' },
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: 'cid',
      clientSecret: 'csecret',
      transport,
    });
    const next = await method.refresh({
      secret: 'old',
      metadata: { refreshToken: 'original-refresh' },
      grantedScopes: ['scope.a'],
    });
    expect(refreshTokenOf(next)).toBe('original-refresh');
    expect(next.grantedScopes).toEqual(['scope.a']);
  });

  it('refresh() without a stored refresh token demands a re-connect', async () => {
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://example.com/probe' },
      tokenUrl: 'https://provider.example/token',
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    await expect(method.refresh({ secret: 'old' })).rejects.toThrow(
      're-connect'
    );
  });

  it('grantedScopes(): undefined when the provider sent no scope metadata (honest fallback)', async () => {
    const method = new OAuth2AuthMethod({
      scopes,
      testRequest: { url: 'https://example.com/probe' },
    });
    expect(await method.grantedScopes({ secret: 's' })).toBeUndefined();
    expect(
      await method.grantedScopes({ secret: 's', grantedScopes: ['a'] })
    ).toEqual(['a']);
  });
});

describe('inferAuthMethods — methods come from the docs, uncertainty is said not guessed', () => {
  it('OpenAPI securitySchemes: oauth2 + apiKey + http basic + http bearer map to kinds with citations', () => {
    const { methods, uncertainties } = inferAuthMethods([
      {
        kind: 'openapi',
        citation:
          'https://vendor.example/openapi.json#/components/securitySchemes',
        securitySchemes: {
          appOAuth: {
            type: 'oauth2',
            flows: {
              authorizationCode: {
                scopes: { 'chat:write': 'Send messages as the app' },
              },
            },
          },
          headerKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
          basicLogin: { type: 'http', scheme: 'basic' },
          bearerToken: { type: 'http', scheme: 'bearer' },
        },
      },
    ]);
    const kinds = methods.map((m) => m.kind).sort();
    expect(kinds).toEqual(['api_key', 'basic', 'oauth2', 'pat']);
    for (const method of methods) {
      expect(method.citation).toContain(
        'https://vendor.example/openapi.json#/components/securitySchemes#'
      );
      expect(method.source).toBe('openapi');
    }
    const oauth = methods.find((m) => m.kind === 'oauth2');
    expect(oauth?.scopes).toEqual([
      { scope: 'chat:write', description: 'Send messages as the app' },
    ]);
    const apiKey = methods.find((m) => m.kind === 'api_key');
    expect(apiKey?.placement).toEqual({ in: 'header', name: 'X-Api-Key' });
    expect(uncertainties).toHaveLength(0);
  });

  it('unmodeled scheme types become uncertainties, never guessed methods', () => {
    const { methods, uncertainties } = inferAuthMethods([
      {
        kind: 'openapi',
        citation: 'spec#securitySchemes',
        securitySchemes: {
          tls: { type: 'mutualTLS' },
          cookieKey: { type: 'apiKey', name: 'sid', in: 'cookie' },
        },
      },
    ]);
    expect(methods).toHaveLength(0);
    expect(uncertainties).toHaveLength(2);
    expect(uncertainties[0]?.reason).toContain('mutualTLS');
    expect(uncertainties[1]?.reason).toContain('cookie');
  });

  it('prose: real Slack quotes yield oauth2 + api_key + pat, each citing the matched phrase', () => {
    const { methods } = inferAuthMethods([
      {
        kind: 'prose',
        docText:
          'Installing with OAuth 2.0. Bot tokens ascribe to a granular permission model. User tokens represent workspace members.',
        citation: 'https://docs.slack.dev/authentication/tokens/',
      },
    ]);
    const kinds = methods.map((m) => m.kind).sort();
    expect(kinds).toEqual(['api_key', 'oauth2', 'pat']);
    for (const method of methods) {
      expect(method.citation).toContain('docs.slack.dev');
      expect(method.citation).toContain('matched');
    }
  });

  it('prose with no auth signal reports uncertainty instead of a method', () => {
    const { methods, uncertainties } = inferAuthMethods([
      {
        kind: 'prose',
        docText: 'This page describes rate limits and pagination.',
        citation: 'https://vendor.example/docs/limits',
      },
    ]);
    expect(methods).toHaveLength(0);
    expect(uncertainties[0]?.reason).toContain('not guessing');
  });

  it('openapi evidence outranks prose for the same kind (higher confidence wins)', () => {
    const { methods } = inferAuthMethods([
      {
        kind: 'prose',
        docText: 'Authenticate with OAuth 2.0.',
        citation: 'https://vendor.example/docs/auth',
      },
      {
        kind: 'openapi',
        citation: 'spec#securitySchemes',
        securitySchemes: { o: { type: 'oauth2', flows: {} } },
      },
    ]);
    const oauth = methods.filter((m) => m.kind === 'oauth2');
    expect(oauth).toHaveLength(1);
    expect(oauth[0]?.source).toBe('openapi');
    expect(oauth[0]?.confidence).toBeGreaterThan(0.6);
  });

  it('no evidence at all throws — a method list cannot exist without sources', () => {
    expect(() => inferAuthMethods([])).toThrow(AuthInferenceError);
  });

  it('convenience ranking: oauth2 sorts above api_key, connection_string last', () => {
    const sorted = sortByConvenience([
      { kind: 'connection_string' as const },
      { kind: 'api_key' as const },
      { kind: 'oauth2' as const },
    ]);
    expect(sorted.map((m) => m.kind)).toEqual([
      'oauth2',
      'api_key',
      'connection_string',
    ]);
  });

  it('every inferred method parses into a cited descriptor once bound', () => {
    const { methods } = inferAuthMethods([
      {
        kind: 'prose',
        docText: 'Use an API key.',
        citation: 'https://vendor.example/docs/auth',
      },
    ]);
    const method = methods[0];
    expect(method).toBeDefined();
    if (!method) return;
    const parsed = AuthMethodDescriptorSchema.safeParse({
      kind: method.kind,
      credentialType: 'CUSTOM_AUTH_KEY',
      displayName: 'API key',
      source: method.source,
      citation: method.citation,
      confidence: method.confidence,
    });
    expect(parsed.success).toBe(true);
  });
});
