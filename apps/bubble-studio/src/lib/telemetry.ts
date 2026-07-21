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
