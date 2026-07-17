/**
 * Shared shapes for the contract-first bubble generator (ADD-ANY-APP S2/S3).
 *
 * `OperationDraft` is the source-agnostic normalization target: the OpenAPI
 * path produces it deterministically here; prose/MCP/SDK front-ends produce
 * the same shape (docs/plan/ADD-ANY-APP.md section 3, S2).
 */

/** Permissive JSON Schema node (OpenAPI 3.0 schema object, post-$ref-resolution). */
export interface JsonSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  default?: unknown;
  example?: unknown;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
  [key: string]: unknown;
}

export type WireLocation = 'path' | 'query' | 'body';

/**
 * How body fields are serialized on the wire: JSON.stringify, or
 * application/x-www-form-urlencoded with deepObject bracket encoding
 * (Stripe-style `metadata[key]=value`, `line_items[0][price]=...`).
 */
export type BodyEncoding = 'json' | 'form';

/** One operation input field with its wire binding (composeInput flattening). */
export interface WireField {
  /** Field name as it appears in the params schema (the wire name, verbatim). */
  name: string;
  location: WireLocation;
  required: boolean;
  schema: JsonSchema;
}

/** Normalized operation, one per selected OpenAPI operationId. */
export interface OperationDraft {
  /** snake_case operation discriminator literal, derived from operationId. */
  name: string;
  operationId: string;
  method: string;
  pathTemplate: string;
  summary?: string;
  description?: string;
  /** Spec-pointer citation, e.g. `sqlapi.yaml#/paths/~1api~1v2~1statements/post`. */
  citation: string;
  fields: WireField[];
  /** Request-body wire serialization (only meaningful when body fields exist). */
  bodyEncoding: BodyEncoding;
  /**
   * Merged 2xx response payload: union of every documented 2xx JSON object
   * schema's properties, all optional (presence varies by status code).
   */
  responseProperties: Record<string, JsonSchema>;
  /** Status codes that contributed to responseProperties. */
  responseSources: string[];
  /** requestBody example from the spec, when present (drives round-trip tests). */
  requestExample?: Record<string, unknown>;
  /** Schema-level response examples keyed by status code, when present. */
  responseExamples: Record<string, unknown>;
  /** Security scheme names accepted by this operation. */
  securitySchemes: string[];
}

/** Per-app generation config: the auth/identity facts S5 infers plus naming. */
export interface AppGenConfig {
  /** Bubble name, kebab-case (BubbleName literal), e.g. `snowflake-sql-api`. */
  appName: string;
  /** Class prefix, e.g. `SnowflakeSqlApi` -> SnowflakeSqlApiBubble. */
  className: string;
  service: string;
  alias?: string;
  /** Human-facing catalog name, e.g. `Stripe Payments`. */
  displayName?: string;
  shortDescription: string;
  /** CredentialType enum KEY the bubble reads, e.g. `SNOWFLAKE_PAT`. */
  credentialType: string;
  /**
   * Static headers the request builder stamps on every call (auth token type,
   * User-Agent). Authorization: Bearer is always stamped from the credential.
   */
  authHeaders: Record<string, string>;
  /** Per-account base URL param appended to every operation branch. */
  baseUrlParam: {
    name: string;
    description: string;
    example: string;
  };
  /** operationIds to generate (the S2 selection step). */
  operations: string[];
  /**
   * Static headers stamped only on ONE operation's requests, keyed by
   * operationId. RPC-style APIs (e.g. AWS JSON 1.1) select the operation via
   * a per-operation header such as X-Amz-Target instead of the URL path.
   */
  operationHeaders?: Record<string, Record<string, string>>;
  /**
   * operationId used as the testCredential() probe when the API exposes no
   * GET operation (RPC-style APIs where every call is a POST). Must classify
   * as `read`; a write-shaped probe is refused at generation time.
   */
  probeOperation?: string;
  /** Spec file name used in citations, e.g. `sqlapi.yaml`. */
  specName: string;
  /** Vendor docs URL recorded in the generated header. */
  docsUrl?: string;
  /**
   * Input field names that mark an operation as a CARRIER (executes
   * caller-supplied SQL/code) -> fail-safe `write` classification.
   */
  carrierFields?: string[];
}
