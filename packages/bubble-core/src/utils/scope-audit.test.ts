/**
 * Proactive scope audit (IR-6/7) — unit tests against the REAL doc-grounded metadata the
 * backfill emitted for the Google bubbles. No mocking of the unit under test.
 *
 * Acceptance criteria covered here (the API-level wiring re-tests them through the route):
 * 1. A flow needing an ungranted scope FAILS the audit NAMING the missing scope and the
 *    operations that need it.
 * 2. A credential/provider without scope metadata degrades to an explicit, honest
 *    "can only surface on first run" message — never a silent pass.
 */
import { describe, it, expect } from 'vitest';
import { CredentialScopeAuditSchema } from '@bubblelab/shared-schemas';
import {
  auditCredentialScopes,
  collectScopeRequirements,
  scopeAlternatives,
} from './scope-audit.js';
import { GMAIL_OPERATION_METADATA } from '../bubbles/service-bubble/gmail.metadata.js';
import { GOOGLE_CALENDAR_OPERATION_METADATA } from '../bubbles/service-bubble/google-calendar.metadata.js';
import { GOOGLE_DRIVE_OPERATION_METADATA } from '../bubbles/service-bubble/google-drive.metadata.js';
import { RESEND_OPERATION_METADATA } from '../bubbles/service-bubble/resend.metadata.js';

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const MAIL_GOOGLE = 'https://mail.google.com/';

describe('backfilled requiredScopes coverage (audit input integrity)', () => {
  it('every gmail / google-calendar / google-drive operation declares requiredScopes', () => {
    for (const [bubble, metadata] of Object.entries({
      gmail: GMAIL_OPERATION_METADATA,
      'google-calendar': GOOGLE_CALENDAR_OPERATION_METADATA,
      'google-drive': GOOGLE_DRIVE_OPERATION_METADATA,
    })) {
      for (const [operation, entry] of Object.entries(metadata)) {
        expect(
          entry.requiredScopes,
          `${bubble}.${operation} must declare requiredScopes`
        ).toBeDefined();
        expect(entry.requiredScopes!.length).toBeGreaterThan(0);
        // Every alternative is a well-formed Google scope URL
        for (const alternative of entry.requiredScopes!.flatMap(
          scopeAlternatives
        )) {
          expect(alternative).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it('gmail send_email accepts exactly the four scopes on the cited method page', () => {
    const scopes = GMAIL_OPERATION_METADATA.send_email.requiredScopes!;
    expect(scopes).toHaveLength(1);
    expect(scopeAlternatives(scopes[0]).sort()).toEqual(
      [
        MAIL_GOOGLE,
        GMAIL_MODIFY,
        'https://www.googleapis.com/auth/gmail.compose',
        GMAIL_SEND,
      ].sort()
    );
  });
});

describe('AC-1: missing scope fails, NAMING the scope and the operations needing it', () => {
  it('send_email with a readonly-only grant reports missing_scopes naming gmail.send', () => {
    const result = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      credentialId: 42,
      grantedScopes: [GMAIL_READONLY],
      callSites: [
        {
          bubbleName: 'gmail',
          variableName: 'mailer',
          operation: 'send_email',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });

    expect(result.status).toBe('missing_scopes');
    expect(result.missingScopes).toHaveLength(1);
    // The failure NAMES the missing scope...
    expect(result.message).toContain(GMAIL_SEND);
    // ...and the operation that needs it, and the credential it audited.
    expect(result.message).toContain('gmail.send_email');
    expect(result.message).toContain('credential #42');
    expect(result.message).toContain('mailer');
    // Structured output parses against the shared schema
    expect(() => CredentialScopeAuditSchema.parse(result)).not.toThrow();
  });

  it('mixed flow: satisfied read op stays satisfied, unsatisfied write op is the one named', () => {
    const result = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      grantedScopes: [GMAIL_READONLY],
      callSites: [
        {
          bubbleName: 'gmail',
          operation: 'list_emails',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
        {
          bubbleName: 'gmail',
          operation: 'send_email',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });

    expect(result.status).toBe('missing_scopes');
    const satisfied = result.requirements.filter((r) => r.satisfied);
    const missing = result.requirements.filter((r) => !r.satisfied);
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0].requiredBy[0].operation).toBe('list_emails');
    expect(missing).toHaveLength(1);
    expect(missing[0].requiredBy[0].operation).toBe('send_email');
    expect(result.message).not.toContain('list_emails');
  });

  it('delete_email requires full mail.google.com — a gmail.modify grant is not enough', () => {
    const result = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      grantedScopes: [GMAIL_MODIFY],
      callSites: [
        {
          bubbleName: 'gmail',
          operation: 'delete_email',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });
    expect(result.status).toBe('missing_scopes');
    expect(result.message).toContain(MAIL_GOOGLE);
  });
});

describe('any-of alternatives and normalization', () => {
  it('any single alternative from the accepted set passes send_email', () => {
    for (const granted of [GMAIL_SEND, GMAIL_MODIFY, MAIL_GOOGLE]) {
      const result = auditCredentialScopes({
        credentialType: 'GMAIL_CRED',
        grantedScopes: [granted],
        callSites: [
          {
            bubbleName: 'gmail',
            operation: 'send_email',
            operationMetadata: GMAIL_OPERATION_METADATA,
          },
        ],
      });
      expect(result.status, `granted=${granted}`).toBe('pass');
    }
  });

  it('trailing-slash differences do not produce false failures', () => {
    const result = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      grantedScopes: ['https://mail.google.com'], // stored without trailing slash
      callSites: [
        {
          bubbleName: 'gmail',
          operation: 'delete_email',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });
    expect(result.status).toBe('pass');
  });

  it('calendar write op passes with the broad calendar scope BubbleLab requests by default', () => {
    const result = auditCredentialScopes({
      credentialType: 'GOOGLE_CALENDAR_CRED',
      grantedScopes: ['https://www.googleapis.com/auth/calendar'],
      callSites: [
        {
          bubbleName: 'google-calendar',
          operation: 'create_event',
          operationMetadata: GOOGLE_CALENDAR_OPERATION_METADATA,
        },
      ],
    });
    expect(result.status).toBe('pass');
  });

  it('drive share_file (permissions.create) rejects a readonly-only grant', () => {
    const result = auditCredentialScopes({
      credentialType: 'GOOGLE_DRIVE_CRED',
      grantedScopes: ['https://www.googleapis.com/auth/drive.readonly'],
      callSites: [
        {
          bubbleName: 'google-drive',
          operation: 'share_file',
          operationMetadata: GOOGLE_DRIVE_OPERATION_METADATA,
        },
      ],
    });
    expect(result.status).toBe('missing_scopes');
    expect(result.message).toContain('drive.file');
  });
});

describe('AC-2: honest degrade when the audit cannot verify (never a silent pass)', () => {
  it('credential with no recorded grants → unknown_grants with an explicit first-run message', () => {
    const result = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      credentialId: 7,
      grantedScopes: undefined,
      callSites: [
        {
          bubbleName: 'gmail',
          operation: 'send_email',
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });

    expect(result.status).toBe('unknown_grants');
    expect(result.message).toContain('provider exposes no scope metadata');
    expect(result.message).toContain('first run');
    expect(result.message).toContain('not a verified pass');
    // Requirements are reported but none claimed satisfied
    expect(result.requirements.length).toBeGreaterThan(0);
    expect(result.requirements.every((r) => r.satisfied === false)).toBe(true);
    expect(() => CredentialScopeAuditSchema.parse(result)).not.toThrow();
  });

  it('operations without declared scopes (resend API key) → no_scope_metadata, stated plainly', () => {
    const result = auditCredentialScopes({
      credentialType: 'RESEND_CRED',
      grantedScopes: undefined,
      callSites: [
        {
          bubbleName: 'resend',
          operation: 'send_email',
          operationMetadata: RESEND_OPERATION_METADATA,
        },
      ],
    });

    expect(result.status).toBe('no_scope_metadata');
    expect(result.message).toContain('declare no scope requirements');
    expect(result.message).toContain('first run');
  });

  it('bubble with no operationMetadata at all → no_scope_metadata', () => {
    const result = auditCredentialScopes({
      credentialType: 'SLACK_CRED',
      grantedScopes: ['channels:read'],
      callSites: [
        { bubbleName: 'slack', operation: 'send_message' }, // no metadata declared
      ],
    });
    expect(result.status).toBe('no_scope_metadata');
  });
});

describe('requirement collection', () => {
  it('dedupes a shared requirement across call sites, attributing every operation', () => {
    const requirements = collectScopeRequirements([
      {
        bubbleName: 'gmail',
        variableName: 'a',
        operation: 'list_emails',
        operationMetadata: GMAIL_OPERATION_METADATA,
      },
      {
        bubbleName: 'gmail',
        variableName: 'b',
        operation: 'get_email',
        operationMetadata: GMAIL_OPERATION_METADATA,
      },
    ]);
    // messages.list and messages.get share the same accepted-scope set → one requirement
    expect(requirements).toHaveLength(1);
    expect(requirements[0].requiredBy.map((r) => r.operation).sort()).toEqual([
      'get_email',
      'list_emails',
    ]);
  });

  it('statically unresolvable operation audits conservatively over every declared operation', () => {
    const requirements = collectScopeRequirements([
      {
        bubbleName: 'gmail',
        operation: undefined,
        operationMetadata: GMAIL_OPERATION_METADATA,
      },
    ]);
    // Conservative union must include the strictest requirement (delete: mail.google.com only)
    const entries = requirements.map((r) => r.scope);
    expect(entries).toContain(MAIL_GOOGLE);
    expect(
      requirements.every((r) =>
        r.requiredBy.every((ref) => ref.operation.includes('conservatively'))
      )
    ).toBe(true);
    // A grant of only gmail.send cannot cover the conservative union
    const audit = auditCredentialScopes({
      credentialType: 'GMAIL_CRED',
      grantedScopes: [GMAIL_SEND],
      callSites: [
        {
          bubbleName: 'gmail',
          operation: undefined,
          operationMetadata: GMAIL_OPERATION_METADATA,
        },
      ],
    });
    expect(audit.status).toBe('missing_scopes');
  });
});
