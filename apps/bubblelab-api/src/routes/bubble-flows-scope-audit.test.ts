/**
 * Proactive scope audit through the real validate route (IR-6/7 acceptance criteria).
 *
 * AC-1: a flow needing a scope the credential was not granted FAILS validation, NAMING the
 *       missing scope and the operation that needs it.
 * AC-2: a credential whose provider exposes no scope metadata does not fail silently — the
 *       response carries an explicit "can only surface on first run" warning.
 *
 * Runs against the real Hono app, real parser/validator, real sqlite test DB. Nothing in the
 * audit path is mocked.
 */
// @ts-expect-error - Bun test types
import { describe, it, expect } from 'bun:test';
import '../config/env.js';
import { TestApp } from '../test/test-app.js';
import { TEST_USER_ID } from '../test/setup.js';
import { db } from '../db/index.js';
import { userCredentials } from '../db/schema.js';
import type { FlowScopeAudit } from '@bubblelab/shared-schemas';

const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

const GMAIL_SEND_FLOW = `
import { BubbleFlow, GmailBubble } from '@bubblelab/bubble-core';
import type { BubbleTriggerEventRegistry } from '@bubblelab/bubble-core';

export interface Output {
  sent: boolean;
}

export class ScopeAuditSendFlow extends BubbleFlow<'webhook/http'> {
  constructor() {
    super('scope-audit-send-flow', 'Sends one email');
  }

  async handle(
    payload: BubbleTriggerEventRegistry['webhook/http']
  ): Promise<Output> {
    const mailer = new GmailBubble({
      operation: 'send_email',
      to: ['someone@example.com'],
      subject: 'Scope audit test',
      body_text: 'Hello from the scope audit test.',
    });
    const result = await mailer.action();
    return { sent: result.success };
  }
}`;

interface ValidateResponse {
  valid: boolean;
  errors?: string[];
  scopeAudit?: FlowScopeAudit;
}

async function seedGmailCredential(
  oauthScopes: string[] | null
): Promise<number> {
  const [row] = await db
    .insert(userCredentials)
    .values({
      userId: TEST_USER_ID,
      credentialType: 'GMAIL_CRED',
      name: 'Scope audit gmail credential',
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes,
    })
    .returning({ id: userCredentials.id });
  return row.id;
}

async function validateFlow(credentialId: number): Promise<ValidateResponse> {
  const response = await TestApp.post('/bubble-flow/validate', {
    code: GMAIL_SEND_FLOW,
    credentials: {
      mailer: { GMAIL_CRED: credentialId },
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ValidateResponse;
}

describe('proactive scope audit on POST /bubble-flow/validate', () => {
  it('AC-1: fails the build naming the missing scope and the operation needing it', async () => {
    // Granted readonly only; the flow sends — gmail.send (or an alternative) is missing.
    const credentialId = await seedGmailCredential([GMAIL_READONLY]);
    const body = await validateFlow(credentialId);

    expect(body.valid).toBe(false);
    const joined = (body.errors ?? []).join('; ');
    expect(joined).toContain(GMAIL_SEND); // names the scope
    expect(joined).toContain('gmail.send_email'); // names the operation
    expect(joined).toContain(`credential #${credentialId}`);

    expect(body.scopeAudit).toBeDefined();
    expect(body.scopeAudit!.ok).toBe(false);
    const audit = body.scopeAudit!.results.find(
      (result) => result.credentialId === credentialId
    );
    expect(audit?.status).toBe('missing_scopes');
    expect(audit?.missingScopes.length).toBe(1);
  }, 120000);

  it('passes the build when an accepted scope for every operation is granted', async () => {
    const credentialId = await seedGmailCredential([GMAIL_SEND]);
    const body = await validateFlow(credentialId);

    expect(body.valid).toBe(true);
    const audit = body.scopeAudit!.results.find(
      (result) => result.credentialId === credentialId
    );
    expect(audit?.status).toBe('pass');
  }, 120000);

  it('AC-2: credential without recorded grants degrades honestly instead of failing or passing silently', async () => {
    // OAuth row persisted without scope grants — the provider side of "no scope metadata".
    const credentialId = await seedGmailCredential(null);
    const body = await validateFlow(credentialId);

    // The build is NOT failed on unverifiable data...
    expect(body.valid).toBe(true);
    // ...but the response says plainly that verification was impossible and why.
    const audit = body.scopeAudit!.results.find(
      (result) => result.credentialId === credentialId
    );
    expect(audit?.status).toBe('unknown_grants');
    expect(audit?.message).toContain('provider exposes no scope metadata');
    expect(audit?.message).toContain('first run');
    expect(body.scopeAudit!.warnings.join(' ')).toContain('first run');
  }, 120000);

  it('flow without assigned credentials produces an empty audit and no failure', async () => {
    const response = await TestApp.post('/bubble-flow/validate', {
      code: GMAIL_SEND_FLOW,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ValidateResponse;
    expect(body.valid).toBe(true);
    expect(body.scopeAudit?.ok).toBe(true);
    expect(body.scopeAudit?.results ?? []).toHaveLength(0);
  }, 120000);
});
