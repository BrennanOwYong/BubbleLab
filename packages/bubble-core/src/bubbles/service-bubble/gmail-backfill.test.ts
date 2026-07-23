import { describe, it, expect, vi, afterEach } from 'vitest';
import { GmailBubble } from './gmail.js';
import { CredentialType } from '@bubblelab/shared-schemas';

const TOKEN = 'test-oauth-token';
const CREDS = { [CredentialType.GMAIL_CRED]: TOKEN };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const toBase64Url = (text: string) =>
  Buffer.from(text, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const decodeRawFromRequest = (init: RequestInit): string => {
  const body = JSON.parse(init.body as string);
  const base64 = (body.raw as string).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GmailBubble get_thread', () => {
  it('calls users.threads.get with format=full and returns thread messages', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: 'thread-123',
        historyId: '99887',
        messages: [
          {
            id: 'msg-1',
            threadId: 'thread-123',
            snippet: 'first message',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'Subject', value: 'Deal stage' },
                { name: 'Message-ID', value: '<first@mail.gmail.com>' },
                { name: 'X-Received', value: 'internal-routing-noise' },
              ],
              body: { data: toBase64Url('hello from message one'), size: 22 },
            },
          },
          {
            id: 'msg-2',
            threadId: 'thread-123',
            snippet: 'second message',
            payload: {
              mimeType: 'text/plain',
              headers: [{ name: 'Subject', value: 'Re: Deal stage' }],
              body: { data: toBase64Url('reply body'), size: 10 },
            },
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'get_thread',
      thread_id: 'thread-123',
      credentials: CREDS,
    }).action();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://www.googleapis.com/gmail/v1/users/me/threads/thread-123?format=full'
    );
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`
    );

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.operation).toBe('get_thread');
    expect(data.thread.id).toBe('thread-123');
    expect(data.thread.messages).toHaveLength(2);
    // Body text is decoded into textContent for direct consumption
    expect(data.thread.messages[0].textContent).toBe('hello from message one');
    expect(data.thread.messages[1].textContent).toBe('reply body');
    // Essential headers kept, noise headers dropped, base64 body stripped
    const headerNames = data.thread.messages[0].payload.headers.map(
      (h: any) => h.name
    );
    expect(headerNames).toContain('Subject');
    expect(headerNames).toContain('Message-ID');
    expect(headerNames).not.toContain('X-Received');
    expect(data.thread.messages[0].payload.body.data).toBeUndefined();
  });

  it('passes metadata format and metadataHeaders through', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'thread-9', messages: [] })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'get_thread',
      thread_id: 'thread-9',
      format: 'metadata',
      metadata_headers: ['Subject', 'From'],
      credentials: CREDS,
    }).action();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/threads/thread-9?format=metadata');
    expect(url).toContain('metadataHeaders=Subject');
    expect(url).toContain('metadataHeaders=From');
    expect(result.success).toBe(true);
  });
});

describe('GmailBubble get_attachment', () => {
  it('calls users.messages.attachments.get and converts base64url to padded base64', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        // base64url of 'hello world' ('aGVsbG8gd29ybGQ=' minus padding)
        data: 'aGVsbG8gd29ybGQ',
        size: 11,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'get_attachment',
      message_id: 'msg-77',
      attachment_id: 'att-42',
      credentials: CREDS,
    }).action();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://www.googleapis.com/gmail/v1/users/me/messages/msg-77/attachments/att-42'
    );
    expect(init.method).toBe('GET');

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.operation).toBe('get_attachment');
    expect(data.data).toBe('aGVsbG8gd29ybGQ=');
    expect(Buffer.from(data.data, 'base64').toString('utf-8')).toBe(
      'hello world'
    );
    expect(data.size).toBe(11);
  });
});

describe('GmailBubble send_email attachments', () => {
  it('builds a multipart/mixed MIME message with base64 attachment parts', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'sent-1', threadId: 'thread-1' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pdfBase64 = Buffer.from('%PDF-1.4 fake invoice').toString('base64');

    const result = await new GmailBubble({
      operation: 'send_email',
      to: ['alex@example.com'],
      subject: 'Invoice attached',
      body_text: 'See attached invoice.',
      attachments: [
        {
          filename: 'invoice.pdf',
          mime_type: 'application/pdf',
          data: pdfBase64,
        },
      ],
      credentials: CREDS,
    }).action();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://www.googleapis.com/gmail/v1/users/me/messages/send'
    );
    expect(init.method).toBe('POST');

    const mime = decodeRawFromRequest(init);
    expect(mime).toContain('Content-Type: multipart/mixed; boundary=');
    expect(mime).toContain('Content-Type: application/pdf; name="invoice.pdf"');
    expect(mime).toContain(
      'Content-Disposition: attachment; filename="invoice.pdf"'
    );
    expect(mime).toContain('Content-Transfer-Encoding: base64');
    expect(mime).toContain(pdfBase64);
    expect(mime).toContain('See attached invoice.');

    expect(result.success).toBe(true);
    expect((result.data as any).message_id).toBe('sent-1');
  });
});

describe('GmailBubble RFC 2822 threading', () => {
  it('sets bracketed In-Reply-To/References from explicit in_reply_to without extra API calls', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: 'sent-2', threadId: 'thread-55' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'send_email',
      to: ['joran@example.com'],
      subject: 'Re: Follow-up',
      body_text: 'Following up.',
      thread_id: 'thread-55',
      in_reply_to: 'orig-id@mail.gmail.com', // no brackets on purpose
      credentials: CREDS,
    }).action();

    // Explicit in_reply_to → no thread lookup, only the send call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    const requestBody = JSON.parse(init.body as string);
    expect(requestBody.threadId).toBe('thread-55');

    const mime = decodeRawFromRequest(init);
    expect(mime).toContain('In-Reply-To: <orig-id@mail.gmail.com>');
    expect(mime).toContain('References: <orig-id@mail.gmail.com>');
    // The Gmail thread id must never appear as a threading header value
    expect(mime).not.toContain('In-Reply-To: thread-55');
    expect(mime).not.toContain('References: thread-55');

    expect(result.success).toBe(true);
  });

  it('auto-resolves In-Reply-To/References from the thread when only thread_id is given', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/threads/thread-88')) {
        return jsonResponse({
          id: 'thread-88',
          messages: [
            {
              id: 'msg-a',
              payload: {
                headers: [
                  { name: 'Message-ID', value: '<root@mail.gmail.com>' },
                ],
              },
            },
            {
              id: 'msg-b',
              payload: {
                headers: [
                  { name: 'Message-ID', value: '<latest@mail.gmail.com>' },
                  { name: 'References', value: '<root@mail.gmail.com>' },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ id: 'sent-3', threadId: 'thread-88' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'send_email',
      to: ['joran@example.com'],
      subject: 'Re: Follow-up',
      body_text: 'Following up again.',
      thread_id: 'thread-88',
      credentials: CREDS,
    }).action();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(lookupUrl).toContain('/threads/thread-88?format=metadata');
    expect(lookupUrl).toContain('metadataHeaders=Message-ID');
    expect(lookupUrl).toContain('metadataHeaders=References');

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(sendUrl).toContain('/messages/send');

    const mime = decodeRawFromRequest(sendInit);
    // In-Reply-To = last message's Message-ID; References = its References + it
    expect(mime).toContain('In-Reply-To: <latest@mail.gmail.com>');
    expect(mime).toContain(
      'References: <root@mail.gmail.com> <latest@mail.gmail.com>'
    );

    expect(result.success).toBe(true);
  });

  it('still sends with threadId when the thread lookup fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/threads/')) {
        return new Response('boom', { status: 500 });
      }
      return jsonResponse({ id: 'sent-4', threadId: 'thread-99' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'send_email',
      to: ['joran@example.com'],
      subject: 'Re: Follow-up',
      body_text: 'Still sends.',
      thread_id: 'thread-99',
      credentials: CREDS,
    }).action();

    expect(result.success).toBe(true);
    const [, sendInit] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    const requestBody = JSON.parse(sendInit.body as string);
    expect(requestBody.threadId).toBe('thread-99');
    const mime = decodeRawFromRequest(sendInit);
    expect(mime).not.toContain('In-Reply-To:');
  });
});

describe('GmailBubble search_emails pagination', () => {
  it('sends pageToken and returns next_page_token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        messages: [],
        nextPageToken: 'token-page-3',
        resultSizeEstimate: 250,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GmailBubble({
      operation: 'search_emails',
      query: 'from:customer@example.com',
      page_token: 'token-page-2',
      credentials: CREDS,
    }).action();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/users/me/messages?');
    expect(url).toContain('pageToken=token-page-2');

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.next_page_token).toBe('token-page-3');
    expect(data.result_size_estimate).toBe(250);
  });
});
