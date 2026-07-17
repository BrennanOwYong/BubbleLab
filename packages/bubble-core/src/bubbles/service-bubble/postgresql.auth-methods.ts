/**
 * Doc-derived auth methods for the 'postgresql' bubble (IR-3/IR-4): a
 * connection string is the one supported sign-in (DATABASE_CRED) — and the
 * least convenient kind in the ranking, which is exactly why apps offering an
 * OAuth alternative rank it above this.
 *
 * Evidence quote fetched 2026-07-15 from the official libpq docs; re-verify at
 * https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING
 * before editing.
 */
import { CredentialType } from '@bubblelab/shared-schemas';
import type { AppAuthMethods } from '@bubblelab/shared-schemas';
import { inferAuthMethods } from '../../auth/infer-auth-methods.js';
import { bindInferredAuthMethods } from '../../auth/connect-ui-spec.js';

const POSTGRESQL_AUTH_INFERENCE = inferAuthMethods([
  {
    kind: 'prose',
    docText:
      'Connection strings come in two flavors: keyword/value strings and URIs. The URI scheme designator can be either postgresql:// or postgres://. The general form for a connection URI is postgresql://[userspec@][hostspec][/dbname][?paramspec].',
    citation:
      'https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNSTRING — "The URI scheme designator can be either postgresql:// or postgres://."',
  },
]);

export const POSTGRESQL_AUTH_METHODS: AppAuthMethods = bindInferredAuthMethods(
  POSTGRESQL_AUTH_INFERENCE,
  [
    {
      kind: 'connection_string',
      credentialType: CredentialType.DATABASE_CRED,
      displayName: 'Paste a PostgreSQL connection string',
      description:
        'Paste the full connection URI, including user and password, from your database provider.',
      allowedSchemes: ['postgresql:', 'postgres:'],
      secretLabel: 'Connection string',
      secretPlaceholder: 'postgresql://user:pass@host:5432/dbname',
    },
  ]
);
