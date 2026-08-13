/**
 * U2 — pure derivation of the flow's headline result.
 *
 * ONE exported derivation shared by the canvas ResultNode, the conversation
 * ResultRevealWidget, and the acceptance test, so the surfaces can never
 * diverge. No store access, no fetching, no React: inputs in, value out.
 *
 * Persisted model (bubble_flows.metadata.primaryOutput, written by the
 * builder agent's set_primary_output tool via
 * PATCH /bubble-flow/:id/primary-output):
 *   { kind: 'artefact'|'process'|'both', label, artefactKey?, outcomeKeys? }
 * Invariant (enforced by the builder SOP): every registered key is a
 * top-level property of the handle() return object, so finalResult[key] is
 * always defined on a successful run.
 *
 * Read path for the value:
 * 1. The retained execution store events: the last `execution_complete`
 *    event's additionalData carries { success, finalResult } (bubble-core
 *    StreamingBubbleLogger.logExecutionComplete).
 * 2. Fallback (fresh page, no retained run): the newest persisted execution
 *    row's `result` (GET /bubble-flow/:id/executions?limit=1 → items[0]).
 *    That row stores { data: <handle() return>, ...summary }
 *    (bubble-flow-execution.ts), so the handle() return sits under `.data`.
 */
import type { StreamingLogEvent } from '@bubblelab/shared-schemas';

export type PrimaryOutputKind = 'artefact' | 'process' | 'both';

export interface PrimaryOutput {
  kind: PrimaryOutputKind;
  /** User-facing plain-language label, agent-authored. */
  label: string;
  /** Top-level handle() return key whose value is the artefact link. */
  artefactKey?: string;
  /** Top-level handle() return keys whose values state what happened. */
  outcomeKeys?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow, cast-free read of metadata.primaryOutput. Returns null for flows
 * without a registration (all pre-U2 flows degrade to no result surface).
 */
export function getPrimaryOutput(
  metadata: Record<string, unknown> | undefined | null
): PrimaryOutput | null {
  if (!metadata) return null;
  const raw = metadata['primaryOutput'];
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  const label = raw['label'];
  if (kind !== 'artefact' && kind !== 'process' && kind !== 'both') return null;
  if (typeof label !== 'string' || label.trim() === '') return null;
  const artefactKey =
    typeof raw['artefactKey'] === 'string' && raw['artefactKey'] !== ''
      ? raw['artefactKey']
      : undefined;
  const outcomeKeysRaw = raw['outcomeKeys'];
  const outcomeKeys = Array.isArray(outcomeKeysRaw)
    ? outcomeKeysRaw.filter(
        (key): key is string => typeof key === 'string' && key !== ''
      )
    : undefined;
  return {
    kind,
    label,
    ...(artefactKey !== undefined ? { artefactKey } : {}),
    ...(outcomeKeys !== undefined && outcomeKeys.length > 0
      ? { outcomeKeys }
      : {}),
  };
}

/** What the result surfaces render. Formatted values only, never raw JSON. */
export interface ResultNodeValue {
  kind: PrimaryOutputKind;
  label: string;
  /** The artefact link, when kind includes an artefact and a run produced one. */
  artefactUrl?: string;
  /** Plain-language statements of what happened, when kind includes a process outcome. */
  outcomes?: string[];
}

/** True when the derived value carries something to show for the latest run. */
export function resultHasValue(value: ResultNodeValue | null): boolean {
  if (value === null) return false;
  return value.artefactUrl !== undefined || (value.outcomes?.length ?? 0) > 0;
}

/** "rowsAdded" -> "Rows added"; "doc_url" -> "Doc url". */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced === '') return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Flatten one outcome value into plain-language lines (F0.5: never raw
 * JSON). Strings pass through; arrays contribute one line per element;
 * objects flatten one "Label: value" line per entry.
 */
function formatOutcomeValue(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return value.trim() === '' ? [] : [value];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => formatOutcomeValue(item));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      formatOutcomeValue(entry).map((line) => `${humanizeKey(key)}: ${line}`)
    );
  }
  return [];
}

/**
 * The handle() return of the latest run, from the retained event array. The
 * retained run is authoritative when present: a failed latest run yields no
 * value (null) rather than falling back to an older success.
 */
function finalResultFromEvents(
  events: StreamingLogEvent[]
): { finalResult: Record<string, unknown> | null } | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'execution_complete') continue;
    const data = event.additionalData;
    if (!isRecord(data) || data['success'] !== true) {
      return { finalResult: null };
    }
    const finalResult = data['finalResult'];
    return { finalResult: isRecord(finalResult) ? finalResult : null };
  }
  return null;
}

/**
 * The handle() return from a persisted execution row's `result` field, which
 * stores { data: <handle() return>, ...summary }. A bare-object result (older
 * rows / other writers) is accepted as the return itself.
 */
function finalResultFromExecutionResult(
  latestExecutionResult: unknown
): Record<string, unknown> | null {
  if (!isRecord(latestExecutionResult)) return null;
  const data = latestExecutionResult['data'];
  if (isRecord(data)) return data;
  return latestExecutionResult;
}

/**
 * Derive what the result surfaces show. Returns null only when the flow has
 * no registered primary output; a registration with no run value yet returns
 * { kind, label } with no artefactUrl/outcomes (the surfaces render a
 * "run the flow" placeholder and telemetry reports hasValue: false).
 */
export function deriveResultNodeValue(
  primaryOutput: PrimaryOutput | null,
  events: StreamingLogEvent[],
  latestExecutionResult: unknown
): ResultNodeValue | null {
  if (primaryOutput === null) return null;

  const retained = finalResultFromEvents(events);
  const finalResult =
    retained !== null
      ? retained.finalResult
      : finalResultFromExecutionResult(latestExecutionResult);

  const value: ResultNodeValue = {
    kind: primaryOutput.kind,
    label: primaryOutput.label,
  };
  if (finalResult === null) return value;

  if (
    (primaryOutput.kind === 'artefact' || primaryOutput.kind === 'both') &&
    primaryOutput.artefactKey !== undefined
  ) {
    const raw = finalResult[primaryOutput.artefactKey];
    if (typeof raw === 'string' && raw.trim() !== '') {
      value.artefactUrl = raw;
    }
  }

  if (
    (primaryOutput.kind === 'process' || primaryOutput.kind === 'both') &&
    primaryOutput.outcomeKeys !== undefined
  ) {
    const outcomes = primaryOutput.outcomeKeys.flatMap((key) =>
      formatOutcomeValue(finalResult[key])
    );
    if (outcomes.length > 0) {
      value.outcomes = outcomes;
    }
  }

  return value;
}
