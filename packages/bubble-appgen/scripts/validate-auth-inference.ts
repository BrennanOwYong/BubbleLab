/**
 * S5 auth-inference probes: synthetic specs exercising every inference path
 * (oauth2, apiKey-in-header, http bearer, silent-spec config fallback,
 * unsupported scheme hard error) and the emitted-class consequences.
 *
 * Run: bun scripts/validate-auth-inference.ts
 */
import { inferAuth } from '../src/auth-infer.js';
import { emitClassFile } from '../src/emit-bubble.js';
import type { OpenApiDocument } from '../src/openapi.js';
import type { AppGenConfig, OperationDraft } from '../src/types.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

function draftWith(securitySchemes: string[]): OperationDraft {
  return {
    name: 'get_thing',
    operationId: 'getThing',
    method: 'GET',
    pathTemplate: '/things/{id}',
    summary: 'Get a thing',
    citation: 'probe.yaml#/paths/~1things~1{id}/get',
    fields: [
      {
        name: 'id',
        location: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    bodyEncoding: 'json',
    responseProperties: { id: { type: 'string' } },
    responseSources: ['200'],
    responseExamples: {},
    securitySchemes,
  };
}

function docWith(
  securitySchemes: Record<string, unknown> | undefined
): OpenApiDocument {
  return securitySchemes
    ? { openapi: '3.0.0', components: { securitySchemes } }
    : { openapi: '3.0.0' };
}

const config: AppGenConfig = {
  appName: 'probe-api',
  className: 'ProbeApi',
  service: 'probe',
  shortDescription: 'probe',
  credentialType: 'PROBE_CRED',
  authHeaders: {},
  baseUrlParam: { name: 'baseUrl', description: 'x', example: 'https://x' },
  operations: ['getThing'],
  specName: 'probe.yaml',
};

// 1. oauth2 scheme -> authType 'oauth', bearer placement
{
  const auth = inferAuth(
    docWith({
      appOAuth: { type: 'oauth2', flows: { clientCredentials: {} } },
    }),
    [draftWith(['appOAuth'])],
    config
  );
  assert(auth.authType === 'oauth', 'oauth2 scheme infers authType oauth');
  assert(auth.placement.kind === 'bearer', 'oauth2 token placed as Bearer');
  assert(auth.source === 'openapi', 'oauth2 inference sourced from the spec');
  const cls = emitClassFile(
    config,
    [
      {
        draft: draftWith(['appOAuth']),
        metadata: {
          sideEffect: 'read',
          destructive: false,
          idempotent: true,
          confidence: 0.85,
          source: 'openapi',
          citation: 'probe',
        },
      },
    ],
    auth
  );
  assert(
    cls.includes("static readonly authType = 'oauth' as const;"),
    "emitted class declares authType 'oauth' (inferred, not hardcoded)"
  );
  assert(
    cls.includes('// S5 auth (openapi):'),
    'emitted class carries the inference provenance comment'
  );
}

// 2. apiKey-in-header scheme -> authType 'apikey', custom header placement
{
  const auth = inferAuth(
    docWith({
      keyAuth: { type: 'apiKey', in: 'header', name: 'X-Probe-Key' },
    }),
    [draftWith(['keyAuth'])],
    config
  );
  assert(auth.authType === 'apikey', 'apiKey scheme infers authType apikey');
  assert(
    auth.placement.kind === 'header' &&
      auth.placement.headerName === 'X-Probe-Key',
    'apiKey token placed in the X-Probe-Key header'
  );
  const cls = emitClassFile(
    config,
    [
      {
        draft: draftWith(['keyAuth']),
        metadata: {
          sideEffect: 'read',
          destructive: false,
          idempotent: true,
          confidence: 0.85,
          source: 'openapi',
          citation: 'probe',
        },
      },
    ],
    auth
  );
  assert(
    cls.includes('"X-Probe-Key": token,'),
    'emitted requestHeaders stamps the token into X-Probe-Key'
  );
  assert(
    !cls.includes('Authorization: `Bearer ${token}`'),
    'emitted requestHeaders drops the Bearer line for apiKey-header schemes'
  );
}

// 3. http bearer -> authType 'apikey', Bearer placement (the MVP model)
{
  const auth = inferAuth(
    docWith({ bearerAuth: { type: 'http', scheme: 'bearer' } }),
    [draftWith(['bearerAuth'])],
    config
  );
  assert(
    auth.authType === 'apikey' && auth.placement.kind === 'bearer',
    'http bearer infers apikey + Bearer placement'
  );
}

// 4. Preference order: http bearer beats oauth2 when both are offered
{
  const auth = inferAuth(
    docWith({
      appOAuth: { type: 'oauth2', flows: {} },
      pat: { type: 'http', scheme: 'bearer' },
    }),
    [draftWith(['appOAuth', 'pat'])],
    config
  );
  assert(
    auth.authType === 'apikey' && auth.citation.includes('alternatives'),
    'http bearer preferred over oauth2, alternatives cited'
  );
}

// 5. Silent spec -> config fallback (explicit authType, then default)
{
  const silent = inferAuth(docWith(undefined), [draftWith([])], {
    ...config,
    authType: 'oauth',
  });
  assert(
    silent.authType === 'oauth' && silent.source === 'config',
    'silent spec falls back to config.authType'
  );
  const defaulted = inferAuth(docWith(undefined), [draftWith([])], config);
  assert(
    defaulted.authType === 'apikey' && defaulted.source === 'config',
    'silent spec + silent config defaults to apikey'
  );
}

// 6. Unsupported scheme -> hard error, never a guess
{
  let threw = false;
  try {
    inferAuth(
      docWith({ q: { type: 'apiKey', in: 'query', name: 'key' } }),
      [draftWith(['q'])],
      config
    );
  } catch {
    threw = true;
  }
  assert(threw, 'apiKey-in-query scheme is a hard error');
}

console.log('all auth-inference probes passed');
