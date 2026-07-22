# Site-wide telemetry

## Where events go

Two sinks, both fed by every event:

1. **Structured console sink** — one line per event, tag `[TELEMETRY]` followed by a JSON payload with `event`, `ts`, and event-specific fields. Studio events land in the browser console; API events land in server stdout. Works with no configuration; grep `[TELEMETRY]` in logs or read them from Playwright's console feed. (The older `[bl:telemetry]` prefix from the setup/scope feature set still exists and is unchanged.)
2. **PostHog** — studio events route through the existing client in `apps/bubble-studio/src/services/analytics.ts` (needs `VITE_POSTHOG_API_KEY`, on unless `VITE_ANALYTICS_ENABLED=false`); API events route through `apps/bubblelab-api/src/services/posthog.ts` (needs `POSTHOG_ENABLED=true` + `POSTHOG_API_KEY`). Without keys both no-op, nothing crashes.

## How to view

- Local/dev: browser devtools console (studio) and API stdout, filter `[TELEMETRY]`.
- PostHog (when configured): events appear under the same names as the catalog below; API requests as `api_request` / `api_error`.

## Wiring (all centralized)

| Piece                                                                                          | File                                                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Typed event catalog + `track()` + fetch interceptor + click delegation + global error handlers | `apps/bubble-studio/src/lib/telemetry.ts`                                                         |
| Root provider (router page views, installer calls) + React error boundary                      | `apps/bubble-studio/src/providers/TelemetryProvider.tsx` (mounted in `src/main.tsx`)              |
| API request/error middleware                                                                   | `apps/bubblelab-api/src/middleware/telemetry.ts` (registered `app.use('*', …)` in `src/index.ts`) |

Click tracking is delegated: add `data-track="some.name"` to any element and clicks emit `ui.click` with no further wiring.

## Event catalog (studio)

Defined as the `TelemetryEventCatalog` type in `apps/bubble-studio/src/lib/telemetry.ts`; `track()` is compile-time checked against it.

- `page.view` `{path, fromPath}` — automatic, router subscription
- `api.call` `{method, path, status, durationMs, ok}` / `api.call_failed` `{method, path, durationMs, error}` — automatic, fetch interceptor, API-base-URL calls only
- `ui.click` `{track, text, path}` — automatic for `data-track` elements
- `app.error`, `app.unhandled_rejection`, `app.error_boundary` — automatic global handlers
- `flow.create_started|succeeded|failed` — `useCreateBubbleFlow`
- `flow.generate_started|succeeded|failed` — `useFlowGeneration`
- `flow.save_started|succeeded|failed` — `useUpdateBubbleFlow`
- `flow.run_started|succeeded|failed` — `useRunExecution` (succeeded = SSE `stream_complete`)
- `credential.add_started|succeeded|failed`, `credential.update_*`, `credential.delete_*` — `useCredentials`
- `credential.connect_started` `{provider}` — `credentialsApi.initiateOAuth`
- `credential.bind` — declared in the catalog; the binding UI files are owned by another branch, so emit it from there when integrating (`track('credential.bind', {credentialType, credentialId})`)
- `tool.add_started|succeeded|failed` — `AddToolPage`

## Event catalog (API)

- `api.request` `{method, path, status, durationMs, ok, userId}` — every route, every request
- `api.error` `{method, path, durationMs, userId, error}` — thrown errors, then rethrown to the existing error handler

Streaming (SSE) routes report `durationMs` to response creation, not stream close.
