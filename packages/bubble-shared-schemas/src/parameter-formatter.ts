/**
 * Shared parameter formatting utilities for both frontend and runtime.
 * This module contains core formatting logic that can be used by:
 * - bubble-runtime (for code injection/transformation)
 * - bubble-studio (for visual editing)
 */

import type { BubbleParameter } from './bubble-definition-schema.js';
import { BubbleParameterType } from './bubble-definition-schema.js';

/**
 * Patterns that indicate function literals in source code.
 * Used to detect when parameters contain functions that cannot be safely condensed.
 */
const FUNCTION_LITERAL_PATTERNS = [
  'func:', // Object property with function value
  '=>', // Arrow function
  'function(', // Function expression
  'function (', // Function expression with space
  'async(', // Async arrow function
  'async (', // Async function with space
] as const;

/**
 * Check if a string contains function literal patterns.
 * When function literals are present, the source code must be preserved as-is
 * because functions cannot be safely serialized or condensed to single-line.
 */
export function containsFunctionLiteral(value: string): boolean {
  return FUNCTION_LITERAL_PATTERNS.some((pattern) => value.includes(pattern));
}

/**
 * Format a parameter value based on its type.
 * Converts values to their TypeScript code representation.
 */
export function formatParameterValue(value: unknown, type: string): string {
  switch (type) {
    case 'string': {
      const stringValue = String(value);
      // If it's a template literal, pass through unchanged
      if (stringValue.startsWith('`') && stringValue.endsWith('`')) {
        return stringValue;
      }
      // Always properly quote strings, regardless of input format
      // This ensures consistent quoting that survives condensation
      const escapedValue = stringValue.replace(/'/g, "\\'");
      return `'${escapedValue}'`;
    }
    case 'number':
      return String(value);
    case 'boolean':
      return String(value);
    case 'object':
      // If caller provided a source literal string, keep it as code
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Preserve source code if it contains function literals
        if (containsFunctionLiteral(trimmed)) {
          return value;
        }
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          trimmed.startsWith('new ')
        ) {
          return value;
        }
      }
      return JSON.stringify(value, null, 2);
    case 'array':
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Preserve source code if it contains function literals
        if (containsFunctionLiteral(trimmed)) {
          return value;
        }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          return value;
        }
      }
      return JSON.stringify(value);
    case 'env':
      return `process.env.${String(value)}`;
    case 'variable':
      return String(value); // Reference to another variable
    case 'expression':
      return String(value); // Return expressions unquoted so they can be evaluated
    default:
      return JSON.stringify(value);
  }
}

/**
 * Condense a parameters string to a single line.
 * Used when parameters don't contain function literals.
 */
export function condenseToSingleLine(input: string): string {
  // Whitespace/comma normalization must only apply to CODE spans, never to the
  // contents of string or template literals (mirrors stripCommentsOutsideStrings).
  // e.g. a URL like `...?current=temperature_2m,relative_humidity_2m` must keep
  // its commas untouched; injecting ", " breaks the request at runtime.
  const condenseCode = (code: string): string =>
    code
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\{\s+/g, '{ ')
      .replace(/\s+\}/g, ' }')
      .replace(/\s*,\s*/g, ', ');

  let result = '';
  let codeChunk = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle || inDouble || inTemplate) {
      result += ch;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (
        (inSingle && ch === "'") ||
        (inDouble && ch === '"') ||
        (inTemplate && ch === '`')
      ) {
        inSingle = false;
        inDouble = false;
        inTemplate = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      result += condenseCode(codeChunk);
      codeChunk = '';
      result += ch;
      if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else inTemplate = true;
      continue;
    }

    codeChunk += ch;
  }

  result += condenseCode(codeChunk);
  return result.trim();
}

/**
 * Strip // line comments and /* block comments that are outside of string and template literals.
 * This is used before we condense parameters into a single line so inline comments don't swallow code.
 */
export function stripCommentsOutsideStrings(input: string): string {
  let result = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escapeNext = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = i + 1 < input.length ? input[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        result += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++; // skip '/'
      }
      continue;
    }

    if (inSingle) {
      if (escapeNext) {
        result += ch;
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escapeNext = true;
        continue;
      }
      result += ch;
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (escapeNext) {
        result += ch;
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escapeNext = true;
        continue;
      }
      result += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    if (inTemplate) {
      if (escapeNext) {
        result += ch;
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escapeNext = true;
        continue;
      }
      result += ch;
      if (ch === '`') inTemplate = false;
      continue;
    }

    // Not in any string/comment
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++; // skip next '/'
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++; // skip next '*'
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      result += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      result += ch;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      result += ch;
      continue;
    }

    result += ch;
  }

  return result;
}

export interface BuildParameterObjectOptions {
  /** Whether to preserve multi-line formatting (default: false, will condense to single line) */
  preserveFormatting?: boolean;
}

/**
 * Build just the parameters object literal (no runtime metadata like logger config).
 * This is the core function used by both runtime and frontend for parameter serialization.
 *
 * @param parameters - Array of bubble parameters
 * @param options - Optional settings for formatting
 * @returns The parameters object as a TypeScript code string
 */
export function buildParameterObjectLiteral(
  parameters: BubbleParameter[],
  options?: BuildParameterObjectOptions
): string {
  const { preserveFormatting = false } = options ?? {};

  if (!parameters || parameters.length === 0) {
    return '{}';
  }

  // Handle single variable parameter case (e.g., new GoogleDriveBubble(params))
  if (
    parameters.length === 1 &&
    parameters[0].type === BubbleParameterType.VARIABLE
  ) {
    const paramValue = formatParameterValue(
      parameters[0].value,
      parameters[0].type
    );
    return paramValue;
  }

  const nonCredentialParams = parameters.filter(
    (p) => p.name !== 'credentials'
  );
  const credentialsParam = parameters.find(
    (p) => p.name === 'credentials' && p.type === BubbleParameterType.OBJECT
  );

  // Handle single variable parameter + credentials case
  if (
    credentialsParam &&
    nonCredentialParams.length === 1 &&
    nonCredentialParams[0].type === BubbleParameterType.VARIABLE
  ) {
    const paramsParam = nonCredentialParams[0];

    // Only spread if the parameter source is 'first-arg' (represents entire first argument),
    // or if source is undefined (backward compatibility) and name is 'arg0' (parser's fallback).
    const shouldSpread =
      paramsParam.source === 'first-arg' ||
      (paramsParam.source === undefined && paramsParam.name === 'arg0');

    if (shouldSpread) {
      const paramsValue = formatParameterValue(
        paramsParam.value,
        paramsParam.type
      );
      const credentialsValue = formatParameterValue(
        credentialsParam.value,
        credentialsParam.type
      );

      return `{...${paramsValue}, credentials: ${credentialsValue}}`;
    }
  }

  // Separate spreads from regular properties
  const spreadParams = nonCredentialParams.filter((p) => p.source === 'spread');
  const regularParams = nonCredentialParams.filter(
    (p) => p.source !== 'spread'
  );

  // Build parameter entries: regular properties first, then spreads
  const regularEntries = regularParams.map((param) => {
    const value = formatParameterValue(param.value, param.type);
    return `${param.name}: ${value}`;
  });

  const spreadEntries = spreadParams.map((param) => {
    const value = formatParameterValue(param.value, param.type);
    return `...${value}`;
  });

  // Combine all entries: regular properties, spreads, then credentials
  const allEntries = [...regularEntries, ...spreadEntries];
  if (credentialsParam) {
    const credentialsValue = formatParameterValue(
      credentialsParam.value,
      credentialsParam.type
    );
    allEntries.push(`credentials: ${credentialsValue}`);
  }

  let paramsString = `{\n    ${allEntries.join(',\n    ')}\n  }`;

  // Check if parameters contain function literals before condensing
  const hasFunctions = containsFunctionLiteral(paramsString);

  if (!preserveFormatting && !hasFunctions) {
    // Strip comments and condense to single line
    paramsString = stripCommentsOutsideStrings(paramsString);
    paramsString = condenseToSingleLine(paramsString);
  }

  return paramsString;
}
