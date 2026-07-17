/**
 * Auth inference (ADD-ANY-APP S5): derive the generated bubble's authType and
 * token wire-placement from the spec's securitySchemes instead of hardcoding.
 *
 * Sources consulted, in order:
 *   1. The security requirements the selected operations declare
 *      (operation.security, falling back to document security — captured by
 *      extract.ts into draft.securitySchemes).
 *   2. Their definitions under components.securitySchemes.
 *   3. Only when the spec is silent (no security requirement on any selected
 *      operation): the per-app config's `authType` fallback, defaulting to
 *      'apikey' with bearer placement (the MVP credential model).
 *
 * OpenAPI 3.0 securityScheme reference (shape verified against the spec):
 * https://spec.openapis.org/oas/v3.0.3#security-scheme-object
 */
import type { OpenApiDocument } from './openapi.js';
import type { AppGenConfig, OperationDraft } from './types.js';

/** OpenAPI 3.0 Security Scheme Object (post-parse, permissive). */
export interface SecuritySchemeDef {
  type?: string; // 'apiKey' | 'http' | 'oauth2' | 'openIdConnect'
  scheme?: string; // http: 'bearer' | 'basic' | ...
  bearerFormat?: string;
  name?: string; // apiKey: header/query/cookie parameter name
  in?: string; // apiKey: 'header' | 'query' | 'cookie'
  description?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
}

/** How the credential token goes on the wire. */
export type TokenPlacement =
  | { kind: 'bearer' } // Authorization: Bearer <token>
  | { kind: 'header'; headerName: string }; // <headerName>: <token>

export interface AuthInference {
  /** ServiceBubble.authType (the codebase's closed set). */
  authType: 'oauth' | 'apikey';
  placement: TokenPlacement;
  /** Provenance: spec-derived or config fallback. */
  source: 'openapi' | 'config';
  /** One-line provenance string for the generated-code comment. */
  citation: string;
}

interface MappedScheme {
  name: string;
  authType: 'oauth' | 'apikey';
  placement: TokenPlacement;
  /** Lower = preferred when the spec offers alternatives. */
  rank: number;
  label: string;
}

/**
 * Map one securityScheme definition onto the bubble auth model.
 * Preference ranks when the spec offers alternative schemes:
 *   http bearer (0) — a config-supplied token, the MVP credential model
 *   apiKey in header (1)
 *   oauth2 / openIdConnect (2) — access token, still sent as Bearer
 * Unsupported (hard error, never guessed): http basic, apiKey in
 * query/cookie, unknown types.
 */
function mapScheme(name: string, def: SecuritySchemeDef): MappedScheme {
  if (def.type === 'http' && def.scheme?.toLowerCase() === 'bearer') {
    return {
      name,
      authType: 'apikey',
      placement: { kind: 'bearer' },
      rank: 0,
      label: 'http bearer',
    };
  }
  if (def.type === 'apiKey' && def.in === 'header') {
    if (!def.name) {
      throw new Error(
        `securityScheme "${name}": apiKey scheme missing the header name`
      );
    }
    return {
      name,
      authType: 'apikey',
      placement: { kind: 'header', headerName: def.name },
      rank: 1,
      label: `apiKey header "${def.name}"`,
    };
  }
  if (def.type === 'oauth2' || def.type === 'openIdConnect') {
    return {
      name,
      authType: 'oauth',
      placement: { kind: 'bearer' },
      rank: 2,
      label: def.type,
    };
  }
  throw new Error(
    `securityScheme "${name}" (type: ${def.type ?? 'missing'}, scheme: ${
      def.scheme ?? '-'
    }, in: ${def.in ?? '-'}) is unsupported by the generator; ` +
      'supported: http bearer, apiKey in header, oauth2, openIdConnect'
  );
}

/** Infer bubble auth from the spec, falling back to config when silent. */
export function inferAuth(
  doc: OpenApiDocument,
  drafts: OperationDraft[],
  config: AppGenConfig
): AuthInference {
  const usedNames = [...new Set(drafts.flatMap((d) => d.securitySchemes))];
  const defs = doc.components?.securitySchemes as
    | Record<string, SecuritySchemeDef>
    | undefined;

  if (usedNames.length === 0) {
    // Spec is silent for the selected operations: config fallback.
    const authType = config.authType ?? 'apikey';
    return {
      authType,
      placement: { kind: 'bearer' },
      source: 'config',
      citation: config.authType
        ? `spec declares no security for the selected operations; config authType '${config.authType}'`
        : `spec declares no security for the selected operations; default 'apikey' (set config.authType to override)`,
    };
  }

  if (!defs) {
    throw new Error(
      `operations reference securitySchemes [${usedNames.join(', ')}] but the spec has no components.securitySchemes`
    );
  }
  const mapped = usedNames.map((name) => {
    const def = defs[name];
    if (!def) {
      throw new Error(
        `securityScheme "${name}" is referenced by an operation but not defined under components.securitySchemes`
      );
    }
    return mapScheme(name, def);
  });

  mapped.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const chosen = mapped[0];
  const alternatives = mapped.slice(1);
  const alt =
    alternatives.length > 0
      ? `; alternatives: ${alternatives.map((m) => `${m.name} (${m.label})`).join(', ')}`
      : '';
  return {
    authType: chosen.authType,
    placement: chosen.placement,
    source: 'openapi',
    citation: `inferred from securityScheme ${chosen.name} (${chosen.label})${alt}`,
  };
}
