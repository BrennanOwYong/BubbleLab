import { z } from 'zod';
import { CredentialType } from './types';

/**
 * AuthMethod model (IR-3/IR-4): every way an app lets a user sign in, ranked by
 * convenience, derived from the app's documentation with a mandatory citation.
 *
 * One app may offer SEVERAL methods — "OAuth or paste a token" becomes two
 * AuthMethodDescriptors on one app and the user picks. This collapses the
 * SLACK_CRED-vs-SLACK_API dual-system confusion: both remain valid credential
 * types, surfaced as two methods of ONE app with a recommended default.
 *
 * Derivation discipline mirrors the IR-8 side-effect metadata: a method offered
 * in the Connect UI is a claim about the vendor's auth surface and must carry
 * its source (OpenAPI securitySchemes, doc prose, or an explicit manual
 * assertion). Where inference is uncertain it says so instead of guessing.
 *
 * References:
 * - OpenAPI 3.1 Security Scheme Object (type: apiKey | http | mutualTLS |
 *   oauth2 | openIdConnect): https://spec.openapis.org/oas/v3.1.0#security-scheme-object
 * - RFC 6749 (OAuth 2.0), RFC 6750 (Bearer), RFC 7617 (Basic):
 *   https://datatracker.ietf.org/doc/html/rfc6749
 */

export const AUTH_METHOD_KINDS = [
  'oauth2',
  'oauth2_jwt',
  'api_key',
  'pat',
  'basic',
  'connection_string',
  'multi_field',
  'browser_session',
  'xoauth2',
] as const;

export const AuthMethodKindSchema = z
  .enum(AUTH_METHOD_KINDS)
  .describe(
    "The auth strategy kind: 'oauth2' (authorization-code + scope picker), 'oauth2_jwt' (JWT bearer grant), 'api_key' (static app/workspace key), 'pat' (personal access token), 'basic' (RFC 7617 username:password), 'connection_string' (DSN/URI with embedded credentials), 'multi_field' (several labelled fields), 'browser_session' (guided browser login capturing a session), 'xoauth2' (SASL XOAUTH2)"
  );

export type AuthMethodKind = z.infer<typeof AuthMethodKindSchema>;

/**
 * Convenience ranking, lower = more convenient for a non-technical user.
 * OAuth with a scope picker is a popup + consent click (no secret handling);
 * a raw connection string embeds a password in a DSN the user must assemble.
 */
export const AUTH_METHOD_CONVENIENCE_RANK: Record<AuthMethodKind, number> = {
  oauth2: 1, // popup + consent, no secret ever copied
  browser_session: 2, // guided login, familiar to any user
  api_key: 3, // one value copied from a vendor console
  pat: 4, // one value, but the user must pick scopes in the vendor UI first
  oauth2_jwt: 5, // key upload / service-account configuration
  xoauth2: 6, // OAuth token wrapped in a SASL string
  basic: 7, // raw password handed to a third party
  multi_field: 8, // several console-hunted values
  connection_string: 9, // hand-assembled DSN with embedded password
};

/** Provenance of an inferred auth method, most → least authoritative. */
export const AUTH_METHOD_SOURCES = ['openapi', 'prose', 'manual'] as const;

export const AuthMethodSourceSchema = z
  .enum(AUTH_METHOD_SOURCES)
  .describe(
    "Where the method was derived from: 'openapi' (vendor OpenAPI securitySchemes), 'prose' (vendor doc prose), 'manual' (human assertion)"
  );

export type AuthMethodSource = z.infer<typeof AuthMethodSourceSchema>;

// ── Connect UI collection spec (what the Connect UI must ask for) ────────────

export const AuthCollectFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  secret: z
    .boolean()
    .describe('Render as a password input and never echo the value'),
  placeholder: z.string().optional(),
});

export type AuthCollectField = z.infer<typeof AuthCollectFieldSchema>;

export const AuthCollectScopeSchema = z.object({
  scope: z.string().min(1),
  description: z.string().optional(),
  defaultEnabled: z.boolean().optional(),
});

export type AuthCollectScope = z.infer<typeof AuthCollectScopeSchema>;

/**
 * What the Connect UI renders for one method: labelled fields for secret-paste
 * kinds, a scope picker for oauth2, a guided-login URL for browser_session.
 * Produced by AuthMethodStrategy.collect() in @bubblelab/bubble-core.
 */
export const AuthCollectSpecSchema = z.object({
  kind: AuthMethodKindSchema,
  fields: z.array(AuthCollectFieldSchema).optional(),
  scopes: z.array(AuthCollectScopeSchema).optional(),
  guidedLoginUrl: z.string().optional(),
});

export type AuthCollectSpec = z.infer<typeof AuthCollectSpecSchema>;

// ── Method descriptor (the doc-derived claim, bound to a credential type) ────

/** Where a pasted secret lands on an outbound request. */
export const SecretPlacementSchema = z.union([
  z.object({
    in: z.literal('header'),
    name: z.string().min(1),
    /** e.g. 'Bearer' — prefixed before the secret, RFC 6750 §2.1. */
    scheme: z.string().optional(),
  }),
  z.object({ in: z.literal('query'), name: z.string().min(1) }),
]);

export type SecretPlacement = z.infer<typeof SecretPlacementSchema>;

export const AuthProbeRequestSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
});

export type AuthProbeRequest = z.infer<typeof AuthProbeRequestSchema>;

/**
 * One sign-in method an app offers. `credentialType` binds the method to
 * BubbleLab's existing credential system: the user's choice of method decides
 * which CredentialType gets created, so the choice is honored end-to-end
 * without a parallel storage path.
 */
export const AuthMethodDescriptorSchema = z.object({
  kind: AuthMethodKindSchema,
  credentialType: z.nativeEnum(CredentialType),
  displayName: z.string().min(1),
  description: z.string().optional(),
  source: AuthMethodSourceSchema,
  citation: z
    .string()
    .min(1, 'Citation is mandatory — every offered method must carry its source')
    .describe('Doc URL and/or quoted vendor sentence grounding the method'),
  confidence: z.number().min(0).max(1),
  unverified: z
    .boolean()
    .optional()
    .describe('True when the doc signal was weak and a human must verify'),
  /** api_key / pat / basic-adjacent kinds: where the secret lands. */
  placement: SecretPlacementSchema.optional(),
  /** Canned probe proving the credential works (vendor "am I authed" endpoint). */
  testRequest: AuthProbeRequestSchema.optional(),
  /** multi_field: the labelled fields to collect. */
  fields: z.array(AuthCollectFieldSchema).optional(),
  /** connection_string: accepted URI schemes (e.g. postgresql://, postgres://). */
  allowedSchemes: z.array(z.string().min(1)).optional(),
  /** Field hints for single-secret kinds. */
  secretLabel: z.string().optional(),
  secretPlaceholder: z.string().optional(),
  /** oauth2: scope options for the scope picker. */
  scopes: z.array(AuthCollectScopeSchema).optional(),
});

export type AuthMethodDescriptor = z.infer<typeof AuthMethodDescriptorSchema>;

/** The methods one app offers, declared as the bubble class's static `authMethods`. */
export const AppAuthMethodsSchema = z.array(AuthMethodDescriptorSchema).min(1);

export type AppAuthMethods = z.infer<typeof AppAuthMethodsSchema>;

// ── Connect UI spec (ranked, recommended, rendered from collect()) ───────────

export const ConnectUiMethodOptionSchema = z.object({
  kind: AuthMethodKindSchema,
  credentialType: z.nativeEnum(CredentialType),
  displayName: z.string().min(1),
  description: z.string().optional(),
  rank: z.number().int().min(1),
  recommended: z.boolean(),
  collect: AuthCollectSpecSchema,
  source: AuthMethodSourceSchema,
  citation: z.string().min(1),
  unverified: z.boolean().optional(),
});

export type ConnectUiMethodOption = z.infer<typeof ConnectUiMethodOptionSchema>;

export const ConnectUiSpecSchema = z.object({
  bubbleName: z.string().min(1),
  /** Sorted most convenient first; exactly one entry has recommended: true. */
  methods: z.array(ConnectUiMethodOptionSchema).min(1),
  recommendedKind: AuthMethodKindSchema,
});

export type ConnectUiSpec = z.infer<typeof ConnectUiSpecSchema>;

/** Sort descriptors most-convenient-first; verified methods beat unverified at equal rank. */
export function sortByConvenience<
  T extends { kind: AuthMethodKind; unverified?: boolean },
>(methods: readonly T[]): T[] {
  return [...methods].sort((a, b) => {
    const rankDelta =
      AUTH_METHOD_CONVENIENCE_RANK[a.kind] -
      AUTH_METHOD_CONVENIENCE_RANK[b.kind];
    if (rankDelta !== 0) return rankDelta;
    return Number(a.unverified ?? false) - Number(b.unverified ?? false);
  });
}
