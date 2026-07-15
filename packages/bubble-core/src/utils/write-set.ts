/**
 * Write-set computation for the sign-off gate (REPO-MAP §4b).
 *
 * Given the parsed bubbles of a flow (call-site identity included) and the
 * per-operation side-effect metadata, collect every call site whose operation
 * is write-hinted. Fail-safe throughout: an unclassified bubble, an unknown
 * operation, or an operation whose value cannot be resolved statically (a
 * variable, an expression, a template literal) is treated as a write — an
 * unproven read never slips past the gate.
 *
 * Runs entirely on parsed metadata: no bubble is instantiated, no credential
 * is read, no network is touched (Phase-1 property preserved).
 */

import {
  BubbleParameterType,
  type OperationSideEffectMetadata,
  type ParsedBubbleWithInfo,
  type WriteSetEntry,
} from '@bubblelab/shared-schemas';
import { getSideEffectOverrideRegistry } from './side-effect-overrides.js';

export type OperationMetadataLookup = (
  bubbleName: string
) => Record<string, OperationSideEffectMetadata> | undefined;

/**
 * Every identity a call site is known by at runtime, most specific first.
 * BaseBubble matches grants against invocationCallSiteKey, currentUniqueId
 * (the dependency-graph unique id, or String(variableId) when the graph
 * carries no id), and String(context.variableId).
 */
export function callSiteKeysOf(bubble: ParsedBubbleWithInfo): string[] {
  const keys = [
    bubble.invocationCallSiteKey,
    bubble.dependencyGraph?.uniqueId,
    String(bubble.variableId),
  ].filter((key): key is string => typeof key === 'string' && key.length > 0);
  return [...new Set(keys)];
}

/** Resolve the `operation` param when it is a compile-time string literal. */
function resolveOperationLiteral(
  bubble: ParsedBubbleWithInfo
): { operation?: string; resolvable: boolean } {
  const operationParam = bubble.parameters.find((p) => p.name === 'operation');
  if (!operationParam) {
    // Bubble takes no operation discriminator (single-operation bubble).
    return { operation: undefined, resolvable: true };
  }
  if (
    operationParam.type === BubbleParameterType.STRING &&
    typeof operationParam.value === 'string' &&
    !operationParam.value.startsWith('`')
  ) {
    return { operation: operationParam.value, resolvable: true };
  }
  // Variable / expression / template operation: not statically resolvable.
  return { operation: undefined, resolvable: false };
}

/**
 * Compute the write set of a flow: every call site whose side effect is not a
 * pure documented read. Runtime-verified overrides outrank the supplied
 * doc-derived metadata (a corrected lying read joins the write set).
 */
export function computeWriteSet(
  parsedBubbles:
    | Record<string, ParsedBubbleWithInfo>
    | Record<number, ParsedBubbleWithInfo>,
  lookupOperationMetadata: OperationMetadataLookup
): WriteSetEntry[] {
  const registry = getSideEffectOverrideRegistry();
  const entries: WriteSetEntry[] = [];

  for (const bubble of Object.values(parsedBubbles)) {
    const aliasKeys = callSiteKeysOf(bubble);
    const callSiteKey = aliasKeys[0] ?? String(bubble.variableId);
    const metadata = registry.applyTo(
      bubble.bubbleName,
      lookupOperationMetadata(bubble.bubbleName)
    );
    const { operation, resolvable } = resolveOperationLiteral(bubble);

    let classification: OperationSideEffectMetadata | undefined;
    let sideEffect: 'read' | 'write' | 'read_with_side_effects';
    let reason: string;

    if (!resolvable) {
      sideEffect = 'write';
      reason =
        'operation is not a compile-time literal; fail-safe classified as write';
    } else if (!metadata || Object.keys(metadata).length === 0) {
      sideEffect = 'write';
      reason = `bubble '${bubble.bubbleName}' declares no operation metadata; fail-safe classified as write`;
    } else {
      classification =
        (operation !== undefined ? metadata[operation] : undefined) ??
        metadata['*'];
      if (!classification) {
        sideEffect = 'write';
        reason = `operation '${operation ?? '(none)'}' is unclassified; fail-safe classified as write`;
      } else {
        sideEffect = classification.sideEffect;
        reason =
          classification.source === 'observed'
            ? `runtime-verified as ${classification.sideEffect}: ${classification.citation}`
            : `documented as ${classification.sideEffect} (${classification.source}): ${classification.citation}`;
      }
    }

    if (sideEffect === 'read') continue;

    entries.push({
      callSiteKey,
      aliasKeys,
      variableId: bubble.variableId,
      bubbleName: bubble.bubbleName,
      operation,
      sideEffect,
      classification,
      reason,
    });
  }

  return entries;
}
