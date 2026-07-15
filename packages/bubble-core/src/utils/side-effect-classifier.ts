/**
 * Doc-grounded side-effect classifier, carrying provenance (IR-8).
 *
 * A classification is a claim that must carry its source. Binding rule: an operation is `write`
 * iff the docs say it CREATES A NEW RECORD — even as a side effect; `read` when the docs indicate
 * no mutation at all; `read_with_side_effects` when the docs indicate mutation without record
 * creation (a nominal read that marks-as-read, and also non-creating mutations like update/delete
 * — those cannot be plain `read`; the separate `destructive` flag carries the delete/irreversible
 * signal).
 *
 * The HTTP method is NEVER the classification signal. In the OpenAPI path the method only
 * corroborates idempotency; the class comes from the operation's prose. An OpenAPI operation with
 * no prose yields no classification and the hierarchy falls through to the next evidence.
 *
 * Source hierarchy (most → least authoritative): mcp > openapi > prose > manual.
 * `observed` (runtime-verified) classifications are produced by the runtime correction channel,
 * not by this doc classifier, and outrank everything doc-derived.
 *
 * References:
 * - MCP ToolAnnotations (`readOnlyHint` default false, `destructiveHint` default true,
 *   `idempotentHint` default false):
 *   https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 * - HTTP method idempotency (RFC 9110 §9.2.2): https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2
 */

import type {
  SideEffect,
  OperationSideEffectMetadata,
} from '@bubblelab/shared-schemas';

export class ClassificationError extends Error {
  override name = 'ClassificationError';
}

// ── Evidence types ────────────────────────────────────────────────────────────

/** MCP tool annotations, as published by an MCP server for a tool. All hints are optional. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpAnnotationEvidence {
  kind: 'mcp';
  annotations: McpToolAnnotations;
  /** e.g. `mcp://<server>/tools/<name>` or the server's tool listing reference. */
  citation: string;
}

export interface OpenApiEvidence {
  kind: 'openapi';
  /** HTTP method — used ONLY to corroborate idempotency, never to pick the class. */
  method: string;
  summary?: string;
  description?: string;
  /** e.g. `openapi.yaml#/paths/~1messages/post`. */
  citation: string;
}

export interface DocProseEvidence {
  kind: 'prose';
  /** The operation's documentation prose. */
  docText: string;
  /** The doc URL / snippet locator. */
  citation: string;
}

export interface ManualEvidence {
  kind: 'manual';
  sideEffect: SideEffect;
  destructive: boolean;
  idempotent: boolean;
  /** Defaults to 1 (a human asserted it). */
  confidence?: number;
  citation?: string;
}

export type SideEffectEvidence =
  | McpAnnotationEvidence
  | OpenApiEvidence
  | DocProseEvidence
  | ManualEvidence;

// ── Doc-prose signal extraction ───────────────────────────────────────────────

/**
 * Shape-level signals read out of documentation prose. `extractDocSignals` is the deterministic
 * keyword front-end; an LLM-backed extractor can replace it later by producing the same
 * `DocSignals` — the classification rules downstream stay identical.
 */
export interface DocSignals {
  /** The docs state a new record comes into existence (even as a side effect). */
  createsNewRecord: boolean;
  /** The docs state state changes without record creation (mark/update/delete/…). */
  mutates: boolean;
  /** Delete/irreversible language. */
  destructive: boolean;
  /** Return/retrieve/list/search language. */
  reads: boolean;
}

const CREATION_PATTERNS: readonly RegExp[] = [
  /\bcreates?\b/i,
  /\bcreating\b/i,
  /\badds?\s+(?:a|an|new)\b/i,
  /\binserts?\b/i,
  /\bsends?\b/i,
  /\bsending\b/i,
  /\bposts?\s+(?:a|an|new)\b/i,
  /\bpublishes?\b/i,
  /\buploads?\b/i,
  /\bgenerates?\s+(?:a|an|new)\b/i,
  /\bregisters?\s+(?:a|an|new)\b/i,
  /\bappends?\b/i,
  /\bwrites?\s+(?:a|an|new)\b/i,
  /\blogs?\s+(?:a|an)\b/i,
  /\brecords?\s+(?:a|an)\b/i,
  /\bcopies\b/i,
  /\bcop(?:y|ies)\s+(?:a|an|the)\b/i,
  /\bduplicates?\b/i,
  /\bschedules?\s+(?:a|an|new)\b/i,
  /\bnew\s+\w+\s+(?:is|will\s+be|gets)\s+(?:created|added|inserted|written|recorded)\b/i,
];

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\bdeletes?\b/i,
  /\bremoves?\b/i,
  /\bdestroys?\b/i,
  /\bpurges?\b/i,
  /\bwipes?\b/i,
  /\bpermanent(?:ly)?\b/i,
  /\birreversibl/i,
  /\bcannot\s+be\s+undone\b/i,
];

const MUTATION_PATTERNS: readonly RegExp[] = [
  /\bmarks?\b/i,
  /\bmarking\b/i,
  /\bupdates?\b/i,
  /\bmodif(?:y|ies|ying)\b/i,
  /\bsets?\b/i,
  /\bchanges?\b/i,
  /\bedits?\b/i,
  /\barchives?\b/i,
  /\brenames?\b/i,
  /\bmoves?\b/i,
  /\bassigns?\b/i,
  /\brevokes?\b/i,
  /\bresets?\b/i,
  /\bincrements?\b/i,
  /\bclears?\b/i,
  /\bmutates?\b/i,
  /\bshares?\s+(?:a|an|the)\b/i,
];

const READ_PATTERNS: readonly RegExp[] = [
  /\breturns?\b/i,
  /\bretrieves?\b/i,
  /\blists?\b/i,
  /\bgets?\b/i,
  /\bfetch(?:es)?\b/i,
  /\breads?\b/i,
  /\bsearch(?:es)?\b/i,
  /\bquer(?:y|ies)\b/i,
  /\bcounts?\b/i,
  /\bdownloads?\b/i,
  /\bread-only\b/i,
];

const NEGATION =
  /\b(?:does\s+not|doesn't|do\s+not|don't|will\s+not|won't|never|without|no\s+longer)\b/i;

/** Drop negated clauses ("Does not modify any data.") before matching affirmative verbs. */
function affirmativeText(text: string): string {
  return text
    .split(/(?<=[.;!?])\s+|\n+/)
    .map((sentence) =>
      sentence
        .split(',')
        .filter((clause) => !NEGATION.test(clause))
        .join(',')
    )
    .join(' ');
}

export function extractDocSignals(text: string): DocSignals {
  const affirmative = affirmativeText(text);
  const matches = (patterns: readonly RegExp[]): boolean =>
    patterns.some((p) => p.test(affirmative));
  const destructive = matches(DESTRUCTIVE_PATTERNS);
  return {
    createsNewRecord: matches(CREATION_PATTERNS),
    mutates: matches(MUTATION_PATTERNS) || destructive,
    destructive,
    reads: matches(READ_PATTERNS),
  };
}

// ── Classification rules (shared by openapi + prose) ──────────────────────────

interface CoreClassification {
  sideEffect: SideEffect;
  destructive: boolean;
  idempotent: boolean;
}

/**
 * Binding rule applied to extracted signals. Returns `undefined` when the prose carries no
 * signal at all (honest fall-through, never a guess).
 */
function classifyFromSignals(
  signals: DocSignals
): CoreClassification | undefined {
  if (signals.createsNewRecord) {
    // Creating again creates a duplicate — not idempotent.
    return {
      sideEffect: 'write',
      destructive: signals.destructive,
      idempotent: false,
    };
  }
  if (signals.mutates) {
    // Mutation without record creation: mark-as-read, update, delete. Set-style mutations are
    // idempotent (repeating converges to the same state).
    return {
      sideEffect: 'read_with_side_effects',
      destructive: signals.destructive,
      idempotent: true,
    };
  }
  if (signals.reads) {
    return { sideEffect: 'read', destructive: false, idempotent: true };
  }
  return undefined;
}

// ── Per-source classifiers ────────────────────────────────────────────────────

const CONFIDENCE = {
  mcp: 0.95,
  openapi: 0.85,
  prose: 0.6,
} as const;

function requireCitation(kind: string, citation: string): void {
  if (citation.trim().length === 0) {
    throw new ClassificationError(
      `${kind} evidence requires a non-empty citation — provenance is mandatory for non-manual sources`
    );
  }
}

/**
 * MCP annotations map directly. `readOnlyHint: true` → `read`. Otherwise the tool modifies its
 * environment; MCP cannot say whether that creates a record, so the conservative mapping is
 * `write`, with the spec defaults `destructiveHint ?? true` and `idempotentHint ?? false`.
 */
export function classifyFromMcpAnnotations(
  evidence: McpAnnotationEvidence
): OperationSideEffectMetadata {
  requireCitation(evidence.kind, evidence.citation);
  if (evidence.annotations.readOnlyHint === true) {
    return {
      sideEffect: 'read',
      destructive: false,
      idempotent: true,
      confidence: CONFIDENCE.mcp,
      source: 'mcp',
      citation: evidence.citation,
    };
  }
  return {
    sideEffect: 'write',
    destructive: evidence.annotations.destructiveHint ?? true,
    idempotent: evidence.annotations.idempotentHint ?? false,
    confidence: CONFIDENCE.mcp,
    source: 'mcp',
    citation: evidence.citation,
  };
}

/**
 * OpenAPI: the class comes from the operation's prose (summary + description); the method only
 * corroborates idempotency (RFC 9110 §9.2.2: PUT and DELETE are idempotent). No prose →
 * `undefined` — the method alone is never the signal.
 */
export function classifyFromOpenApi(
  evidence: OpenApiEvidence
): OperationSideEffectMetadata | undefined {
  requireCitation(evidence.kind, evidence.citation);
  const prose = [evidence.summary, evidence.description]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join('. ');
  if (prose.length === 0) return undefined;
  const core = classifyFromSignals(extractDocSignals(prose));
  if (core === undefined) return undefined;
  const method = evidence.method.toUpperCase();
  const idempotent =
    core.sideEffect === 'write' && (method === 'PUT' || method === 'DELETE')
      ? true
      : core.idempotent;
  return {
    sideEffect: core.sideEffect,
    destructive: core.destructive,
    idempotent,
    confidence: CONFIDENCE.openapi,
    source: 'openapi',
    citation: evidence.citation,
  };
}

/** Doc-prose: prose only, lower confidence; runtime observation must verify it before auto-run trust. */
export function classifyFromDocText(
  evidence: DocProseEvidence
): OperationSideEffectMetadata | undefined {
  requireCitation(evidence.kind, evidence.citation);
  if (evidence.docText.trim().length === 0) return undefined;
  const core = classifyFromSignals(extractDocSignals(evidence.docText));
  if (core === undefined) return undefined;
  return {
    sideEffect: core.sideEffect,
    destructive: core.destructive,
    idempotent: core.idempotent,
    confidence: CONFIDENCE.prose,
    source: 'prose',
    citation: evidence.citation,
  };
}

/** Manual human override; citation is still mandatory (every emitted classification carries one). */
export function classifyFromManual(
  evidence: ManualEvidence
): OperationSideEffectMetadata {
  const citation = evidence.citation?.trim();
  if (!citation) {
    throw new ClassificationError(
      'manual evidence requires a citation — state who asserted the classification and on what basis'
    );
  }
  return {
    sideEffect: evidence.sideEffect,
    destructive: evidence.destructive,
    idempotent: evidence.idempotent,
    confidence: evidence.confidence ?? 1,
    source: 'manual',
    citation,
  };
}

// ── Hierarchy entry point ─────────────────────────────────────────────────────

const HIERARCHY: readonly SideEffectEvidence['kind'][] = [
  'mcp',
  'openapi',
  'prose',
  'manual',
];

function tryClassify(
  evidence: SideEffectEvidence
): OperationSideEffectMetadata | undefined {
  switch (evidence.kind) {
    case 'mcp':
      return classifyFromMcpAnnotations(evidence);
    case 'openapi':
      return classifyFromOpenApi(evidence);
    case 'prose':
      return classifyFromDocText(evidence);
    case 'manual':
      return classifyFromManual(evidence);
  }
}

/**
 * Classify from the most authoritative evidence that yields a result:
 * mcp > openapi > prose > manual. Evidence that yields nothing (e.g. an OpenAPI entry with no
 * prose, or doc text with no signal) falls through; if nothing classifies, this throws — a guess
 * without provenance is never produced.
 */
export function classifySideEffect(
  evidence: readonly SideEffectEvidence[]
): OperationSideEffectMetadata {
  if (evidence.length === 0) {
    throw new ClassificationError(
      'no evidence provided; every classification must carry a source'
    );
  }
  for (const kind of HIERARCHY) {
    for (const item of evidence) {
      if (item.kind !== kind) continue;
      const result = tryClassify(item);
      if (result !== undefined) return result;
    }
  }
  throw new ClassificationError(
    'no evidence yielded a classification; the HTTP method alone is never used as the signal'
  );
}
