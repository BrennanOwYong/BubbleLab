#!/usr/bin/env node
/**
 * S3 — capability -> owning-bubble discovery (BACKLOG S3).
 *
 * Root cause: capability->bubble resolution was exact-registry-name-only at
 * every surface the live build path touches; a capability living inside an
 * owning bubble under a different product name ("Google Doc" inside
 * `google-drive`) dead-ended (bare 404, alias unresolved, no registry-wide
 * search; the sidecar's only catalog is a 9-bubble excerpt of a 60+ registry).
 *
 * Fix under test: GetBubbleDetailsTool miss path returns alias resolution +
 * owning-bubble suggestions; GET /bubble-flow/bubble-search ranks the whole
 * registry; both record `bubble_discovery.*` server telemetry events.
 *
 * Stage-1 assertions (deterministic, no LLM) on logged HTTP bodies +
 * telemetry events — the S3 brief's stage-2/3 build-from-prompt + run-event
 * assertions are LLM-driven and live-credential-bound; they belong to the
 * independent verification pass (S3.md "Event-based acceptance test").
 *
 * Verified-by:
 *   node scripts/event-test/run.mjs scripts/event-test/tests/s3_capability_discovery.test.mjs
 */
import { createHarness } from '../harness.mjs';

const t = await createHarness({
  name: 's3_capability_discovery',
  backlogId: 'S3',
});

// --- 1. details miss names the owning bubble (no dead end) ------------------
t.section('bubble-details miss: owning-bubble suggestions');
const miss = await t.api('/bubble-flow/bubble-details/google-docs');
t.assert('google-docs miss responds 404', miss.status === 404, `HTTP ${miss.status}`);
const suggestions = miss.body?.suggestions ?? [];
t.assert(
  'first suggestion is google-drive (the owning bubble)',
  suggestions[0]?.name === 'google-drive',
  JSON.stringify(suggestions.map((s) => s.name))
);
t.assert(
  'miss error text names google-drive',
  /google-drive/.test(miss.body?.error ?? ''),
  String(miss.body?.error).slice(0, 300)
);
t.assert(
  'suggestion carries the doc operations',
  (suggestions[0]?.matchedOperations ?? []).some((op) =>
    /update_doc|upload_file|get_doc|copy_doc/.test(op)
  ),
  JSON.stringify(suggestions[0]?.matchedOperations)
);

// --- 2. declared alias resolves ---------------------------------------------
t.section('bubble-details alias resolution');
const alias = await t.api('/bubble-flow/bubble-details/gdrive');
t.assert('gdrive responds 200', alias.status === 200, `HTTP ${alias.status}`);
t.assert(
  "alias resolves to name 'google-drive'",
  alias.body?.name === 'google-drive',
  `name=${alias.body?.name}`
);

// --- 3. registry-wide capability search --------------------------------------
t.section('bubble-search: capability ranking');
const docSearch = await t.api('/bubble-flow/bubble-search?q=google%20doc');
t.assert('search responds 200', docSearch.status === 200, `HTTP ${docSearch.status}`);
t.assert(
  "top result for 'google doc' is google-drive",
  docSearch.body?.items?.[0]?.name === 'google-drive',
  JSON.stringify((docSearch.body?.items ?? []).map((i) => i.name))
);
t.assert(
  'top result matchedOperations include update_doc or upload_file',
  (docSearch.body?.items?.[0]?.matchedOperations ?? []).some((op) =>
    /update_doc|upload_file/.test(op)
  ),
  JSON.stringify(docSearch.body?.items?.[0]?.matchedOperations)
);

// The index spans the registry, not the 9-bubble prompt excerpt: discord is
// absent from BUBBLELAB_SDK_DISTILLED.md but registered in bubble-core.
const discordSearch = await t.api('/bubble-flow/bubble-search?q=discord%20message');
t.assert(
  "off-excerpt capability 'discord message' resolves to discord",
  discordSearch.body?.items?.[0]?.name === 'discord',
  JSON.stringify((discordSearch.body?.items ?? []).map((i) => i.name))
);
t.assert(
  'search reports a registry-wide index (60+ bubbles)',
  Number(docSearch.body?.registrySize) >= 60,
  `registrySize=${docSearch.body?.registrySize}`
);

// --- 4. Pillar 2: discovery emits queryable server telemetry events ---------
t.section('telemetry: bubble_discovery events recorded');
const telemetry = await t.api(
  '/telemetry?type=bubble_discovery.search,bubble_discovery.details_miss&limit=50'
);
const events = telemetry.body?.events ?? [];
t.assert(
  'a bubble_discovery.search event was recorded for the query',
  events.some(
    (e) =>
      e.event?.event === 'bubble_discovery.search' &&
      e.event?.query === 'google doc'
  ),
  `events=${events.map((e) => e.event?.event).join(',')}`
);
t.assert(
  'a bubble_discovery.details_miss event was recorded for google-docs',
  events.some(
    (e) =>
      e.event?.event === 'bubble_discovery.details_miss' &&
      e.event?.bubbleName === 'google-docs'
  ),
  `events=${events.map((e) => e.event?.event).join(',')}`
);

await t.finish();
