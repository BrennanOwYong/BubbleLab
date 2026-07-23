import { describe, it, expect, vi, afterEach } from 'vitest';
import { CredentialType } from '@bubblelab/shared-schemas';
import { HttpBubble } from './http.js';

const okJson = () =>
  new Response('{"ok":true}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const mockFetch = () => {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => okJson()
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const calledHeaders = (fetchMock: ReturnType<typeof mockFetch>) =>
  new Headers(fetchMock.mock.calls[0][1]?.headers);

const calledUrl = (fetchMock: ReturnType<typeof mockFetch>) =>
  String(fetchMock.mock.calls[0][0]);

describe('HttpBubble auth handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('basic auth (RFC 7617)', () => {
    it('base64-encodes a user:pass credential', async () => {
      const fetchMock = mockFetch();
      const result = await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'basic',
        credentials: {
          [CredentialType.CUSTOM_AUTH_KEY]: 'user@example.com:api-token',
        },
      }).action();

      expect(result.success).toBe(true);
      expect(calledHeaders(fetchMock).get('Authorization')).toBe(
        `Basic ${Buffer.from('user@example.com:api-token').toString('base64')}`
      );
    });

    it('encodes a colon-less credential as base64(key:) — key-only vendor convention', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'basic',
        credentials: { [CredentialType.CUSTOM_AUTH_KEY]: 'sk_live_abc123' },
      }).action();

      expect(calledHeaders(fetchMock).get('Authorization')).toBe(
        `Basic ${Buffer.from('sk_live_abc123:').toString('base64')}`
      );
    });

    it('matches the RFC 7617 reference vector (Aladdin:open sesame)', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'basic',
        credentials: {
          [CredentialType.CUSTOM_AUTH_KEY]: 'Aladdin:open sesame',
        },
      }).action();

      expect(calledHeaders(fetchMock).get('Authorization')).toBe(
        'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='
      );
    });
  });

  describe('query-param auth', () => {
    it('appends the credential under the default "key" parameter', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'query-param',
        credentials: { [CredentialType.CUSTOM_AUTH_KEY]: 'secret-123' },
      }).action();

      expect(calledUrl(fetchMock)).toBe(
        'https://api.example.com/v1/thing?key=secret-123'
      );
      expect(calledHeaders(fetchMock).get('Authorization')).toBeNull();
    });

    it('honors a custom parameter name and preserves the existing query string', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing?limit=5',
        authType: 'query-param',
        authQueryParam: 'apikey',
        credentials: { [CredentialType.CUSTOM_AUTH_KEY]: 'secret-123' },
      }).action();

      expect(calledUrl(fetchMock)).toBe(
        'https://api.example.com/v1/thing?limit=5&apikey=secret-123'
      );
    });

    it('leaves the URL untouched when no credential is provided', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'query-param',
      }).action();

      expect(calledUrl(fetchMock)).toBe('https://api.example.com/v1/thing');
    });
  });

  describe('unchanged auth modes', () => {
    it('bearer auth still sends the raw token', async () => {
      const fetchMock = mockFetch();
      await new HttpBubble({
        url: 'https://api.example.com/v1/thing',
        authType: 'bearer',
        credentials: { [CredentialType.CUSTOM_AUTH_KEY]: 'tok-1' },
      }).action();

      expect(calledHeaders(fetchMock).get('Authorization')).toBe(
        'Bearer tok-1'
      );
    });
  });
});
