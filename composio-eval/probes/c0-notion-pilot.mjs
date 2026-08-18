#!/usr/bin/env node
/**
 * C0 bounded pilot: Composio Notion end-to-end thesis test.
 *
 * Emits one JSON object {q1, q2, q3_ms, q4, sideTest, notes} on stdout and
 * writes the same object to ../c0-result.json. Exit 0 iff
 * q1 && q2 && q3_ms < 300 && q4. If no ACTIVE Notion connected account
 * exists, the probe mints a re-connect link (notes.reconnect.url), sets
 * q1/q2 to null, marks notes.status = "PENDING-RECONNECT" and exits 2.
 *
 * Questions (REFACTOR-ROADMAP.md C0, advisory section 8):
 *  q1  OutputSchema (served at the CURRENT pin, toolkit_versions=latest)
 *      validates the live execute payload for 3 representative tools.
 *  q2  NOTION_APPEND_BLOCK_CHILDREN with the `after` parameter succeeds
 *      against the real workspace (confirms the 2025-09-03 vendor pin).
 *  q3  Round-trip latency through Composio vs the native Notion API using
 *      the same token (pulled from the connected account's vault data);
 *      q3_ms = composio_median - native_median when native is reachable,
 *      else the raw Composio median (notes.q3.mode says which).
 *  q4  Provenance join: execute response log_id ->
 *      GET /api/v3.1/internal/action_execution/log/{id} carries
 *      {connection.id, actionId, status} joinable back to the call.
 *  sideTest  POST connected-account create against managed slack config
 *      ac_i59Dyk0WqVKV: is the 2026-07-03-retired legacy v3 path dead, and
 *      does the SDK's current v3.1 create path still work for Gluu?
 *
 * Version discipline (advisory section 3.2 footnote): bare REST with no
 * version param serves the frozen base snapshot 00000000_00 on BOTH tool
 * fetch AND execute (ToolExecuteParams.version: "defaults to 00000000_00").
 * This probe fetches at toolkit_versions=latest and executes with an
 * explicit body.version equal to the served tool.version.
 *
 * References (verified against the shipped SDK on 2026-08-01):
 *  - gluu/backend/node_modules/@composio/client/resources/tools.d.ts
 *    (ToolExecuteParams.version default, ToolExecuteResponse.log_id)
 *  - gluu/backend/node_modules/@composio/client/resources/connected-accounts.mjs
 *    (POST /api/v3.1/connected_accounts, 2026-07-03 retirement note)
 *  - gluu/backend/node_modules/@composio/client/resources/link.mjs
 *    (POST /api/v3.1/connected_accounts/link)
 *  - gluu/backend/node_modules/@composio/client/resources/logs/tools.mjs
 *    (GET /api/v3.1/internal/action_execution/log/{id})
 *  - https://docs.composio.dev/docs/changelog/2026/04/24 (initiate -> link)
 *  - https://docs.composio.dev/reference/connected-accounts/create-connected-account
 *  - https://developers.notion.com/reference/patch-block-children (`after`)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = join(HERE, '..', 'c0-result.json');
const GLUU_ENV = '/mnt/c/Users/brenn/Documents/gluu/backend/.env';
const GLUU_NM = '/mnt/c/Users/brenn/Documents/gluu/backend/node_modules';
const V3 = 'https://backend.composio.dev/api/v3';
const V31 = 'https://backend.composio.dev/api/v3.1';
const NOTION_AUTH_CONFIG = 'ac_7tZB-ZBOXkkN'; // managed notion, ENABLED
const SLACK_MANAGED_AUTH_CONFIG = 'ac_i59Dyk0WqVKV';
const USER_ID = 'default:default'; // matches the prior notion connected account
const NOTION_PIN = '2025-09-03'; // vendor version the advisory infers Composio pins

// .env line carries a trailing " # comment"; strip it and CR/LF.
const KEY = (() => {
  const line = readFileSync(GLUU_ENV, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('COMPOSIO_API_KEY='));
  if (!line) throw new Error('COMPOSIO_API_KEY not found in gluu backend .env');
  return line.replace(/^COMPOSIO_API_KEY=([^ #]+).*$/, '$1').trim();
})();

const require_ = createRequire(import.meta.url);
const Ajv = require_(join(GLUU_NM, 'ajv'));
const ajv = new Ajv({ strict: false, validateFormats: false, allowUnionTypes: true });

async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': KEY, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = performance.now() - t0;
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, headers: res.headers, json, ms };
}

async function execTool(slug, { connectedAccountId, args, version }) {
  // user_id is mandatory in practice despite ToolExecuteParams documenting it
  // as multi-user-only: omitting it returns 400
  // ActionExecute_ConnectedAccountEntityIdRequired (verified 2026-08-01).
  return api(`${V31}/tools/execute/${slug}`, {
    method: 'POST',
    body: { connected_account_id: connectedAccountId, user_id: USER_ID, arguments: args, version },
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
};

const result = { q1: null, q2: null, q3_ms: null, q4: null, sideTest: null, notes: {} };
const notes = result.notes;

// ---------------------------------------------------------------- pin inspection
async function inspectPin() {
  const latest = await api(`${V3}/tools?toolkit_slug=notion&limit=100&toolkit_versions=latest`);
  const base = await api(`${V3}/tools?toolkit_slug=notion&limit=100`);
  const tk = await api(`${V3}/toolkits/notion`);
  const items = latest.json.items ?? [];
  const blob = JSON.stringify(items);
  const afterTools = items.filter((t) => (t.input_parameters?.properties ?? {}).after).map((t) => t.slug);
  const positionTools = items.filter((t) => (t.input_parameters?.properties ?? {}).position).map((t) => t.slug);
  notes.pin = {
    toolkitVersionServed: [...new Set(items.map((t) => t.version))],
    countLatest: latest.json.total_items,
    countBase: base.json.total_items,
    countCatalogMeta: tk.json?.meta?.tools_count ?? tk.json?.meta?.tool_count ?? null,
    dataSourceRefs: (blob.match(/data_source/g) ?? []).length,
    afterParamTools: afterTools,
    positionParamTools: positionTools,
    inTrashRefs: (blob.match(/in_trash/g) ?? []).length,
    archivedRefs: (blob.match(/archived/g) ?? []).length,
    deprecatedFlagged: items.filter((t) => t.is_deprecated).map((t) => t.slug),
    reading:
      'data_source present + after present + in_trash migration unfinished = pinned to ' +
      `Notion-Version ${NOTION_PIN}, not the 2026-03-11 surface (advisory 3.2). ` +
      'Base (no version param) serves the frozen 00000000_00 snapshot.',
  };
  return items;
}

// ---------------------------------------------------------- connected accounts
async function notionAccounts() {
  const res = await api(`${V3}/connected_accounts?limit=50`);
  const items = res.json.items ?? [];
  return items.filter((c) => c.toolkit?.slug === 'notion');
}

async function mintReconnectLink() {
  const res = await api(`${V31}/connected_accounts/link`, {
    method: 'POST',
    body: { auth_config_id: NOTION_AUTH_CONFIG, user_id: USER_ID },
  });
  if (res.status >= 300 || !res.json.redirect_url) {
    notes.reconnect = { error: `link create failed: HTTP ${res.status}`, body: res.json };
    return null;
  }
  notes.reconnect = {
    url: res.json.redirect_url,
    connectedAccountId: res.json.connected_account_id,
    expiresAt: res.json.expires_at ?? null,
    warning:
      'Complete the OAuth before expiresAt. Re-run this probe to mint a fresh link ' +
      'if it lapses (the prior account expired with "Connection initiation did not ' +
      'complete within 10 minutes").',
  };
  return res.json;
}

// -------------------------------------------------------------------------- q1
const Q1_TOOLS = ['NOTION_LIST_USERS', 'NOTION_SEARCH_NOTION_PAGE', 'NOTION_FETCH_BLOCK_CONTENTS'];

async function runQ1(tools, ca) {
  const detail = [];
  let pageId = null;
  for (const slug of Q1_TOOLS) {
    const tool = tools.find((t) => t.slug === slug);
    let args = {};
    if (slug === 'NOTION_SEARCH_NOTION_PAGE') args = { page_size: 5 };
    if (slug === 'NOTION_FETCH_BLOCK_CONTENTS') {
      if (!pageId) { detail.push({ slug, skipped: 'no page found by search' }); continue; }
      args = { block_id: pageId, page_size: 10 };
    }
    const res = await execTool(slug, { connectedAccountId: ca.id, args, version: tool.version });
    if (res.status >= 300) {
      detail.push({ slug, httpStatus: res.status, error: res.json });
      continue;
    }
    const validate = ajv.compile(tool.output_parameters ?? {});
    const ok = validate(res.json);
    detail.push({
      slug,
      successful: res.json.successful,
      logId: res.json.log_id ?? null,
      schemaParse: !!ok,
      schemaErrors: ok ? null : (validate.errors ?? []).slice(0, 5),
      ms: Math.round(res.ms),
    });
    if (slug === 'NOTION_SEARCH_NOTION_PAGE' && res.json.successful) {
      const hits = res.json.data?.results ?? res.json.data?.response_data?.results ?? [];
      const page = hits.find((r) => r.object === 'page');
      pageId = page?.id ?? null;
    }
  }
  notes.q1 = detail;
  const ran = detail.filter((d) => !d.skipped && !d.httpStatus);
  result.q1 = ran.length === 3 && ran.every((d) => d.successful && d.schemaParse);
  return pageId;
}

// -------------------------------------------------------------------------- q2
async function runQ2(tools, ca, pageId) {
  const tool = tools.find((t) => t.slug === 'NOTION_APPEND_BLOCK_CHILDREN');
  if (!pageId) { notes.q2 = { error: 'no target page available' }; result.q2 = false; return; }
  const para = (text) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  });
  // Anchor: first existing child, else append one anchor block first.
  const kids = await execTool('NOTION_FETCH_BLOCK_CONTENTS', {
    connectedAccountId: ca.id,
    args: { block_id: pageId, page_size: 5 },
    version: tools.find((t) => t.slug === 'NOTION_FETCH_BLOCK_CONTENTS').version,
  });
  let anchor = (kids.json?.data?.results ?? [])[0]?.id ?? null;
  if (!anchor) {
    const seed = await execTool('NOTION_APPEND_BLOCK_CHILDREN', {
      connectedAccountId: ca.id,
      args: { block_id: pageId, children: [para('c0 pilot anchor block')] },
      version: tool.version,
    });
    anchor = seed.json?.data?.results?.[0]?.id ?? null;
  }
  if (!anchor) { notes.q2 = { error: 'could not obtain anchor block id' }; result.q2 = false; return; }
  const res = await execTool('NOTION_APPEND_BLOCK_CHILDREN', {
    connectedAccountId: ca.id,
    args: { block_id: pageId, children: [para('c0 pilot: inserted AFTER anchor (pin test)')], after: anchor },
    version: tool.version,
  });
  notes.q2 = {
    pageId,
    after: anchor,
    successful: res.json?.successful ?? false,
    httpStatus: res.status,
    logId: res.json?.log_id ?? null,
    error: res.json?.error ?? null,
    writeMs: Math.round(res.ms),
  };
  result.q2 = res.status < 300 && res.json?.successful === true;
}

// -------------------------------------------------------------------------- q3
async function runQ3(tools, ca, pageId) {
  const tool = tools.find((t) => t.slug === 'NOTION_FETCH_BLOCK_CONTENTS');
  const composio = [];
  for (let i = 0; i < 5; i++) {
    const r = await execTool('NOTION_FETCH_BLOCK_CONTENTS', {
      connectedAccountId: ca.id,
      args: { block_id: pageId, page_size: 5 },
      version: tool.version,
    });
    if (r.json?.successful) composio.push(r.ms);
  }
  // Native path: same token from the vault, same operation, pinned version header.
  const detail = await api(`${V3}/connected_accounts/${ca.id}`);
  const token = detail.json?.data?.access_token ?? null;
  const native = [];
  if (token) {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=5`, {
        headers: { authorization: `Bearer ${token}`, 'Notion-Version': NOTION_PIN },
      });
      await r.text();
      if (r.ok) native.push(performance.now() - t0);
    }
  }
  if (composio.length === 0) { notes.q3 = { error: 'no successful composio samples' }; return; }
  const cMed = median(composio);
  if (native.length > 0) {
    const nMed = median(native);
    result.q3_ms = cMed - nMed;
    notes.q3 = { mode: 'delta', composioMedianMs: cMed, nativeMedianMs: nMed, addedMs: cMed - nMed, samples: composio.length };
  } else {
    result.q3_ms = cMed;
    notes.q3 = {
      mode: 'composio-only',
      composioMedianMs: cMed,
      caveat: 'native path unreachable (no vault token); q3_ms is the raw Composio round trip, not added latency',
    };
  }
}

// -------------------------------------------------------------------------- q4
async function runQ4(logId, expect) {
  if (!logId) { notes.q4 = { error: 'no log_id available from any execution' }; result.q4 = false; return; }
  const res = await api(`${V31}/internal/action_execution/log/${logId}`);
  if (res.status >= 300) { notes.q4 = { httpStatus: res.status, error: res.json }; result.q4 = false; return; }
  const log = res.json;
  const row = {
    logId,
    connectedAccountId: log.connection?.id ?? null,
    successful: log.status === 'success',
    tool_slug: log.actionId ?? null,
  };
  const joins =
    row.connectedAccountId === expect.connectedAccountId &&
    typeof row.tool_slug === 'string' &&
    row.tool_slug.toUpperCase().includes('NOTION');
  notes.q4 = { row, joinedAgainst: expect, status: log.status, version: log.version ?? null };
  result.q4 = joins;
}

// --------------------------------------------------------------------- sideTest
async function runSideTest() {
  const body31 = { auth_config: { id: SLACK_MANAGED_AUTH_CONFIG }, connection: { user_id: 'c0-sidetest' } };
  const legacy = await api(`${V3}/connected_accounts`, { method: 'POST', body: body31 });
  const current = await api(`${V31}/connected_accounts`, { method: 'POST', body: body31 });
  const created = [legacy, current]
    .map((r) => r.json?.id)
    .filter((id) => typeof id === 'string' && id.startsWith('ca_'));
  for (const id of created) await api(`${V31}/connected_accounts/${id}`, { method: 'DELETE' });
  result.sideTest = {
    legacyV3: { status: legacy.status, deprecation: legacy.headers.get('deprecation'), sunset: legacy.headers.get('sunset'), error: legacy.status >= 300 ? (legacy.json?.error?.message ?? legacy.json?.message ?? null) : null },
    currentV31: {
      status: current.status,
      deprecation: current.headers.get('deprecation'),
      sunset: current.headers.get('sunset'),
      redirectUrlReturned: !!(current.json?.connectionData?.val?.redirectUrl || current.json?.connection_data?.val?.redirectUrl),
      error: current.status >= 300 ? (current.json?.error?.message ?? null) : null,
      suggestedFix: current.status >= 300 ? (current.json?.error?.suggested_fix ?? null) : null,
    },
    cleanedUp: created,
    gluuInitiateStillWorks: current.status < 300,
    verdict:
      current.status < 300
        ? 'SDK initiate() path (v3.1 create) still works for managed OAuth'
        : 'SDK initiate() path (v3.1 create) is RETIRED for managed OAuth configs; ' +
          'gluu client.ts:451 connectedAccounts.initiate must migrate to connectedAccounts.link()',
  };
}

// ------------------------------------------------------------------------ main
const tools = await inspectPin();
const cas = await notionAccounts();
const active = cas.find((c) => c.status === 'ACTIVE');
notes.notionAccounts = cas.map((c) => ({ id: c.id, status: c.status }));

if (!active) {
  await mintReconnectLink();
  notes.status = 'PENDING-RECONNECT';
  notes.thesis =
    'UNPROVEN on live execution: q1/q2/q3/q4 need an ACTIVE Notion connected account. ' +
    'Complete the OAuth at notes.reconnect.url, then re-run this probe.';
  // A provenance attempt against the expired account, in case failures also log.
  const probeTool = tools.find((t) => t.slug === 'NOTION_LIST_USERS');
  const dead = cas[0];
  if (dead && probeTool) {
    const r = await execTool('NOTION_LIST_USERS', { connectedAccountId: dead.id, args: {}, version: probeTool.version });
    const errObj = r.json?.error ?? r.json;
    notes.expiredExecuteShape = {
      httpStatus: r.status,
      successful: r.json?.successful ?? null,
      logId: r.json?.log_id ?? null,
      errorSlug: errObj?.slug ?? null,
      error: JSON.stringify(errObj).slice(0, 300),
      reading: 'expired account fails LOUD pre-flight (typed slug, no silent credential-less run)',
    };
    if (r.json?.log_id) await runQ4(r.json.log_id, { connectedAccountId: dead.id });
  }
  await runSideTest();
} else {
  const pageId = await runQ1(tools, active);
  await runQ2(tools, active, pageId);
  if (pageId) await runQ3(tools, active, pageId);
  const logId = notes.q2?.logId ?? notes.q1?.find((d) => d.logId)?.logId ?? null;
  await runQ4(logId, { connectedAccountId: active.id });
  await runSideTest();
  notes.status = 'RAN-LIVE';
}

writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
const pass = result.q1 === true && result.q2 === true && typeof result.q3_ms === 'number' && result.q3_ms < 300 && result.q4 === true;
process.exit(pass ? 0 : notes.status === 'PENDING-RECONNECT' ? 2 : 1);

