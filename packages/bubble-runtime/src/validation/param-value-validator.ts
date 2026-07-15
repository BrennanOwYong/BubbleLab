/**
 * Static (pre-execution) validation of literal bubble parameter VALUES against
 * each bubble's declared Zod params schema.
 *
 * The TypeScript LanguageService check (BubbleValidator) catches structural
 * type errors, but Zod-only value constraints — `.email()`, `.min()`, `.max()`,
 * `.url()`, regexes, enum membership on dynamic strings — are invisible to the
 * type system. This module closes that gap: any parameter whose value is a
 * compile-time literal is checked against the capability's schema BEFORE any
 * code runs, so a bad literal input is rejected without ever executing the tool.
 *
 * Conservative by construction: parameters whose values are variables,
 * expressions, template strings with substitutions, or env reads are skipped
 * (they are unknowable statically). A skip is never an error — only a proven
 * violation of the declared schema is reported.
 */

import ts from 'typescript';
import type { z } from 'zod';
import type { ParsedBubbleWithInfo } from '@bubblelab/shared-schemas';
import { BubbleParameterType } from '@bubblelab/shared-schemas';
import type { BubbleFactory } from '@bubblelab/bubble-core';

/** Marker for nested values that are not statically knowable. */
const UNKNOWN_VALUE = Symbol('bubblelab.unknown-literal');

interface EvaluatedLiteral {
  value: unknown;
  /** Dot-joined paths (relative to the evaluated root) holding UNKNOWN_VALUE. */
  unknownPaths: string[];
}

/** Duck-typed Zod inspection — avoids instanceof across zod copies. */
function zodTypeName(schema: unknown): string | undefined {
  return (schema as { _def?: { typeName?: string } } | undefined)?._def
    ?.typeName;
}

function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  // Unwrap effects/refinements, optional/nullable/default/readonly wrappers to
  // find the underlying object/discriminated-union shape.
  for (let i = 0; i < 10; i++) {
    const name = zodTypeName(current);
    const def = (current as { _def?: Record<string, unknown> })._def;
    if (!def) break;
    if (name === 'ZodEffects' && def.schema) {
      current = def.schema;
    } else if (
      (name === 'ZodOptional' ||
        name === 'ZodNullable' ||
        name === 'ZodDefault' ||
        name === 'ZodReadonly') &&
      def.innerType
    ) {
      current = def.innerType;
    } else {
      break;
    }
  }
  return current;
}

function isZodObject(schema: unknown): schema is z.ZodObject<z.ZodRawShape> {
  return zodTypeName(schema) === 'ZodObject';
}

interface DiscriminatedUnionLike {
  _def: {
    typeName: string;
    discriminator: string;
    optionsMap: Map<unknown, z.ZodObject<z.ZodRawShape>>;
  };
  options: z.ZodObject<z.ZodRawShape>[];
}

function isZodDiscriminatedUnion(
  schema: unknown
): schema is DiscriminatedUnionLike {
  return zodTypeName(schema) === 'ZodDiscriminatedUnion';
}

/**
 * Evaluate a TypeScript expression source text into a JS value, replacing
 * anything not statically knowable with UNKNOWN_VALUE markers.
 * Returns undefined when the whole expression is unknowable.
 */
export function evaluateLiteralSource(
  sourceText: string
): EvaluatedLiteral | undefined {
  const sf = ts.createSourceFile(
    '__literal__.ts',
    `const __x = (${sourceText});`,
    ts.ScriptTarget.Latest,
    true
  );
  const stmt = sf.statements[0];
  if (!stmt || !ts.isVariableStatement(stmt)) return undefined;
  const decl = stmt.declarationList.declarations[0];
  if (!decl?.initializer) return undefined;
  let expr: ts.Expression = decl.initializer;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;

  const unknownPaths: string[] = [];
  const value = evalExpression(expr, [], unknownPaths);
  if (value === UNKNOWN_VALUE) {
    // The entire expression is unknowable — nothing to check.
    return undefined;
  }
  return { value, unknownPaths };
}

function evalExpression(
  node: ts.Expression,
  path: (string | number)[],
  unknownPaths: string[]
): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text.replace(/_/g, ''));
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text.replace(/_/g, ''));
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalExpression(node.expression, path, unknownPaths);
  }
  if (ts.isArrayLiteralExpression(node)) {
    if (node.elements.some((el) => ts.isSpreadElement(el))) {
      unknownPaths.push(path.join('.'));
      return UNKNOWN_VALUE;
    }
    return node.elements.map((el, i) =>
      evalExpression(el, [...path, i], unknownPaths)
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        // Spread, shorthand, method, or computed property — the object's full
        // key set is unknowable, so the whole object is unknown.
        unknownPaths.push(path.join('.'));
        return UNKNOWN_VALUE;
      }
      let key: string | undefined;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
        key = prop.name.text;
      } else if (ts.isNumericLiteral(prop.name)) {
        key = prop.name.text;
      }
      if (key === undefined) {
        unknownPaths.push(path.join('.'));
        return UNKNOWN_VALUE;
      }
      obj[key] = evalExpression(prop.initializer, [...path, key], unknownPaths);
    }
    return obj;
  }
  // Anything else (calls, identifiers, template substitutions, ternaries…)
  // is not statically knowable.
  unknownPaths.push(path.join('.'));
  return UNKNOWN_VALUE;
}

/** Convert a parsed BubbleParameter into a statically-known JS value, or undefined to skip. */
function literalParamValue(
  type: BubbleParameterType,
  raw: unknown
): EvaluatedLiteral | undefined {
  switch (type) {
    case BubbleParameterType.STRING: {
      if (typeof raw !== 'string') return undefined;
      // Template literals are stored as raw source (starting with a backtick);
      // their value depends on runtime substitutions — skip them.
      if (raw.startsWith('`')) return undefined;
      return { value: raw, unknownPaths: [] };
    }
    case BubbleParameterType.NUMBER: {
      const num =
        typeof raw === 'number'
          ? raw
          : Number(String(raw).trim().replace(/_/g, ''));
      if (Number.isNaN(num) && String(raw).trim() !== 'NaN') return undefined;
      return { value: num, unknownPaths: [] };
    }
    case BubbleParameterType.BOOLEAN: {
      if (typeof raw === 'boolean') return { value: raw, unknownPaths: [] };
      if (raw === 'true') return { value: true, unknownPaths: [] };
      if (raw === 'false') return { value: false, unknownPaths: [] };
      return undefined;
    }
    case BubbleParameterType.OBJECT:
    case BubbleParameterType.ARRAY: {
      if (typeof raw !== 'string') return undefined;
      return evaluateLiteralSource(raw);
    }
    default:
      // VARIABLE / EXPRESSION / ENV / UNKNOWN — not statically knowable.
      return undefined;
  }
}

/** Drop Zod issues that touch (in either direction) a path we marked unknown. */
function filterIssuesByUnknownPaths(
  issues: z.ZodIssue[],
  unknownPaths: string[]
): z.ZodIssue[] {
  if (unknownPaths.length === 0) return issues;
  return issues.filter((issue) => {
    const issuePath = issue.path.join('.');
    return !unknownPaths.some(
      (up) =>
        issuePath === up ||
        (up !== '' && issuePath.startsWith(`${up}.`)) ||
        (issuePath !== '' && up.startsWith(`${issuePath}.`)) ||
        up === '' // whole value unknown
    );
  });
}

function formatIssues(issues: z.ZodIssue[], receivedValue: unknown): string {
  const details = issues
    .map((issue) => {
      const where = issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
      return `${issue.message}${where}`;
    })
    .join('; ');
  let received = '';
  if (
    typeof receivedValue === 'string' ||
    typeof receivedValue === 'number' ||
    typeof receivedValue === 'boolean'
  ) {
    received = ` (received ${JSON.stringify(receivedValue)})`;
  }
  return `${details}${received}`;
}

/**
 * Validate every statically-known (literal) parameter value of every parsed
 * bubble against the bubble's declared Zod params schema.
 *
 * Returns human/LLM-readable error strings in the repo's `line N: …` format;
 * an empty array means no literal violates its declared schema.
 */
export function validateBubbleParameterValues(
  bubbles: Record<number, ParsedBubbleWithInfo>,
  factory: BubbleFactory
): string[] {
  const errors: string[] = [];

  for (const bubble of Object.values(bubbles)) {
    const metadata = factory.getMetadata(bubble.bubbleName);
    const schema = metadata?.schema;
    if (!schema) continue;

    const unwrapped = unwrapSchema(schema);
    const line = bubble.location?.startLine ?? 0;

    // Resolve the effective object shape (discriminated unions resolve via a
    // literal `operation` parameter; without a literal we cannot pick a branch
    // and skip the per-field checks).
    let shape: Record<string, unknown> | undefined;
    let operationLabel = '';

    if (isZodDiscriminatedUnion(unwrapped)) {
      const discriminator = unwrapped._def.discriminator;
      const opParam = bubble.parameters.find(
        (p) => p.name === discriminator && p.source !== 'spread'
      );
      if (!opParam || opParam.type !== BubbleParameterType.STRING) continue;
      const opValue = opParam.value;
      if (typeof opValue !== 'string' || opValue.startsWith('`')) continue;

      const option = unwrapped._def.optionsMap.get(opValue);
      if (!option) {
        const valid = Array.from(unwrapped._def.optionsMap.keys())
          .map((k) => JSON.stringify(k))
          .join(', ');
        errors.push(
          `line ${line}: [param-value] "${bubble.variableName}" (${bubble.bubbleName}): unknown ${discriminator} ${JSON.stringify(opValue)}. Valid ${discriminator}s: ${valid}`
        );
        continue;
      }
      shape = (option as z.ZodObject<z.ZodRawShape>).shape;
      operationLabel = `.${opValue}`;
    } else if (isZodObject(unwrapped)) {
      shape = unwrapped.shape;
    } else {
      continue;
    }

    for (const param of bubble.parameters) {
      if (param.name === 'credentials') continue;
      if (param.source === 'spread' || param.source === 'first-arg') continue;

      const fieldSchema = shape[param.name] as
        | z.ZodType<unknown>
        | undefined;
      if (!fieldSchema || typeof fieldSchema.safeParse !== 'function') {
        continue; // unknown keys are the type-checker's problem, not ours
      }

      const literal = literalParamValue(param.type, param.value);
      if (!literal) continue;

      const parsed = fieldSchema.safeParse(literal.value);
      if (parsed.success) continue;

      const realIssues = filterIssuesByUnknownPaths(
        parsed.error.issues,
        literal.unknownPaths
      );
      if (realIssues.length === 0) continue;

      const paramLine = param.location?.startLine ?? line;
      errors.push(
        `line ${paramLine}: [param-value] "${bubble.variableName}" (${bubble.bubbleName}${operationLabel}) parameter "${param.name}": ${formatIssues(realIssues, literal.value)}`
      );
    }
  }

  return errors;
}
