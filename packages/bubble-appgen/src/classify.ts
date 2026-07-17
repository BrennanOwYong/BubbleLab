/**
 * Side-effect classification (ADD-ANY-APP S4), delegating to the SHIPPED
 * bubble-core classifier so generated metadata matches the backfill pipeline.
 *
 * Order:
 * 1. Carrier detection: an operation whose input carries caller-supplied
 *    SQL/code and whose prose says it executes/submits it -> fail-safe `write`
 *    with a carrier-note citation (statement-level refinement is a follow-up).
 * 2. classifyFromOpenApi over the operation's own summary/description.
 * 3. No signal -> fail-safe `write` + `unverified: true` + confidence 0.2,
 *    queued for the S7.5 human review gate. Never a silent guess.
 */
import { classifyFromOpenApi } from '../../bubble-core/src/utils/side-effect-classifier.js';
import type { OperationSideEffectMetadata } from '@bubblelab/shared-schemas';
import type { OperationDraft } from './types.js';

const DEFAULT_CARRIER_FIELDS = ['statement', 'sql', 'query', 'code', 'command'];
const CARRIER_PROSE = /\b(execut\w*|submit\w*|run\w*)\b/i;

function isCarrier(draft: OperationDraft, carrierFields: string[]): boolean {
  const prose = `${draft.summary ?? ''} ${draft.description ?? ''}`;
  if (!CARRIER_PROSE.test(prose)) return false;
  return draft.fields.some(
    (field) =>
      field.location === 'body' &&
      field.schema.type === 'string' &&
      carrierFields.includes(field.name)
  );
}

export function classifyOperation(
  draft: OperationDraft,
  carrierFields: string[] = DEFAULT_CARRIER_FIELDS
): OperationSideEffectMetadata {
  if (isCarrier(draft, carrierFields)) {
    return {
      sideEffect: 'write',
      destructive: false,
      idempotent: false,
      confidence: 0.85,
      source: 'openapi',
      citation: `${draft.citation} — "${(draft.summary ?? '').trim()}" — carrier operation: executes caller-supplied SQL; fail-safe write until statement-level verb refinement is applied`,
    };
  }

  const classified = classifyFromOpenApi({
    kind: 'openapi',
    method: draft.method,
    summary: draft.summary,
    description: draft.description,
    citation: `${draft.citation} — "${(draft.summary ?? draft.description ?? '').trim()}"`,
  });
  if (classified !== undefined) return classified;

  return {
    sideEffect: 'write',
    destructive: false,
    idempotent: false,
    confidence: 0.2,
    source: 'openapi',
    citation: `${draft.citation} — no doc signal in "${(draft.summary ?? '').trim()}"; fail-safe write pending human review`,
    unverified: true,
  };
}
