/**
 * AuthMethod strategy seam (IR-3/IR-4): one strategy per kind, each owning
 * collect() (what the Connect UI must ask for), test() (a canned probe proving
 * the credential works), applyToRequest() (where the secret lands), and
 * optionally refresh() / grantedScopes() for expiring kinds.
 *
 * Capabilities above this seam stay auth-agnostic; swapping OAuth for a pasted
 * token changes which strategy runs, never the calling code.
 *
 * Request/response shapes are grounded on the official specs — re-verify
 * against these before changing:
 * - RFC 6750 §2.1 (bearer usage: `Authorization: Bearer <token>`):
 *   https://datatracker.ietf.org/doc/html/rfc6750#section-2.1
 * - RFC 7617 §2 (Basic: `Authorization: Basic base64(user-id ":" password)`):
 *   https://datatracker.ietf.org/doc/html/rfc7617#section-2
 * - PostgreSQL connection URIs ("The URI scheme designator can be either
 *   postgresql:// or postgres://", libpq §Connection URIs):
 *   https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING
 */
import type {
  AuthCollectField,
  AuthCollectSpec,
  AuthMethodKind,
  AuthProbeRequest,
  SecretPlacement,
} from '@bubblelab/shared-schemas';
import { decodeCredentialPayload } from '@bubblelab/shared-schemas';

// ── Transport seam ────────────────────────────────────────────────────────────

/** A mutable request being prepared for an outbound call. */
export interface OutboundAuthRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: string;
}

export interface AuthHttpResponse {
  status: number;
  body: string;
}

export type AuthHttpTransport = (
  req: OutboundAuthRequest
) => Promise<AuthHttpResponse>;

export function emptyAuthRequest(
  url: string,
  method = 'GET'
): OutboundAuthRequest {
  return { url, method, headers: {}, query: {} };
}

export function buildAuthUrl(req: OutboundAuthRequest): string {
  const url = new URL(req.url);
  for (const [key, value] of Object.entries(req.query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export const fetchAuthTransport: AuthHttpTransport = async (req) => {
  const init: RequestInit = { method: req.method, headers: req.headers };
  if (req.body !== undefined) init.body = req.body;
  const response = await fetch(buildAuthUrl(req), init);
  return { status: response.status, body: await response.text() };
};

/** Run a canned probe; 2xx ⇒ the credential works. */
export async function probeAuth(
  req: OutboundAuthRequest,
  transport: AuthHttpTransport
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await transport(req);
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return {
      ok: false,
      error: `probe returned HTTP ${response.status}: ${response.body.slice(0, 200)}`,
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

// ── The strategy contract ─────────────────────────────────────────────────────

/** A credential resolved to its secret material (never stored in step code). */
export interface ResolvedAuthCredential {
  secret: string;
  expiresAt?: Date;
  grantedScopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthMethodStrategy {
  readonly kind: AuthMethodKind;
  /** What the Connect UI must ask for — the UI spec renders from this. */
  collect(): AuthCollectSpec;
  /** Canned probe proving the credential works (vendor "am I authed" call). */
  test(cred: ResolvedAuthCredential): Promise<{ ok: boolean; error?: string }>;
  /** Place the secret on an outbound request. */
  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void;
  /** Refresh-on-expiry. Omitted when the kind never expires. */
  refresh?(cred: ResolvedAuthCredential): Promise<ResolvedAuthCredential>;
  /** `undefined` ⇒ the provider exposes no grant metadata ⇒ first-run fallback. */
  grantedScopes?(cred: ResolvedAuthCredential): Promise<string[] | undefined>;
}

export function placeAuthSecret(
  placement: SecretPlacement,
  secret: string,
  req: OutboundAuthRequest
): void {
  if (placement.in === 'header') {
    req.headers[placement.name] =
      placement.scheme !== undefined ? `${placement.scheme} ${secret}` : secret;
  } else {
    req.query[placement.name] = secret;
  }
}

// ── api_key / pat: one pasted secret, header or query placement ──────────────

export interface SingleSecretConfig {
  placement: SecretPlacement;
  testRequest: AuthProbeRequest;
  label?: string;
  placeholder?: string;
  transport?: AuthHttpTransport;
}

export abstract class SingleSecretAuthMethod implements AuthMethodStrategy {
  abstract readonly kind: AuthMethodKind;
  protected readonly config: SingleSecretConfig;
  protected readonly transport: AuthHttpTransport;

  constructor(config: SingleSecretConfig) {
    this.config = config;
    this.transport = config.transport ?? fetchAuthTransport;
  }

  protected abstract defaultLabel(): string;
  protected abstract fieldName(): string;

  collect(): AuthCollectSpec {
    const field: AuthCollectField = {
      name: this.fieldName(),
      label: this.config.label ?? this.defaultLabel(),
      secret: true,
    };
    if (this.config.placeholder !== undefined) {
      field.placeholder = this.config.placeholder;
    }
    return { kind: this.kind, fields: [field] };
  }

  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void {
    placeAuthSecret(this.config.placement, cred.secret, req);
  }

  async test(
    cred: ResolvedAuthCredential
  ): Promise<{ ok: boolean; error?: string }> {
    const req = emptyAuthRequest(
      this.config.testRequest.url,
      this.config.testRequest.method ?? 'GET'
    );
    this.applyToRequest(cred, req);
    return probeAuth(req, this.transport);
  }
}

/** Static app/workspace key. Never expires; no scope metadata. */
export class ApiKeyAuthMethod extends SingleSecretAuthMethod {
  readonly kind = 'api_key' as const;
  protected defaultLabel(): string {
    return 'API key';
  }
  protected fieldName(): string {
    return 'api_key';
  }
}

/**
 * Personal access token. Same wire mechanics as api_key (GitHub: "you can
 * authenticate your request by sending the token in the Authorization header",
 * https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)
 * but user-scoped: the user picks scopes in the vendor UI before pasting.
 */
export class PatAuthMethod extends SingleSecretAuthMethod {
  readonly kind = 'pat' as const;
  protected defaultLabel(): string {
    return 'Personal access token';
  }
  protected fieldName(): string {
    return 'token';
  }
}

// ── basic: RFC 7617 username + password ──────────────────────────────────────

export interface BasicAuthConfig {
  testRequest: AuthProbeRequest;
  usernameLabel?: string;
  passwordLabel?: string;
  transport?: AuthHttpTransport;
}

/**
 * The composite secret is the same single-string JSON envelope BubbleLab
 * already uses for multi-value credentials (see decodeCredentialPayload).
 */
export class BasicAuthMethod implements AuthMethodStrategy {
  readonly kind = 'basic' as const;
  readonly #config: BasicAuthConfig;
  readonly #transport: AuthHttpTransport;

  constructor(config: BasicAuthConfig) {
    this.#config = config;
    this.#transport = config.transport ?? fetchAuthTransport;
  }

  collect(): AuthCollectSpec {
    return {
      kind: this.kind,
      fields: [
        {
          name: 'username',
          label: this.#config.usernameLabel ?? 'Username',
          secret: false,
        },
        {
          name: 'password',
          label: this.#config.passwordLabel ?? 'Password',
          secret: true,
        },
      ],
    };
  }

  /** RFC 7617 §2: `Authorization: Basic base64(user-id ":" password)`. */
  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void {
    const { username, password } = decodeCredentialPayload<{
      username?: string;
      password?: string;
    }>(cred.secret);
    if (username === undefined || password === undefined) {
      throw new Error(
        'basic credential is missing username or password fields'
      );
    }
    const encoded = Buffer.from(`${username}:${password}`, 'utf-8').toString(
      'base64'
    );
    req.headers['Authorization'] = `Basic ${encoded}`;
  }

  async test(
    cred: ResolvedAuthCredential
  ): Promise<{ ok: boolean; error?: string }> {
    const req = emptyAuthRequest(
      this.#config.testRequest.url,
      this.#config.testRequest.method ?? 'GET'
    );
    try {
      this.applyToRequest(cred, req);
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return probeAuth(req, this.#transport);
  }
}

// ── multi_field: N labelled fields, per-field placement ──────────────────────

export interface MultiFieldAuthSpec extends AuthCollectField {
  placement: SecretPlacement;
}

export interface MultiFieldAuthConfig {
  fields: MultiFieldAuthSpec[];
  testRequest: AuthProbeRequest;
  transport?: AuthHttpTransport;
}

export class MultiFieldAuthMethod implements AuthMethodStrategy {
  readonly kind = 'multi_field' as const;
  readonly #config: MultiFieldAuthConfig;
  readonly #transport: AuthHttpTransport;

  constructor(config: MultiFieldAuthConfig) {
    this.#config = config;
    this.#transport = config.transport ?? fetchAuthTransport;
  }

  collect(): AuthCollectSpec {
    return {
      kind: this.kind,
      fields: this.#config.fields.map(
        ({ name, label, secret, placeholder }) => {
          const field: AuthCollectField = { name, label, secret };
          if (placeholder !== undefined) field.placeholder = placeholder;
          return field;
        }
      ),
    };
  }

  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void {
    const values = decodeCredentialPayload<Record<string, string>>(cred.secret);
    for (const spec of this.#config.fields) {
      const value = values[spec.name];
      if (value === undefined) {
        throw new Error(
          `multi_field credential is missing declared field "${spec.name}"`
        );
      }
      placeAuthSecret(spec.placement, value, req);
    }
  }

  async test(
    cred: ResolvedAuthCredential
  ): Promise<{ ok: boolean; error?: string }> {
    const req = emptyAuthRequest(
      this.#config.testRequest.url,
      this.#config.testRequest.method ?? 'GET'
    );
    try {
      this.applyToRequest(cred, req);
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return probeAuth(req, this.#transport);
  }
}

// ── connection_string: a DSN/URI with embedded credentials ──────────────────

export interface ConnectionStringConfig {
  /** Accepted URI scheme designators, e.g. ['postgresql:', 'postgres:']. */
  allowedSchemes: string[];
  label?: string;
  placeholder?: string;
}

/**
 * test() validates URI shape only (scheme + host present). Live connectivity
 * needs a driver and belongs to BubbleLab's credential-validator, which each
 * database bubble's testCredential() already implements.
 */
export class ConnectionStringAuthMethod implements AuthMethodStrategy {
  readonly kind = 'connection_string' as const;
  readonly #config: ConnectionStringConfig;

  constructor(config: ConnectionStringConfig) {
    this.#config = config;
  }

  collect(): AuthCollectSpec {
    const field: AuthCollectField = {
      name: 'connection_string',
      label: this.#config.label ?? 'Connection string',
      secret: true,
    };
    if (this.#config.placeholder !== undefined) {
      field.placeholder = this.#config.placeholder;
    }
    return { kind: this.kind, fields: [field] };
  }

  /** The DSN itself is the credential; adapters consume it whole. */
  applyToRequest(cred: ResolvedAuthCredential, req: OutboundAuthRequest): void {
    req.headers['X-Connection-String'] = cred.secret;
  }

  async test(
    cred: ResolvedAuthCredential
  ): Promise<{ ok: boolean; error?: string }> {
    let parsed: URL;
    try {
      parsed = new URL(cred.secret);
    } catch {
      return { ok: false, error: 'connection string is not a valid URI' };
    }
    if (!this.#config.allowedSchemes.includes(parsed.protocol)) {
      return {
        ok: false,
        error: `scheme "${parsed.protocol}" is not one of ${this.#config.allowedSchemes.join(', ')}`,
      };
    }
    return { ok: true };
  }
}
