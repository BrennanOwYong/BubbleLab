/**
 * Dev-smoke preload: stubs the two OUTBOUND Google endpoints the API probes so
 * a live browser smoke test can exercise the identity backfill and suite scope
 * check with seeded fake tokens (no real Google account is reachable from this
 * environment). Load with `bun --preload`. Never used in production.
 *
 * Stubbed endpoints (shapes per the official docs cited in oauth-service.ts):
 * - GET https://openidconnect.googleapis.com/v1/userinfo   -> { email, ... }
 * - GET https://oauth2.googleapis.com/tokeninfo            -> { scope, ... }
 */
const originalFetch = globalThis.fetch;

const TOKEN_EMAILS: Record<string, string> = {
  'fake-gmail-token': 'gmail-user@example.com',
  'fake-drive-token': 'drive-user@example.com',
};

const DRIVE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
].join(' ');

const GMAIL_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

const TOKEN_SCOPES: Record<string, string> = {
  'fake-gmail-token': GMAIL_SCOPES,
  'fake-drive-token': DRIVE_SCOPES,
};

function bearerToken(init?: RequestInit): string {
  const headers = init?.headers;
  let auth = '';
  if (headers instanceof Headers) {
    auth = headers.get('Authorization') ?? '';
  } else if (Array.isArray(headers)) {
    auth = headers.find(([name]) => name === 'Authorization')?.[1] ?? '';
  } else if (headers) {
    auth = (headers as Record<string, string>)['Authorization'] ?? '';
  }
  return auth.replace('Bearer ', '');
}

const stub = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
    const email = TOKEN_EMAILS[bearerToken(init)];
    console.log(`[google-stub] userinfo probe -> ${email ?? '401'}`);
    if (!email) {
      return new Response('{"error":"invalid_token"}', { status: 401 });
    }
    return Response.json({ sub: 'stub-sub', email, email_verified: true });
  }
  if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    const token = new URL(url).searchParams.get('access_token') ?? '';
    const scope = TOKEN_SCOPES[token];
    console.log(`[google-stub] tokeninfo probe -> ${scope ? 'scopes' : '400'}`);
    if (!scope) {
      return new Response('{"error":"invalid_token"}', { status: 400 });
    }
    return Response.json({ scope, expires_in: 3599 });
  }
  return originalFetch(input, init);
};

globalThis.fetch = stub as typeof fetch;
console.log('[google-stub] outbound Google userinfo/tokeninfo stubbed');
