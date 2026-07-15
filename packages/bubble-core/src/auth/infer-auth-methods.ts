/**
 * Doc-grounded auth-method inference (IR-3/IR-4): derive the sign-in methods
 * an app supports from its documentation — OpenAPI securitySchemes or vendor
 * doc prose — carrying a citation per method, same discipline as the IR-8
 * side-effect classifier. Where inference is uncertain it SAYS SO (an
 * `uncertainties` entry) instead of guessing a method.
 *
 * References:
 * - OpenAPI 3.1 Security Scheme Object — `type` is one of apiKey | http |
 *   mutualTLS | oauth2 | openIdConnect; apiKey carries name/in, http carries
 *   scheme/bearerFormat, oauth2 carries flows:
 *   https://spec.openapis.org/oas/v3.1.0#security-scheme-object
 * - RFC 7617 (Basic), RFC 6750 (Bearer), RFC 6749 (OAuth 2.0).
 */
import type {
  AuthCollectScope,
  AuthMethodKind,
  AuthMethodSource,
  SecretPlacement,
} from '@bubblelab/shared-schemas';

export class AuthInferenceError extends Error {
  override name = 'AuthInferenceError';
}

// ── Evidence types ────────────────────────────────────────────────────────────

/** OpenAPI 3.x Security Scheme Object, as published in components.securitySchemes. */
export interface OpenApiSecurityScheme {
  type: string;
  description?: string;
  /** apiKey: the header/query/cookie parameter name. */
  name?: string;
  /** apiKey: 'header' | 'query' | 'cookie'. */
  in?: string;
  /** http: 'basic' | 'bearer' | ... (RFC 9110 auth schemes). */
  scheme?: string;
  bearerFormat?: string;
  /** oauth2: flow objects keyed by flow name, each with a scopes map. */
  flows?: Record<
    string,
    { scopes?: Record<string, string> } | undefined
  >;
}

export interface OpenApiAuthEvidence {
  kind: 'openapi';
  securitySchemes: Record<string, OpenApiSecurityScheme>;
  /** e.g. `https://…/openapi.json#/components/securitySchemes`. */
  citation: string;
}

export interface ProseAuthEvidence {
  kind: 'prose';
  /** The vendor's authentication documentation prose. */
  docText: string;
  citation: string;
}

export interface ManualAuthEvidence {
  kind: 'manual';
  method: AuthMethodKind;
  citation: string;
  confidence?: number;
}

export type AuthEvidence =
  | OpenApiAuthEvidence
  | ProseAuthEvidence
  | ManualAuthEvidence;

// ── Inference output ──────────────────────────────────────────────────────────

export interface InferredAuthMethod {
  kind: AuthMethodKind;
  source: AuthMethodSource;
  citation: string;
  confidence: number;
  /** apiKey schemes: where the vendor says the secret goes. */
  placement?: SecretPlacement;
  /** oauth2 schemes: the scopes the vendor declares. */
  scopes?: AuthCollectScope[];
}

/** An honest "the docs did not tell us" record — never converted to a guess. */
export interface AuthInferenceUncertainty {
  citation: string;
  reason: string;
}

export interface AuthInferenceResult {
  methods: InferredAuthMethod[];
  uncertainties: AuthInferenceUncertainty[];
}

// ── OpenAPI securitySchemes → methods ────────────────────────────────────────

function inferFromOpenApi(
  evidence: OpenApiAuthEvidence
): AuthInferenceResult {
  const methods: InferredAuthMethod[] = [];
  const uncertainties: AuthInferenceUncertainty[] = [];

  for (const [schemeName, scheme] of Object.entries(
    evidence.securitySchemes
  )) {
    const citation = `${evidence.citation}#${schemeName}`;
    switch (scheme.type) {
      case 'oauth2': {
        const scopes: AuthCollectScope[] = [];
        for (const flow of Object.values(scheme.flows ?? {})) {
          for (const [scope, description] of Object.entries(
            flow?.scopes ?? {}
          )) {
            if (!scopes.some((s) => s.scope === scope)) {
              scopes.push({ scope, description });
            }
          }
        }
        methods.push({
          kind: 'oauth2',
          source: 'openapi',
          citation,
          confidence: 0.9,
          scopes,
        });
        break;
      }
      case 'apiKey': {
        if (scheme.in === 'header' || scheme.in === 'query') {
          const placement: SecretPlacement =
            scheme.in === 'header'
              ? { in: 'header', name: scheme.name ?? 'Authorization' }
              : { in: 'query', name: scheme.name ?? 'key' };
          methods.push({
            kind: 'api_key',
            source: 'openapi',
            citation,
            confidence: 0.9,
            placement,
          });
        } else {
          uncertainties.push({
            citation,
            reason: `apiKey scheme "${schemeName}" uses unsupported location "${scheme.in ?? 'unspecified'}" (only header/query are modeled)`,
          });
        }
        break;
      }
      case 'http': {
        const httpScheme = (scheme.scheme ?? '').toLowerCase();
        if (httpScheme === 'basic') {
          methods.push({
            kind: 'basic',
            source: 'openapi',
            citation,
            confidence: 0.9,
          });
        } else if (httpScheme === 'bearer') {
          // A bearer scheme says HOW the token travels, not how the user gets
          // one — a pasted long-lived token (pat) is the collectable reading.
          methods.push({
            kind: 'pat',
            source: 'openapi',
            citation,
            confidence: 0.7,
            placement: { in: 'header', name: 'Authorization', scheme: 'Bearer' },
          });
        } else {
          uncertainties.push({
            citation,
            reason: `http scheme "${httpScheme || 'unspecified'}" on "${schemeName}" is not a modeled auth kind`,
          });
        }
        break;
      }
      case 'openIdConnect': {
        // OIDC discovery implies an OAuth2 authorization server, but the
        // discovery document is not in evidence — lower confidence.
        methods.push({
          kind: 'oauth2',
          source: 'openapi',
          citation,
          confidence: 0.6,
        });
        break;
      }
      default:
        uncertainties.push({
          citation,
          reason: `securityScheme "${schemeName}" has unmodeled type "${scheme.type}" — not guessing`,
        });
    }
  }

  return { methods, uncertainties };
}

// ── Doc-prose → methods ──────────────────────────────────────────────────────

interface ProsePattern {
  kind: AuthMethodKind;
  pattern: RegExp;
}

/** Ordered: earlier patterns are more specific and matched first per kind. */
const PROSE_PATTERNS: readonly ProsePattern[] = [
  { kind: 'oauth2', pattern: /\boauth\s*2(\.0)?\b/i },
  { kind: 'oauth2', pattern: /\bauthorization[- ]code\b/i },
  { kind: 'pat', pattern: /\bpersonal access tokens?\b/i },
  { kind: 'pat', pattern: /\buser tokens?\b/i },
  {
    kind: 'api_key',
    pattern:
      /\b(api keys?|bot tokens?|integration tokens?|internal integration secret|installation access tokens?)\b/i,
  },
  { kind: 'basic', pattern: /\bbasic auth(entication)?\b/i },
  {
    kind: 'connection_string',
    pattern: /\bconnection (string|uri)s?\b/i,
  },
  { kind: 'browser_session', pattern: /\b(log|sign)[- ]?in with your browser\b/i },
  { kind: 'xoauth2', pattern: /\bxoauth2\b/i },
];

function inferFromProse(evidence: ProseAuthEvidence): AuthInferenceResult {
  const methods: InferredAuthMethod[] = [];
  for (const { kind, pattern } of PROSE_PATTERNS) {
    if (
      pattern.test(evidence.docText) &&
      !methods.some((m) => m.kind === kind)
    ) {
      const match = evidence.docText.match(pattern);
      methods.push({
        kind,
        source: 'prose',
        citation: `${evidence.citation} — matched "${match?.[0] ?? ''}"`,
        confidence: 0.6,
      });
    }
  }
  if (methods.length === 0) {
    return {
      methods: [],
      uncertainties: [
        {
          citation: evidence.citation,
          reason:
            'prose evidence contains no recognizable auth-method signal — not guessing',
        },
      ],
    };
  }
  return { methods, uncertainties: [] };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Infer the auth methods an app supports from documentation evidence.
 * Evidence pieces union: OpenAPI evidence outranks prose for the same kind
 * (higher confidence wins; ties keep the earlier, more authoritative entry).
 * No evidence at all is an error — a method list cannot exist without sources.
 */
export function inferAuthMethods(
  evidence: readonly AuthEvidence[]
): AuthInferenceResult {
  if (evidence.length === 0) {
    throw new AuthInferenceError(
      'no evidence supplied — auth methods cannot be inferred from nothing'
    );
  }

  const methods = new Map<AuthMethodKind, InferredAuthMethod>();
  const uncertainties: AuthInferenceUncertainty[] = [];

  for (const piece of evidence) {
    let result: AuthInferenceResult;
    if (piece.kind === 'openapi') {
      result = inferFromOpenApi(piece);
    } else if (piece.kind === 'prose') {
      result = inferFromProse(piece);
    } else {
      result = {
        methods: [
          {
            kind: piece.method,
            source: 'manual',
            citation: piece.citation,
            confidence: piece.confidence ?? 1,
          },
        ],
        uncertainties: [],
      };
    }
    for (const method of result.methods) {
      const existing = methods.get(method.kind);
      if (existing === undefined || method.confidence > existing.confidence) {
        methods.set(method.kind, method);
      }
    }
    uncertainties.push(...result.uncertainties);
  }

  return { methods: [...methods.values()], uncertainties };
}
