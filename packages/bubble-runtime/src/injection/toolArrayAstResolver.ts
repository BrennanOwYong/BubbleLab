/**
 * Static AST resolution of an AI-agent bubble's `tools`/`capabilities`
 * parameter value, replacing `new Function('return ' + value)`.
 *
 * Root cause (BACKLOG S1a): the parameter value is TypeScript source text
 * (e.g. `TOOLS`, `[...BASE, { name: 'x' }]`, `cond ? a : b`), not a JSON
 * literal. `new Function` only ever evaluates a literal array/object — any
 * variable reference throws a ReferenceError, which the caller's catch block
 * swallowed, silently returning an empty credential list. This walks the
 * TypeScript compiler AST instead: it resolves const array/string bindings,
 * array spreads, and ternary branches by name against the bubble flow's full
 * source, and reports a case it genuinely cannot resolve statically (e.g. a
 * function call building the array at runtime) as a typed unresolved
 * detection instead of dropping it.
 *
 * Ported from the scored prototype at
 * composio-eval/ast-detector/bubble/detect-bubbles.mjs (astWalk), adapted to
 * operate on an already-isolated parameter value string plus the bubble
 * flow's full source (rather than locating the `new XBubble(...)` call
 * itself, which BubbleScript's existing parser already does).
 */
import ts from 'typescript';

export interface UnresolvedNameArrayDetection {
  unresolved: true;
  /** Machine-readable cause: 'dynamic-expression' | 'unparseable'. */
  reason: string;
  /** Truncated source text of the expression that could not be resolved. */
  snippet: string;
}

export type NameArrayResolution =
  | { unresolved: false; names: string[] }
  | UnresolvedNameArrayDetection;

const SNIPPET_MAX_LENGTH = 200;

function truncate(text: string): string {
  return text.length > SNIPPET_MAX_LENGTH
    ? `${text.slice(0, SNIPPET_MAX_LENGTH)}…`
    : text;
}

/** Collects top-level-or-nested `const x = [...]` / `const x = '...'` bindings. */
function buildConstTables(sourceFile: ts.SourceFile): {
  constArrays: Map<string, ts.ArrayLiteralExpression>;
  constStrings: Map<string, string>;
} {
  const constArrays = new Map<string, ts.ArrayLiteralExpression>();
  const constStrings = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = node.initializer;
      if (ts.isArrayLiteralExpression(init)) {
        constArrays.set(node.name.text, init);
      } else if (
        ts.isStringLiteral(init) ||
        ts.isNoSubstitutionTemplateLiteral(init)
      ) {
        constStrings.set(node.name.text, init.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { constArrays, constStrings };
}

function literalOf(
  node: ts.Node | undefined,
  constStrings: Map<string, string>
): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isIdentifier(node) && constStrings.has(node.text)) {
    return constStrings.get(node.text)!;
  }
  return null;
}

/**
 * Walks an expression tree collecting `{ [keyProp]: '...' }` entries.
 * Handles array literals, spreads, ternary branches (both branches are
 * reachable, so both are collected), and identifiers bound to a const array
 * elsewhere in the source. Returns false the moment a branch cannot be
 * resolved statically (e.g. a function call), so the caller can distinguish
 * "fully resolved" from "partially/never resolved" and report the latter as
 * unresolved rather than silently returning a partial list.
 */
function collectNames(
  node: ts.Node | undefined,
  constArrays: Map<string, ts.ArrayLiteralExpression>,
  constStrings: Map<string, string>,
  names: string[],
  seen: Set<string>,
  keyProp: string
): boolean {
  if (!node) return false;

  if (ts.isParenthesizedExpression(node)) {
    return collectNames(
      node.expression,
      constArrays,
      constStrings,
      names,
      seen,
      keyProp
    );
  }

  if (ts.isAsExpression(node)) {
    return collectNames(
      node.expression,
      constArrays,
      constStrings,
      names,
      seen,
      keyProp
    );
  }

  if (ts.isArrayLiteralExpression(node)) {
    let ok = true;
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        ok =
          collectNames(
            element.expression,
            constArrays,
            constStrings,
            names,
            seen,
            keyProp
          ) && ok;
      } else {
        ok =
          collectNames(
            element,
            constArrays,
            constStrings,
            names,
            seen,
            keyProp
          ) && ok;
      }
    }
    return ok;
  }

  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === keyProp
      ) {
        const value = literalOf(property.initializer, constStrings);
        if (value === null) return false;
        names.push(value);
        return true;
      }
    }
    return false;
  }

  if (ts.isConditionalExpression(node)) {
    const whenTrueOk = collectNames(
      node.whenTrue,
      constArrays,
      constStrings,
      names,
      seen,
      keyProp
    );
    const whenFalseOk = collectNames(
      node.whenFalse,
      constArrays,
      constStrings,
      names,
      seen,
      keyProp
    );
    return whenTrueOk && whenFalseOk;
  }

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false;
    seen.add(node.text);
    if (constArrays.has(node.text)) {
      return collectNames(
        constArrays.get(node.text),
        constArrays,
        constStrings,
        names,
        seen,
        keyProp
      );
    }
    return false;
  }

  // Anything else (a function call, a member expression, etc.) is genuinely
  // dynamic — it cannot be resolved without running the code.
  return false;
}

/**
 * Resolves a bubble parameter's array-of-objects value (e.g. `tools` or
 * `capabilities`) to the list of `[keyProp]` string values it statically
 * evaluates to, using the bubble flow's full source to resolve identifiers.
 *
 * @param paramValueText - the isolated source text of the parameter value,
 *   as already extracted by BubbleScript's parser (e.g. `"TOOLS"` or
 *   `"[...BASE, { name: 'x' }]"`).
 * @param fullScriptSource - the full bubble flow source, used to resolve
 *   const bindings referenced by `paramValueText`.
 * @param keyProp - the object property that names each entry ('name' for
 *   tools, 'id' for capabilities).
 */
export function resolveNameArrayFromSource(
  paramValueText: string,
  fullScriptSource: string,
  keyProp: 'name' | 'id' = 'name'
): NameArrayResolution {
  let fullSourceFile: ts.SourceFile;
  try {
    fullSourceFile = ts.createSourceFile(
      '__bubble_flow_source__.ts',
      fullScriptSource,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );
  } catch {
    return {
      unresolved: true,
      reason: 'unparseable',
      snippet: truncate(paramValueText),
    };
  }
  const { constArrays, constStrings } = buildConstTables(fullSourceFile);

  let exprSourceFile: ts.SourceFile;
  try {
    exprSourceFile = ts.createSourceFile(
      '__param_value__.ts',
      `(${paramValueText});`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );
  } catch {
    return {
      unresolved: true,
      reason: 'unparseable',
      snippet: truncate(paramValueText),
    };
  }

  const statement = exprSourceFile.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    return {
      unresolved: true,
      reason: 'unparseable',
      snippet: truncate(paramValueText),
    };
  }

  let expr: ts.Expression = statement.expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }

  const names: string[] = [];
  const resolved = collectNames(
    expr,
    constArrays,
    constStrings,
    names,
    new Set(),
    keyProp
  );

  if (!resolved) {
    return {
      unresolved: true,
      reason: 'dynamic-expression',
      snippet: truncate(paramValueText),
    };
  }

  return { unresolved: false, names: Array.from(new Set(names)) };
}
