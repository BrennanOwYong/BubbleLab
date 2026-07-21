/**
 * Dev-smoke seeding for the suite-provenance MVP proof.
 *
 * Seeds (for the DISABLE_AUTH dev user 'mock-user-id'):
 * - a GMAIL_CRED google OAuth row with metadata = NULL (the pre-identity-write
 *   state fix #1 backfills) and a fake token the stubbed userinfo maps to
 *   gmail-user@example.com,
 * - a GOOGLE_DRIVE_CRED google OAuth row, also metadata = NULL, whose granted
 *   scopes cover Sheets + Calendar (drives fix #2 suite binding and fix #3
 *   coverage line),
 * - one flow (via POST /bubble-flow against the running smoke API) with a
 *   gmailAccountEmail input, a Gmail step, and a Google Sheets step.
 *
 * Run from apps/bubblelab-api (so .env loads):
 *   DATABASE_URL=file:./dev.db ~/.bun/bin/bun ../../apps/bubblelab-api/scripts/seed-provenance-smoke.ts
 */
import { db } from '../src/db/index.js';
import { userCredentials, bubbleFlows } from '../src/db/schema.js';
import { CredentialEncryption } from '../src/utils/encryption.js';
import { eq } from 'drizzle-orm';

const API = process.env.SMOKE_API_URL ?? 'http://localhost:3210';
const USER_ID = 'mock-user-id';

const FLOW_CODE = `
import { BubbleFlow, GmailBubble, GoogleSheetsBubble } from '@bubblelab/bubble-core';
import type { WebhookEvent } from '@bubblelab/bubble-core';

export interface Output {
  sent: boolean;
  created: boolean;
}

export interface CustomWebhookPayload extends WebhookEvent {
  /** Gmail account the report is sent from. */
  gmailAccountEmail?: string;
}

export class SuiteProvenanceSmoke extends BubbleFlow<'webhook/http'> {
  async handle(payload: CustomWebhookPayload): Promise<Output> {
    const mailer = new GmailBubble({
      operation: 'send_email',
      to: ['someone@example.com'],
      subject: 'Provenance smoke',
      body_text: 'Hello from the provenance smoke flow.',
    });
    const sendResult = await mailer.action();
    const sheet = new GoogleSheetsBubble({
      operation: 'create_spreadsheet',
      title: 'Provenance smoke sheet',
      sheet_titles: ['Sheet1'],
    });
    const sheetResult = await sheet.action();
    return { sent: sendResult.success, created: sheetResult.success };
  }
}`;

async function main(): Promise<void> {
  // Idempotent: clear this smoke's earlier rows.
  await db.delete(userCredentials).where(eq(userCredentials.userId, USER_ID));
  await db.delete(bubbleFlows).where(eq(bubbleFlows.userId, USER_ID));

  const [gmail] = await db
    .insert(userCredentials)
    .values({
      userId: USER_ID,
      credentialType: 'GMAIL_CRED',
      name: 'Legacy Gmail',
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: [
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
      ],
      oauthAccessToken: await CredentialEncryption.encrypt('fake-gmail-token'),
      metadata: null, // the pre-identity-write state
    })
    .returning({ id: userCredentials.id });

  const [drive] = await db
    .insert(userCredentials)
    .values({
      userId: USER_ID,
      credentialType: 'GOOGLE_DRIVE_CRED',
      name: 'Legacy Drive',
      isOauth: true,
      oauthProvider: 'google',
      oauthScopes: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/documents',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/calendar',
      ],
      oauthAccessToken: await CredentialEncryption.encrypt('fake-drive-token'),
      metadata: null,
    })
    .returning({ id: userCredentials.id });

  const response = await fetch(`${API}/bubble-flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Suite provenance smoke',
      description: 'Gmail + Sheets flow for the provenance smoke test',
      code: FLOW_CODE,
      eventType: 'webhook/http',
    }),
  });
  const body = (await response.json()) as { id?: number; error?: string };
  if (!response.ok || body.id === undefined) {
    throw new Error(
      `flow create failed: ${response.status} ${JSON.stringify(body)}`
    );
  }

  console.log(
    JSON.stringify({
      gmailCredentialId: gmail.id,
      driveCredentialId: drive.id,
      flowId: body.id,
    })
  );
}

await main();
process.exit(0);
