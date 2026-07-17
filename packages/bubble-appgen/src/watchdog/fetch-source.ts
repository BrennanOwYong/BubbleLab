/**
 * Conditional source fetching for the tool source-of-truth watchdog.
 *
 * Change detection runs cheapest-mechanism-first, per RFC 9110 conditional
 * requests, with content hashing as the universal fallback:
 *
 * 1. `If-None-Match: <etag>` when the last snapshot carried an ETag —
 *    a 304 answers "unchanged" without transferring the body.
 * 2. `If-Modified-Since: <last-modified>` when only Last-Modified exists.
 * 3. Full GET + sha256 of the body otherwise, compared to the snapshot hash.
 *    This also guards against servers whose validators are unstable.
 *
 * Live-probe results for the registered sources (2026-07-17):
 * - raw.githubusercontent.com (Stripe, Snowflake, AWS Smithy, Databricks
 *   Go SDK): strong content-derived ETag, honors If-None-Match -> 304.
 *   No Last-Modified.
 * - docs.kraken.com: weak ETag (W/"...") AND Last-Modified; honors both
 *   If-None-Match and If-Modified-Since -> 304.
 * - bigquery.googleapis.com discovery: NO response ETag/Last-Modified and
 *   HEAD answers 404 — must GET and hash the body; the document's own
 *   `revision` field is the vendor version signal.
 *
 * `file://` URLs are supported so tests and proof runs can drive the whole
 * pipeline against local fixtures without a network or a mock server.
 *
 * ## References
 * - https://www.rfc-editor.org/rfc/rfc9110#name-if-none-match
 * - https://www.rfc-editor.org/rfc/rfc9110#name-if-modified-since
 * - https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag
 * - https://developers.google.com/discovery/v1/reference/apis
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  SourceSnapshot,
  SpecSourceType,
  ToolSource,
} from '@bubblelab/shared-schemas';

export type FetchOutcome =
  | {
      status: 'not-modified';
      mechanism: 'etag-304' | 'last-modified-304';
      httpStatus: number;
    }
  | {
      status: 'fetched';
      mechanism: 'body-hash';
      httpStatus: number;
      body: string;
      etag: string | null;
      lastModified: string | null;
      sha256: string;
      bytes: number;
    }
  | { status: 'failed'; message: string };

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
    );
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) out[key] = sortKeysDeep(child);
    return out;
  }
  return value;
}

/**
 * Normalize a fetched body so identical CONTENT always hashes identically.
 * Google Discovery responses serialize object keys in a DIFFERENT order per
 * fetch (observed live 2026-07-17: two consecutive GETs of the BigQuery
 * discovery doc returned different bytes, identical content), so the body
 * is re-serialized with sorted keys before hashing/writing. Other source
 * types are byte-stable and pass through untouched.
 */
export function canonicalizeBody(specType: SpecSourceType, body: string): string {
  if (specType !== 'google-discovery') return body;
  try {
    return `${JSON.stringify(sortKeysDeep(JSON.parse(body)), null, 2)}\n`;
  } catch {
    return body;
  }
}

/**
 * Vendor-declared version inside the fetched document:
 * OpenAPI `info.version`, Google Discovery `revision`. Smithy models and
 * hand-transcribed references carry no usable version field.
 */
export function extractSpecVersion(
  specType: SpecSourceType,
  body: string
): string | null {
  try {
    if (specType === 'google-discovery') {
      const doc: unknown = JSON.parse(body);
      if (doc && typeof doc === 'object' && 'revision' in doc) {
        const revision = (doc as { revision?: unknown }).revision;
        return typeof revision === 'string' ? revision : null;
      }
      return null;
    }
    if (specType === 'openapi') {
      // Fixtures are YAML or JSON; a cheap line scan avoids a YAML parse of
      // multi-megabyte bodies (Stripe's spec3.json is ~8 MB JSON).
      const trimmed = body.trimStart();
      if (trimmed.startsWith('{')) {
        const doc: unknown = JSON.parse(body);
        if (doc && typeof doc === 'object' && 'info' in doc) {
          const info = (doc as { info?: { version?: unknown } }).info;
          return typeof info?.version === 'string' ? info.version : null;
        }
        return null;
      }
      const match = body.match(/^\s{2}version:\s*['"]?([^'"\n]+)['"]?\s*$/m);
      return match ? match[1].trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check one source against its snapshot. Sends the cheapest conditional
 * headers the server is known (from live probes recorded in the registry)
 * to honor; falls back to GET + hash.
 */
export async function fetchSource(
  source: ToolSource,
  specType: SpecSourceType
): Promise<FetchOutcome> {
  if (source.url.startsWith('file://')) {
    return fetchFileSource(source.url, specType);
  }
  const headers: Record<string, string> = {
    'User-Agent': 'bubblelab-tool-watchdog/1.0',
  };
  const snapshot = source.snapshot;
  if (snapshot?.etag && source.conditional.includes('etag')) {
    headers['If-None-Match'] = snapshot.etag;
  } else if (
    snapshot?.lastModified &&
    source.conditional.includes('last-modified')
  ) {
    headers['If-Modified-Since'] = snapshot.lastModified;
  }
  try {
    const response = await fetch(source.url, { headers, redirect: 'follow' });
    if (response.status === 304) {
      return {
        status: 'not-modified',
        mechanism: headers['If-None-Match']
          ? 'etag-304'
          : 'last-modified-304',
        httpStatus: 304,
      };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        message: `GET ${source.url} -> HTTP ${response.status}`,
      };
    }
    const body = canonicalizeBody(specType, await response.text());
    return {
      status: 'fetched',
      mechanism: 'body-hash',
      httpStatus: response.status,
      body,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  } catch (error) {
    return {
      status: 'failed',
      message: `GET ${source.url} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function fetchFileSource(url: string, specType: SpecSourceType): FetchOutcome {
  try {
    const body = canonicalizeBody(specType, readFileSync(fileURLToPath(url), 'utf8'));
    return {
      status: 'fetched',
      mechanism: 'body-hash',
      httpStatus: 200,
      body,
      etag: null,
      lastModified: null,
      sha256: sha256Hex(body),
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  } catch (error) {
    return {
      status: 'failed',
      message: `read ${url} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Build the snapshot a successful fetch produces. */
export function toSnapshot(
  outcome: Extract<FetchOutcome, { status: 'fetched' }>,
  specType: SpecSourceType,
  now: string
): SourceSnapshot {
  return {
    etag: outcome.etag,
    lastModified: outcome.lastModified,
    sha256: outcome.sha256,
    bytes: outcome.bytes,
    specVersion: extractSpecVersion(specType, outcome.body),
    fetchedAt: now,
  };
}
