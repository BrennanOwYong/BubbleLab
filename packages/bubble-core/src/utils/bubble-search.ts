/**
 * Capability -> owning-bubble search (BACKLOG S3).
 *
 * Scores every registered bubble's metadata against a plain-language
 * capability query, so a capability whose product name differs from its
 * owner's registry name ("Google Doc" living inside `google-drive`,
 * "database rows" inside `notion`) resolves to the owning bubble and the
 * operations that provide it. The index is the registry metadata itself —
 * name, alias, descriptions, and the operation literals walked from the
 * params discriminated union — never a second hand-maintained mapping.
 *
 * Ranking rules (S3 brief, "Suggestion ranking on generic tokens" risk):
 * - multi-token AND-boost: the summed per-token score is multiplied by the
 *   count of distinct query tokens matched, so a bubble matching BOTH
 *   "google" and "doc" outranks every single-token match;
 * - per-token weight: name/alias (5) > operation literal (4) > description (2),
 *   so operation-literal matches outrank description-only matches.
 *
 * Consumers: GetBubbleDetailsTool miss path (owning-bubble suggestions),
 * GET /bubble-flow/bubble-search (the sidecar's search_bubbles tool).
 */
import type { z } from 'zod';

/** Structural subset of BubbleFactory.getMetadata() output the scorer reads. */
export interface SearchableBubbleMetadata {
  name: string;
  type?: string;
  alias?: string;
  shortDescription?: string;
  longDescription?: string;
  schema?: unknown;
}

export interface BubbleSearchMatch {
  name: string;
  type?: string;
  shortDescription: string;
  /** Operations whose name or param keys matched a query token. */
  matchedOperations: string[];
  score: number;
}

interface OperationLiteral {
  operation: string;
  tokens: Set<string>;
}

const MIN_TOKEN_LENGTH = 2;
const MIN_PREFIX_LENGTH = 3;
const MAX_MATCHED_OPERATIONS = 8;
const SHORT_DESCRIPTION_CAP = 200;

const WEIGHT_NAME = 5;
const WEIGHT_OPERATION = 4;
const WEIGHT_DESCRIPTION = 2;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}

/**
 * A query token matches a field token on exact equality or a prefix
 * relationship in either direction ("doc" matches "docs" and "document";
 * "sheets" matches "sheet"), with a minimum prefix length so two-letter
 * fragments never match by prefix.
 */
function tokensMatch(queryToken: string, fieldToken: string): boolean {
  if (queryToken === fieldToken) return true;
  if (
    queryToken.length >= MIN_PREFIX_LENGTH &&
    fieldToken.startsWith(queryToken)
  ) {
    return true;
  }
  if (
    fieldToken.length >= MIN_PREFIX_LENGTH &&
    queryToken.startsWith(fieldToken)
  ) {
    return true;
  }
  return false;
}

function setMatches(queryToken: string, fieldTokens: Set<string>): boolean {
  for (const fieldToken of fieldTokens) {
    if (tokensMatch(queryToken, fieldToken)) return true;
  }
  return false;
}

function isZodTypeLike(value: unknown): value is z.ZodTypeAny {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_def' in (value as Record<string, unknown>)
  );
}

/**
 * Walk a params discriminated union (the same shape
 * GetBubbleDetailsTool.generateOperationExamples walks) and collect, per
 * operation, the searchable tokens of its literal name plus its param keys
 * (`convert_to_google_docs` carries "google" + "docs" for `upload_file`).
 * Non-discriminated schemas yield no operation literals.
 */
export function extractOperationLiterals(schema: unknown): OperationLiteral[] {
  const literals: OperationLiteral[] = [];
  if (!isZodTypeLike(schema)) return literals;
  const def = schema._def as {
    typeName?: string;
    options?: unknown[];
    discriminator?: string;
  };
  if (def.typeName !== 'ZodDiscriminatedUnion' || !Array.isArray(def.options)) {
    return literals;
  }
  const discriminator = def.discriminator ?? 'operation';
  for (const option of def.options) {
    if (!isZodTypeLike(option) || !('shape' in option)) {
      continue;
    }
    const shape = (option as z.ZodObject<z.ZodRawShape>).shape;
    const discriminatorField = shape[discriminator];
    if (!isZodTypeLike(discriminatorField)) continue;
    const literalDef = discriminatorField._def as {
      typeName?: string;
      value?: unknown;
    };
    if (
      literalDef.typeName !== 'ZodLiteral' ||
      literalDef.value === undefined
    ) {
      continue;
    }
    const operation = String(literalDef.value);
    const tokens = new Set(tokenize(operation));
    for (const key of Object.keys(shape)) {
      if (key === discriminator) continue;
      if (key.toLowerCase().includes('credential')) continue;
      for (const token of tokenize(key)) tokens.add(token);
    }
    literals.push({ operation, tokens });
  }
  return literals;
}

/**
 * Find the bubble a declared alias points at (e.g. 'gdrive' -> google-drive).
 * Exact, case-insensitive match on the alias field only.
 */
export function findByAlias(
  entries: SearchableBubbleMetadata[],
  name: string
): SearchableBubbleMetadata | undefined {
  const lookup = name.toLowerCase();
  return entries.find(
    (entry) => entry.alias !== undefined && entry.alias.toLowerCase() === lookup
  );
}

/**
 * Rank registered bubbles by how well they answer a capability query.
 * Returns at most `limit` matches, best first; empty when nothing scores.
 */
export function searchBubbleMetadata(
  entries: SearchableBubbleMetadata[],
  query: string,
  limit = 5
): BubbleSearchMatch[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0) return [];

  const matches: BubbleSearchMatch[] = [];
  for (const entry of entries) {
    const nameTokens = new Set([
      ...tokenize(entry.name),
      ...tokenize(entry.alias ?? ''),
    ]);
    const descriptionTokens = new Set(
      tokenize(`${entry.shortDescription ?? ''} ${entry.longDescription ?? ''}`)
    );
    const operations = extractOperationLiterals(entry.schema);

    const matchedOperations = new Set<string>();
    let matchedTokenCount = 0;
    let score = 0;
    for (const queryToken of queryTokens) {
      let weight = 0;
      if (setMatches(queryToken, nameTokens)) weight = WEIGHT_NAME;
      for (const operation of operations) {
        if (setMatches(queryToken, operation.tokens)) {
          weight = Math.max(weight, WEIGHT_OPERATION);
          matchedOperations.add(operation.operation);
        }
      }
      if (setMatches(queryToken, descriptionTokens)) {
        weight = Math.max(weight, WEIGHT_DESCRIPTION);
      }
      if (weight > 0) {
        matchedTokenCount += 1;
        score += weight;
      }
    }
    if (matchedTokenCount === 0) continue;
    matches.push({
      name: entry.name,
      type: entry.type,
      shortDescription: (entry.shortDescription ?? '').slice(
        0,
        SHORT_DESCRIPTION_CAP
      ),
      matchedOperations: [...matchedOperations].slice(
        0,
        MAX_MATCHED_OPERATIONS
      ),
      // AND-boost: matching more distinct query tokens multiplies the score.
      score: score * matchedTokenCount,
    });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches.slice(0, limit);
}
