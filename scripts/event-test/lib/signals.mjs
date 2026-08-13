/**
 * runErrorSignals — 1:1 JS port of the studio's canonical collector
 * `collectRunErrorSignals` at
 * apps/bubble-studio/src/utils/executionErrorSignals.ts:129 (plus its
 * composeFixRequestMessage at :255 and the bubbleUtils.findBubbleByVariableId
 * join it depends on).
 *
 * RULE (FND.md F0.1): any change to the studio function updates this port in
 * the SAME PR. This is the single copy every event test uses; the three ad-hoc
 * JS copies (drive-fix-loop / gluu-fix-test / studio-test) are superseded.
 *
 * Signals collected, in event order:
 *  - `error` / `fatal` events                                  -> source 'event'
 *  - `bubble_execution_complete` whose result.success === false -> 'bubble' (FAILED STEP)
 *  - bubble results with HTTP status >= 400                     -> 'http'   (HTTP ERROR)
 *  - `execution_complete` with success === false                -> 'run'    (RUN FAILED)
 *
 * S5 identity: each failure signal joins its `bubble_execution` START event
 * (nearest unconsumed preceding, per variableId) for the request `url` /
 * `operation`, resolves the real variable name from optional
 * bubbleParameters, and embeds `(<bubbleName>#<variableId>, url: <url>)` in
 * the message so two identical failures from different call sites never read
 * the same.
 */

export const FIX_REQUEST_MARKER = '[RUN ERROR REPORT]';

/** Port of bubbleUtils.findBubbleByVariableId (direct key match, full scan,
 * dependency-graph recursion). */
function findBubbleByVariableId(bubbleParameters, variableId) {
  const findInDependencyGraph = (node) => {
    if (node.variableId === variableId) {
      return { variableId: node.variableId, variableName: node.name };
    }
    for (const dep of node.dependencies ?? []) {
      const found = findInDependencyGraph(dep);
      if (found) return found;
    }
    return null;
  };

  const direct = bubbleParameters[variableId];
  if (direct && typeof direct === 'object' && direct.variableId === variableId) {
    return direct;
  }
  for (const bubble of Object.values(bubbleParameters)) {
    if (!bubble || typeof bubble !== 'object') continue;
    if (bubble.variableId === variableId) return bubble;
    if (bubble.dependencyGraph) {
      const found = findInDependencyGraph(bubble.dependencyGraph);
      if (found) return found;
    }
  }
  return null;
}

function resolveVariableId(event) {
  if (typeof event.variableId === 'number') return event.variableId;
  const fromData = event.additionalData?.variableId;
  return typeof fromData === 'number' ? fromData : undefined;
}

function startEventIdentity(event) {
  const params = event.additionalData?.parameters;
  const identity = {};
  if (params && typeof params === 'object') {
    if (typeof params.url === 'string') identity.url = params.url;
    if (typeof params.operation === 'string') identity.operation = params.operation;
  }
  return identity;
}

function identitySegment(bubbleName, variableId, url) {
  if (variableId === undefined) {
    return url ? ` (url: ${url})` : '';
  }
  const urlPart = url ? `, url: ${url}` : '';
  return ` (${bubbleName ?? 'step'}#${variableId}${urlPart})`;
}

/**
 * @param {Array<Record<string, any>>} events StreamingLogEvent list
 * @param {Record<string|number, any>} [bubbleParameters] optional flow bubbleParameters
 */
export function runErrorSignals(events, bubbleParameters) {
  const signals = [];
  // Per-variableId FIFO of unconsumed start events; every completion
  // (success or failure) consumes its start.
  const pendingStarts = new Map();

  for (const event of events) {
    if (event.type === 'bubble_execution') {
      const varId = resolveVariableId(event);
      if (varId !== undefined) {
        const queue = pendingStarts.get(varId) ?? [];
        queue.push(startEventIdentity(event));
        pendingStarts.set(varId, queue);
      }
      continue;
    }

    if (event.type === 'error' || event.type === 'fatal') {
      signals.push({
        source: 'event',
        label: event.type.toUpperCase(),
        message: event.message || 'Unknown error',
        additionalData: event.additionalData,
        timestamp: event.timestamp,
        event,
      });
      continue;
    }

    if (event.type === 'bubble_execution_complete') {
      const variableId = resolveVariableId(event);
      const start =
        variableId !== undefined
          ? (pendingStarts.get(variableId)?.shift() ?? {})
          : {};

      const result = event.additionalData?.result;
      if (!result) continue;

      const resolvedName =
        bubbleParameters && variableId !== undefined
          ? findBubbleByVariableId(bubbleParameters, variableId)?.variableName
          : undefined;
      const stepName =
        resolvedName ||
        event.bubbleName ||
        event.variableName ||
        `step ${variableId ?? '?'}`;
      const identity = identitySegment(event.bubbleName, variableId, start.url);

      if (result.success === false) {
        const reason =
          result.error || result.data?.error || 'the step reported a failure';
        signals.push({
          source: 'bubble',
          label: 'FAILED STEP',
          message: `Step "${stepName}"${identity} failed: ${reason}`,
          variableId,
          variableName: resolvedName ?? undefined,
          url: start.url,
          operation: start.operation,
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
        });
      } else if (
        typeof result.data?.status === 'number' &&
        result.data.status >= 400
      ) {
        signals.push({
          source: 'http',
          label: 'HTTP ERROR',
          message: `Step "${stepName}"${identity} received HTTP ${result.data.status}${
            result.data.statusText ? ` (${result.data.statusText})` : ''
          }`,
          variableId,
          variableName: resolvedName ?? undefined,
          url: start.url,
          operation: start.operation,
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
        });
      }
      continue;
    }

    if (event.type === 'execution_complete') {
      const data = event.additionalData;
      if (data?.success === false) {
        signals.push({
          source: 'run',
          label: 'RUN FAILED',
          message: event.message || 'The run did not complete successfully',
          additionalData: event.additionalData,
          timestamp: event.timestamp,
          event,
        });
      }
    }
  }

  return signals;
}

/** Port of the studio's composeFixRequestMessage (same file). */
export function composeFixRequestMessage(events, issueDetails, bubbleParameters) {
  let details = issueDetails;
  let signalCount = 0;
  if (!details) {
    const signals = runErrorSignals(events, bubbleParameters);
    signalCount = signals.length;
    details = signals
      .map((signal, idx) => {
        const extra = signal.additionalData
          ? `\n   Additional info: ${JSON.stringify(signal.additionalData).slice(0, 1500)}`
          : '';
        return `${idx + 1}. ${signal.label}: ${signal.message}${extra}`;
      })
      .join('\n');
  }

  const countNote =
    signalCount > 0
      ? `the following ${signalCount} error signal${signalCount === 1 ? '' : 's'}`
      : 'the following error(s)';
  const body = details
    ? `My latest run of this flow failed with ${countNote}:\n\n${details}`
    : `My latest run of this flow failed, but no error events were captured.`;

  return `${FIX_REQUEST_MARKER}\n${body}\n\nHandle EVERY error above in this turn per your fixing procedure — do not stop after the first.`;
}
