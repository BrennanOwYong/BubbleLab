// ========================= OAuth Schemas =========================
import { z } from '@hono/zod-openapi';
import { CredentialType } from './types';

// OAuth initiation request schema
export const oauthInitiateRequestSchema = z
  .object({
    credentialType: z.nativeEnum(CredentialType).openapi({
      description: 'The type of credential to create',
      example: CredentialType.GOOGLE_DRIVE_CRED,
    }),
    name: z.string().optional().openapi({
      description: 'Optional name for the credential',
      example: 'My Google Drive',
    }),
    scopes: z
      .array(z.string())
      .optional()
      .openapi({
        description:
          'Optional OAuth scopes to request (defaults based on credential type)',
        example: ['https://www.googleapis.com/auth/drive.readonly'],
      }),
    subdomain: z.string().optional().openapi({
      description:
        'Subdomain for providers that require subdomain-scoped OAuth (e.g. Zendesk)',
      example: 'mycompany',
    }),
    credentialId: z.number().int().positive().optional().openapi({
      description:
        'Incremental re-consent target: the existing OAuth credential to ADD the requested scopes to. The callback updates this row (token + scope union) instead of inserting a new credential. Google authorization runs with include_granted_scopes=true so the returned token accumulates previously granted scopes.',
      example: 42,
    }),
  })
  .openapi('OAuthInitiateRequest');

// OAuth initiation response schema
export const oauthInitiateResponseSchema = z
  .object({
    authUrl: z.string().url().openapi({
      description: 'OAuth authorization URL to redirect user to',
      example: 'https://accounts.google.com/oauth2/auth?client_id=...',
    }),
    state: z.string().openapi({
      description: 'CSRF protection state parameter',
      example: 'abc123-def456-ghi789',
    }),
  })
  .openapi('OAuthInitiateResponse');

// OAuth callback request schema (for POST callback with credential details)
export const oauthCallbackRequestSchema = z
  .object({
    code: z.string().openapi({
      description: 'OAuth authorization code from provider',
      example: 'abc123def456',
    }),
    state: z.string().openapi({
      description: 'CSRF protection state parameter',
      example: 'abc123-def456-ghi789',
    }),
    name: z.string().openapi({
      description: 'Name for the credential',
      example: 'My Google Drive',
    }),
    description: z.string().optional().openapi({
      description: 'Optional description for the credential',
    }),
  })
  .openapi('OAuthCallbackRequest');

// OAuth token refresh response schema
export const oauthTokenRefreshResponseSchema = z
  .object({
    message: z.string().openapi({
      description: 'Success message',
      example: 'Token refreshed successfully',
    }),
  })
  .openapi('OAuthTokenRefreshResponse');

// OAuth revoke response schema
export const oauthRevokeResponseSchema = z
  .object({
    message: z.string().openapi({
      description: 'Success message',
      example: 'Credential revoked successfully',
    }),
  })
  .openapi('OAuthRevokeResponse');

// ========================= Scope check (suite-aware binding) =========================

/**
 * One scope requirement to verify against a credential's granted scopes.
 * Mirrors the scope-audit encoding: the requirement is satisfied when the
 * grant set contains ANY of `alternatives`.
 */
export const scopeCheckRequirementSchema = z
  .object({
    scope: z.string().openapi({
      description:
        "The requirement as declared (alternatives joined with '|'); satisfied by any one alternative",
      example: 'https://www.googleapis.com/auth/spreadsheets',
    }),
    alternatives: z
      .array(z.string())
      .min(1)
      .openapi({
        description: 'The individual scopes that each satisfy this requirement',
        example: ['https://www.googleapis.com/auth/spreadsheets'],
      }),
  })
  .openapi('ScopeCheckRequirement');

// POST /credentials/:id/scope-check request
export const credentialScopeCheckRequestSchema = z
  .object({
    requirements: z.array(scopeCheckRequirementSchema).openapi({
      description:
        'Scope requirements to verify (from flow scope discovery). May be empty to probe granted scopes only.',
    }),
  })
  .openapi('CredentialScopeCheckRequest');

// POST /credentials/:id/scope-check response
export const credentialScopeCheckResponseSchema = z
  .object({
    satisfied: z.boolean().openapi({
      description:
        'Whether the granted scopes cover every requirement (any-of per requirement)',
    }),
    grantedScopes: z.array(z.string()).openapi({
      description:
        "Scopes actually granted on the credential's token, from a live provider probe when possible",
    }),
    missing: z.array(scopeCheckRequirementSchema).openapi({
      description: 'Requirements the granted scopes do not cover',
    }),
    source: z.enum(['probe', 'stored']).openapi({
      description:
        "'probe' = granted scopes read live from the provider (Google tokeninfo) and synced to storage; 'stored' = probe unavailable, recorded grants used",
    }),
  })
  .openapi('CredentialScopeCheckResponse');

export type ScopeCheckRequirement = z.infer<typeof scopeCheckRequirementSchema>;
export type CredentialScopeCheckRequest = z.infer<
  typeof credentialScopeCheckRequestSchema
>;
export type CredentialScopeCheckResponse = z.infer<
  typeof credentialScopeCheckResponseSchema
>;

// Export OAuth TypeScript types
export type OAuthInitiateRequest = z.infer<typeof oauthInitiateRequestSchema>;
export type OAuthInitiateResponse = z.infer<typeof oauthInitiateResponseSchema>;
export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;
export type OAuthTokenRefreshResponse = z.infer<
  typeof oauthTokenRefreshResponseSchema
>;
export type OAuthRevokeResponse = z.infer<typeof oauthRevokeResponseSchema>;
