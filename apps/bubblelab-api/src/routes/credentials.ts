import { OpenAPIHono } from '@hono/zod-openapi';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import {
  type CredentialResponse,
  type CreateCredentialResponse,
  type UpdateCredentialResponse,
  CredentialType,
  DatabaseMetadata,
} from '../schemas/index.js';
import { getUserId } from '../middleware/auth.js';
import { CredentialEncryption } from '../utils/encryption.js';
import { eq, and } from 'drizzle-orm';
import {
  listCredentialsRoute,
  createCredentialRoute,
  updateCredentialRoute,
  deleteCredentialRoute,
  getCredentialMetadataRoute,
  credentialScopeCheckRoute,
} from '../schemas/credentials.js';
import type { CredentialScopeCheckResponse } from '../schemas/index.js';
import {
  oauthService,
  extractMetadataEmail,
} from '../services/oauth-service.js';
import { syncDerivedCredentialsForSource } from '../services/derived-credential-service.js';
import type { DerivedCredentialRecord } from '@bubblelab/shared-schemas';
import { getOAuthProviderGroupTypes } from '@bubblelab/shared-schemas';
import {
  setupErrorHandler,
  validationErrorHook,
} from '../utils/error-handler.js';
import { CredentialValidator } from '../services/credential-validator.js';

const app = new OpenAPIHono({
  defaultHook: validationErrorHook,
});
setupErrorHandler(app);

/**
 * Scope comparison key, mirroring the scope audit's normalization: trims whitespace and a
 * trailing '/' so 'https://mail.google.com/' equals 'https://mail.google.com'. Case is
 * preserved — OAuth scope strings are case-sensitive per RFC 6749 §3.3.
 */
function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

// POST /credentials/:id/scope-check — verify a credential's GRANTED scopes (live Google
// tokeninfo probe when possible, stored grants otherwise) against the flow's requirements.
// Serves suite-aware binding: a same-provider credential of a different type binds only
// when this check confirms coverage; otherwise the missing requirements drive incremental
// re-consent.
app.openapi(credentialScopeCheckRoute, async (c) => {
  const userId = getUserId(c);
  const credentialId = parseInt(c.req.valid('param').id, 10);
  const { requirements } = c.req.valid('json');

  const granted = await oauthService.checkGrantedScopes(userId, credentialId);
  if (!granted) {
    return c.json(
      { error: 'Credential not found or not an OAuth credential' },
      404
    );
  }

  const grantedSet = new Set(granted.grantedScopes.map(normalizeScope));
  const missing = requirements.filter(
    (requirement) =>
      !requirement.alternatives.some((alternative) =>
        grantedSet.has(normalizeScope(alternative))
      )
  );

  const response: CredentialScopeCheckResponse = {
    satisfied: missing.length === 0,
    grantedScopes: granted.grantedScopes,
    missing,
    source: granted.source,
  };
  return c.json(response, 200);
});

app.openapi(listCredentialsRoute, async (c) => {
  const userId = getUserId(c);

  const credentials = await db.query.userCredentials.findMany({
    where: eq(userCredentials.userId, userId),
    columns: {
      id: true,
      credentialType: true,
      name: true,
      metadata: true,
      createdAt: true,
      isOauth: true,
      oauthExpiresAt: true,
      oauthScopes: true,
      oauthProvider: true,
    },
  });

  // Lazy identity backfill: Google OAuth credentials connected before the callback
  // recorded the account email (metadata without email) get the email probed once
  // (OIDC userinfo) and persisted, so the studio's account dropdowns and setup-field
  // auto-population can name the account. A failed probe degrades to the bare row.
  const enriched = await Promise.all(
    credentials.map(async (cred) => {
      if (!cred.isOauth || cred.oauthProvider !== 'google') return cred;
      if (extractMetadataEmail(cred.metadata)) return cred;
      const backfilled = await oauthService.backfillGoogleAccountEmail(
        userId,
        cred.id
      );
      return backfilled ? { ...cred, metadata: backfilled } : cred;
    })
  );

  // Stored suite coverage: attach each credential's derived-credential records
  // (which sibling types its granted scopes serve). The sync here is the lazy
  // backfill seam for credentials connected before the table existed — pure
  // recomputation from stored oauth_scopes, diff-only writes, no network. Only
  // multi-type provider groups (google) can derive anything, so other rows skip
  // the sync entirely.
  const derivedByParent = new Map<number, DerivedCredentialRecord[]>();
  await Promise.all(
    enriched.map(async (cred) => {
      if (cred.isOauth !== true) return;
      const groupTypes = getOAuthProviderGroupTypes(
        cred.credentialType as CredentialType
      );
      if (groupTypes.length <= 1) return;
      const records = await syncDerivedCredentialsForSource({
        id: cred.id,
        userId,
        credentialType: cred.credentialType,
        isOauth: cred.isOauth,
        oauthProvider: cred.oauthProvider,
        oauthScopes: cred.oauthScopes,
      });
      if (records.length > 0) derivedByParent.set(cred.id, records);
    })
  );

  const response: CredentialResponse[] = enriched.map((cred) => {
    const now = new Date();
    let oauthStatus: 'active' | 'expired' | 'needs_refresh' | undefined;

    // Calculate OAuth status if this is an OAuth credential
    if (cred.isOauth && cred.oauthExpiresAt) {
      const expiresAt = new Date(cred.oauthExpiresAt);
      const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

      if (expiresAt < now) {
        oauthStatus = 'expired';
      } else if (expiresAt < fiveMinutesFromNow) {
        oauthStatus = 'needs_refresh';
      } else {
        oauthStatus = 'active';
      }
    }

    return {
      id: cred.id,
      credentialType: cred.credentialType,
      name: cred.name || undefined,
      metadata: cred.metadata || { tables: {}, rules: [] },
      createdAt: cred.createdAt.toISOString(),

      // OAuth fields
      isOauth: cred.isOauth || undefined,
      oauthProvider: cred.oauthProvider || undefined,
      oauthExpiresAt: cred.oauthExpiresAt?.toISOString() || undefined,
      oauthScopes: cred.oauthScopes || undefined,
      oauthStatus,

      // Stored derived-credential records (parent side of the hierarchy)
      derivedCredentials: derivedByParent.get(cred.id),
    };
  });

  return c.json(response, 200);
});

app.openapi(createCredentialRoute, async (c) => {
  const userId = getUserId(c);
  const {
    credentialType,
    value,
    name,
    skipValidation,
    credentialConfigurations,
    metadata,
  } = c.req.valid('json');

  // Validate credential before storing
  const validationResult = await CredentialValidator.validateCredential(
    credentialType,
    value,
    skipValidation || false,
    credentialConfigurations
  );

  if (!validationResult.isValid) {
    return c.json(
      {
        error: 'Credential validation failed',
        details: validationResult.error,
        bubbleName: validationResult.bubbleName,
      },
      400
    );
  }

  // Encrypt the credential value
  const encryptedValue = await CredentialEncryption.encrypt(value);

  // Store in database
  const [inserted] = await db
    .insert(userCredentials)
    .values({
      userId,
      credentialType,
      encryptedValue,
      name,
      metadata,
    })
    .returning({ id: userCredentials.id });

  const response: CreateCredentialResponse = {
    id: inserted.id,
    message: 'Credential created successfully',
  };

  return c.json(response, 201);
});

app.openapi(updateCredentialRoute, async (c) => {
  const userId = getUserId(c);
  const credentialId = parseInt(c.req.param('id'));
  const { value, name, skipValidation, credentialConfigurations, metadata } =
    c.req.valid('json');

  if (isNaN(credentialId)) {
    return c.json({ error: 'Invalid credential ID format' }, 400);
  }

  // Check if credential exists and belongs to user
  const credential = await db.query.userCredentials.findFirst({
    where: and(
      eq(userCredentials.id, credentialId),
      eq(userCredentials.userId, userId)
    ),
  });

  if (!credential) {
    return c.json({ error: 'Credential not found or access denied' }, 404);
  }

  // Prepare update data
  const updateData: {
    name?: string;
    encryptedValue?: string;
    metadata?: DatabaseMetadata;
  } = {};

  // Only update name if provided
  if (name !== undefined) {
    updateData.name = name;
  }

  // Only update metadata if provided
  if (metadata !== undefined) {
    updateData.metadata = metadata;
  }

  // Handle value update with proper validation
  if (value !== undefined) {
    // If value is provided, it must not be empty
    if (!value || value.trim() === '') {
      return c.json(
        {
          error: 'Credential value cannot be empty',
          details: 'A valid credential value is required',
        },
        400
      );
    }

    // Validate credential before updating
    const validationResult = await CredentialValidator.validateCredential(
      credential.credentialType as CredentialType,
      value,
      skipValidation || false,
      credentialConfigurations
    );

    if (!validationResult.isValid) {
      return c.json(
        {
          error: 'Credential validation failed',
          details: validationResult.error,
          bubbleName: validationResult.bubbleName,
        },
        400
      );
    }

    // Encrypt the new credential value
    const encryptedValue = await CredentialEncryption.encrypt(value);
    updateData.encryptedValue = encryptedValue;
  }

  // Update the credential
  const [updated] = await db
    .update(userCredentials)
    .set(updateData)
    .where(eq(userCredentials.id, credentialId))
    .returning({ id: userCredentials.id });

  const response: UpdateCredentialResponse = {
    id: updated.id,
    message: 'Credential updated successfully',
  };

  return c.json(response, 200);
});

app.openapi(deleteCredentialRoute, async (c) => {
  const userId = getUserId(c);
  const credentialId = parseInt(c.req.param('id'));

  if (isNaN(credentialId)) {
    return c.json({ error: 'Invalid credential ID format' }, 400);
  }

  // Check if credential exists and belongs to user
  const credential = await db.query.userCredentials.findFirst({
    where: and(
      eq(userCredentials.id, credentialId),
      eq(userCredentials.userId, userId)
    ),
  });

  if (!credential) {
    return c.json({ error: 'Credential not found or access denied' }, 404);
  }

  if (credential.isOauth) {
    // Revoke the token at the provider (best effort — an already-invalid token
    // or unreachable provider never blocks the delete), then drop the row.
    await oauthService.revokeCredential(credentialId);
  } else {
    await db
      .delete(userCredentials)
      .where(eq(userCredentials.id, credentialId));
  }

  return c.json({ message: 'Credential deleted successfully' }, 200);
});

app.openapi(getCredentialMetadataRoute, async (c) => {
  const userId = getUserId(c);
  const credentialId = parseInt(c.req.param('id'));

  if (isNaN(credentialId)) {
    return c.json({ error: 'Invalid credential ID format' }, 400);
  }

  // Check if credential exists and belongs to user
  const credential = await db.query.userCredentials.findFirst({
    where: and(
      eq(userCredentials.id, credentialId),
      eq(userCredentials.userId, userId)
    ),
  });

  if (!credential) {
    return c.json({ error: 'Credential not found or access denied' }, 404);
  }

  // Either the access token (OAuth) or the encrypted value (API key)
  const credentialValue =
    credential.encryptedValue || credential.oauthAccessToken;

  if (!credentialValue) {
    console.error(`Credential ${credential.id} has no valid credential value - isOauth: 
  ${credential.isOauth}`);
    return c.json({ error: 'Credential data is invalid' }, 400);
  }

  // Get metadata from the credential using the validator
  const metadata = await CredentialValidator.getEncryptedCredentialMetadata(
    credential.credentialType as CredentialType,
    credentialValue
  );

  return c.json(metadata || null, 200);
});

export default app;
