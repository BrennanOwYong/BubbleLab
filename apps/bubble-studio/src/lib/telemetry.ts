/**
 * Structured UI telemetry (project principle: programmatic telemetry for testability).
 *
 * Every meaningful UI action/state-change ALSO emits a machine-readable console event so an
 * automated agent (Playwright/MCP) can assert on behavior deterministically instead of
 * parsing pixels. One stable prefix, one JSON payload per event.
 *
 * Event names in this feature:
 * - `setup.scope_requirements_discovered` — flow-level scope discovery reached the setup panel
 * - `connect.scopes_preselected`          — Connect UI pre-selected exactly the discovered scopes
 * - `connect.oauth_initiated`             — OAuth popup opened with the final requested scope list
 * - `setup.field_autopopulated`           — a setup input was pre-filled from a saved credential
 * - `setup.credential_autobound`          — a required credential slot was bound by default to a
 *                                           connected credential (reason: only_credential |
 *                                           default_of_many)
 * - `setup.add_another_opened`            — the add-another-account affordance opened the connect
 *                                           flow (source: setup_panel | bubble_node)
 * - `setup.credential_switched`           — the credential bound to one or more steps changed
 *                                           (source: setup_panel | bubble_node | connect_modal)
 * - `setup.suite_binding_proposed`        — a same-OAuth-provider credential of a sibling type
 *                                           was proposed for a slot no exact-type credential
 *                                           can fill (pending granted-scope verification)
 * - `setup.scope_check_passed`            — the proposed credential's granted scopes cover the
 *                                           steps' requirements; the suite binding was applied
 *                                           (source: probe | stored)
 * - `setup.scope_check_insufficient`      — granted scopes do NOT cover the requirements; the
 *                                           missing scopes drive incremental re-consent
 * - `setup.incremental_consent_started`   — the user launched incremental OAuth re-consent to
 *                                           ADD the missing scopes to the existing credential
 * - `setup.incremental_consent_completed` — the re-consent popup finished (success: boolean)
 * - `setup.suite_provenance_shown`        — a suite-binding provenance label rendered
 *                                           (surface: setup_panel — "Sheets via your Drive
 *                                           credential" | credentials_page — "Also grants:
 *                                           Google Sheets, ...")
 *
 * The API emits the same format server-side (src/utils/telemetry.ts):
 * - `setup.account_email_backfilled`      — a pre-existing Google credential's account email
 *                                           was probed (OIDC userinfo) and persisted
 */

import { analytics } from '../services/analytics';
import { API_BASE_URL } from '../env';

export const TELEMETRY_PREFIX = '[bl:telemetry]';

export interface TelemetryEvent {
  event: string;
  [key: string]: unknown;
}

/** Emit one structured telemetry event to the console. */
export function emitTelemetry(
  event: string,
  data: Record<string, unknown> = {}
): void {
  const payload: TelemetryEvent = { event, ...data };
  // console.info keeps these out of error monitoring while staying visible to
  // devtools and automated console readers.
  console.info(TELEMETRY_PREFIX, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Site-wide telemetry: typed event catalog + track() + centralized installers.
//
// Sinks:
// 1. Structured console sink: `[TELEMETRY] {json}` — always on, works without
//    PostHog configured, readable by devtools and automated console readers.
// 2. PostHog via the existing analytics service (services/analytics.ts) —
//    no-ops unless VITE_POSTHOG_API_KEY is set (off-by-default safe).
//
// The installers (fetch interceptor, click delegation, global error handlers)
// are wired ONCE at the app root by providers/TelemetryProvider.tsx.
// ---------------------------------------------------------------------------

export const TELEMETRY_TAG = '[TELEMETRY]';

/**
 * Typed event catalog: every site-wide event name and its payload shape.
 * Add new events here so callers get compile-time checked payloads.
 */
export type TelemetryEventCatalog = {
  // Navigation
  'page.view': { path: string; fromPath?: string };
  // Network (auto-captured by the fetch interceptor for API_BASE_URL calls)
  'api.call': {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    ok: boolean;
  };
  'api.call_failed': {
    method: string;
    path: string;
    durationMs: number;
    error: string;
  };
  // Delegated clicks (any element carrying a data-track attribute)
  'ui.click': { track: string; text?: string; path: string };
  // Global errors
  'app.error': {
    message: string;
    source?: string;
    lineno?: number;
    colno?: number;
    stack?: string;
  };
  'app.unhandled_rejection': { reason: string };
  'app.error_boundary': {
    message: string;
    stack?: string;
    componentStack?: string;
  };
  // Flow lifecycle
  'flow.create_started': { source?: string };
  'flow.create_succeeded': { flowId?: number };
  'flow.create_failed': { error: string };
  'flow.generate_started': { promptLength?: number };
  'flow.generate_succeeded': { flowId?: number; durationMs?: number };
  'flow.generate_failed': { error: string };
  'flow.save_started': { flowId?: number };
  'flow.save_succeeded': { flowId?: number };
  'flow.save_failed': { flowId?: number; error: string };
  'flow.run_started': { flowId?: number };
  'flow.run_succeeded': { flowId?: number };
  'flow.run_failed': { flowId?: number; error: string };
  // Credentials
  'credential.add_started': { credentialType?: string };
  'credential.add_succeeded': { credentialType?: string };
  'credential.add_failed': { credentialType?: string; error: string };
  'credential.update_succeeded': { credentialId?: number };
  'credential.update_failed': { credentialId?: number; error: string };
  'credential.delete_succeeded': { credentialId?: number };
  'credential.delete_failed': { credentialId?: number; error: string };
  'credential.connect_started': { provider?: string };
  'credential.bind': { credentialType?: string; credentialId?: number };
  // Add-a-Tool
  'tool.add_started': { toolName?: string };
  'tool.add_succeeded': { toolName?: string };
  'tool.add_failed': { toolName?: string; error: string };
};

export type TelemetryEventName = keyof TelemetryEventCatalog;

/**
 * Track one site-wide event: writes the structured [TELEMETRY] console line
 * and forwards to PostHog through the existing analytics client.
 */
export function track<E extends TelemetryEventName>(
  event: E,
  props: TelemetryEventCatalog[E] & Record<string, unknown>
): void {
  console.info(
    TELEMETRY_TAG,
    JSON.stringify({ event, ts: new Date().toISOString(), ...props })
  );
  analytics.track(event, props);
}

// --- Fetch interceptor ------------------------------------------------------

let fetchInterceptorInstalled = false;

/**
 * Wrap window.fetch so EVERY call to the API base URL emits an api.call /
 * api.call_failed event. Non-API URLs (PostHog ingestion, external hosts)
 * pass through untouched, which also prevents capture feedback loops.
 */
export function installFetchInterceptor(): void {
  if (fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!API_BASE_URL || !url.startsWith(API_BASE_URL)) {
      return originalFetch(input, init);
    }

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      // keep full url when parsing fails (relative URLs)
    }

    const start = performance.now();
    try {
      const response = await originalFetch(input, init);
      track('api.call', {
        method,
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - start),
        ok: response.ok,
      });
      return response;
    } catch (error) {
      track('api.call_failed', {
        method,
        path,
        durationMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

// --- Delegated click tracking ------------------------------------------------

let clickTrackingInstalled = false;

/**
 * One document-level listener; any element (or ancestor) with a data-track
 * attribute emits ui.click. Feature components opt in by adding the attribute,
 * no per-component wiring.
 */
export function installClickTracking(): void {
  if (clickTrackingInstalled) return;
  clickTrackingInstalled = true;

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const el = target.closest('[data-track]');
      if (!el) return;
      const name = el.getAttribute('data-track');
      if (!name) return;
      track('ui.click', {
        track: name,
        text: (el.textContent ?? '').trim().slice(0, 80) || undefined,
        path: window.location.pathname,
      });
    },
    { capture: true }
  );
}

// --- Global error handlers ----------------------------------------------------

let errorHandlersInstalled = false;

/** window 'error' + 'unhandledrejection' → app.error / app.unhandled_rejection. */
export function installGlobalErrorHandlers(): void {
  if (errorHandlersInstalled) return;
  errorHandlersInstalled = true;

  window.addEventListener('error', (e) => {
    track('app.error', {
      message: e.message,
      source: e.filename || undefined,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    track('app.unhandled_rejection', {
      reason: e.reason instanceof Error ? e.reason.message : String(e.reason),
    });
  });
}
