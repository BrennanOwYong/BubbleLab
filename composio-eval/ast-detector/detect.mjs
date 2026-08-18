/**
 * Prototype: static detection of Composio tool usage from a script's AST.
 *
 * Question it answers: given that a flow imports @composio/core, can a parser tell you
 * which tools the script uses, including from call sites BubbleLab's credential injector
 * refuses to touch (ternaries, .map() bodies, object literals)?
 *
 * Uses the TypeScript compiler's own parser, already present in the bubblelab-suite tree.
 * Read-only. Touches nothing outside this folder.
 *
 * Detection strategy, in order:
 *   1. bind local names for the Composio class from the import declaration
 *   2. bind client identifiers from `new <ComposioClass>(...)`
 *   3. walk every CallExpression whose callee is <client>.tools.execute / .tools.get
 *   4. resolve argument 0 (execute) or the `tools` array (get) to string literals,
 *      following single-assignment const indirection and const string arrays
 *   5. record `toolkits: [...]` filters separately, since they name a toolkit not a tool
 */
import ts from '/home/unix/bubblelab-suite/node_modules/typescript/lib/typescript.js';

const COMPOSIO_MODULES = ['@composio/core'];

export function detect(code, { relaxed = true } = {}) {
  const RELAXED = relaxed;
  const sf = ts.createSourceFile('flow.ts', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  const composioClassNames = new Set();
  const clientNames = new Set();
  const destructuredTools = new Map(); // identifier -> tier, from `const { tools } = composio`
  const constStrings = new Map();      // identifier -> string literal
  const constStringArrays = new Map(); // identifier -> string[]
  const loopBoundArrays = new Map();   // loop variable -> source array identifier

  const tools = new Set();
  const toolkits = new Set();
  const unresolved = [];

  const isNewComposio = (n) => n && ts.isNewExpression(n) && ts.isIdentifier(n.expression)
    && composioClassNames.has(n.expression.text);

  // --- pass 1: imports, client bindings, const tables, loop bindings ---------
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && COMPOSIO_MODULES.includes(node.moduleSpecifier.text)) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) composioClassNames.add(el.name.text); // handles `as` aliases
      }
      if (node.importClause?.name) composioClassNames.add(node.importClause.name.text);
    }

    // client held as a class property: `composio = new Composio({...})`
    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && isNewComposio(node.initializer)) {
      clientNames.add(node.name.text);
    }

    // a function whose body returns `new Composio(...)` makes its callees clients
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      let returnsClient = false;
      const scan = (n) => {
        if (ts.isReturnStatement(n) && isNewComposio(n.expression)) returnsClient = true;
        ts.forEachChild(n, scan);
      };
      if (node.body) scan(node.body);
      if (ts.isArrowFunction(node) && node.body && isNewComposio(node.body)) returnsClient = true;
      if (returnsClient && ts.isFunctionDeclaration(node) && node.name) {
        composioFactories.add(node.name.text);
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isIdentifier(node.name)) {
        if (isNewComposio(init)) clientNames.add(node.name.text);
        // client from a factory call: `const composio = client()`
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)
            && composioFactories.has(init.expression.text)) {
          clientNames.add(node.name.text);
        }
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          constStrings.set(node.name.text, init.text);
        }
        if (ts.isArrayLiteralExpression(init)) {
          const vals = init.elements
            .filter((e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
            .map((e) => e.text);
          if (vals.length === init.elements.length && vals.length > 0) {
            constStringArrays.set(node.name.text, vals);
          }
        }
      }
      // `const { tools } = composio`
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init)) {
        const tier = clientNames.has(init.text) ? 'strict' : (RELAXED ? 'relaxed' : null);
        if (tier) {
          for (const el of node.name.elements) {
            const prop = el.propertyName ?? el.name;
            if (ts.isIdentifier(prop) && prop.text === 'tools' && ts.isIdentifier(el.name)) {
              destructuredTools.set(el.name.text, tier);
            }
          }
        }
      }
    }

    // `for (const s of STEPS)` binds s to exactly STEPS, not to every array in scope
    if (ts.isForOfStatement(node) && ts.isIdentifier(node.expression)
        && ts.isVariableDeclarationList(node.initializer)) {
      const d = node.initializer.declarations[0];
      if (d && ts.isIdentifier(d.name)) loopBoundArrays.set(d.name.text, node.expression.text);
    }

    ts.forEachChild(node, collect);
  };
  const composioFactories = new Set();
  collect(sf);
  // second pass so factories declared after use are still bound
  collect(sf);

  // --- helpers --------------------------------------------------------------
  const literalOf = (node) => {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node) && constStrings.has(node.text)) return constStrings.get(node.text);
    return null;
  };

  const arrayOf = (node) => {
    if (!node) return null;
    if (ts.isArrayLiteralExpression(node)) {
      const vals = node.elements.map(literalOf);
      return vals.every((v) => v !== null) ? vals : null;
    }
    if (ts.isIdentifier(node) && constStringArrays.has(node.text)) {
      return constStringArrays.get(node.text);
    }
    return null;
  };

  // Two tiers. STRICT requires the receiver to trace back to `new Composio(...)`.
  // RELAXED accepts any `<anything>.tools.execute(...)` or a bare `tools.execute(...)`
  // once the file imports @composio/core. Relaxed trades precision for recall, and the
  // measured result (see run-adversarial.mjs) is that relaxed loses nothing and catches
  // client bindings strict cannot trace: factory returns, class fields, destructuring.
  const composioCall = (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
    const method = node.expression.name.text;
    if (method !== 'execute' && method !== 'get') return null;
    const target = node.expression.expression;

    // <receiver>.tools.<method>(...)
    if (ts.isPropertyAccessExpression(target) && target.name.text === 'tools') {
      const root = target.expression;
      const strict = ts.isIdentifier(root) && clientNames.has(root.text);
      if (strict) return { method, tier: 'strict' };
      if (RELAXED && composioClassNames.size > 0) return { method, tier: 'relaxed' };
      return null;
    }
    // bare tools.<method>(...) after `const { tools } = composio`
    if (ts.isIdentifier(target) && destructuredTools.has(target.text)) {
      return { method, tier: destructuredTools.get(target.text) };
    }
    return null;
  };

  const propIn = (objNode, key) => {
    if (!objNode || !ts.isObjectLiteralExpression(objNode)) return null;
    for (const p of objNode.properties) {
      if (ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name) && p.name.text === key) {
        return p.initializer;
      }
    }
    return null;
  };

  // --- pass 2: find and resolve the calls ------------------------------------
  const tiersSeen = new Set();
  const visit = (node) => {
    const hit = composioCall(node);
    const method = hit?.method;
    if (hit) tiersSeen.add(hit.tier);
    if (method === 'execute') {
      const slug = literalOf(node.arguments[0]);
      if (slug) tools.add(slug);
      else {
        // A loop variable resolves to exactly the array it iterates, and nothing else.
        // The earlier version scanned every const array in scope, which over-reported.
        const arg = node.arguments[0];
        let recovered = false;
        if (arg && ts.isIdentifier(arg) && loopBoundArrays.has(arg.text)) {
          const src = loopBoundArrays.get(arg.text);
          if (constStringArrays.has(src)) {
            constStringArrays.get(src).forEach((v) => tools.add(v));
            recovered = true;
          }
        }
        if (!recovered) {
          unresolved.push({
            kind: 'dynamic-slug',
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            text: arg ? arg.getText().slice(0, 60) : '(no argument)',
          });
        }
      }
    } else if (method === 'get') {
      const opts = node.arguments.find((a) => ts.isObjectLiteralExpression(a));
      const toolList = arrayOf(propIn(opts, 'tools'));
      const tkList = arrayOf(propIn(opts, 'toolkits'));
      if (toolList) toolList.forEach((t) => tools.add(t));
      if (tkList) {
        tkList.forEach((t) => toolkits.add(t));
        if (!toolList) {
          unresolved.push({
            kind: 'toolkit-filter',
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            text: `toolkits: [${tkList.join(', ')}] resolves to a set, not specific tools`,
          });
        }
      }
      if (!toolList && !tkList) {
        unresolved.push({
          kind: 'unfiltered-get',
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: 'tools.get with no static tools/toolkits filter',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return {
    usesComposio: composioClassNames.size > 0,
    tools: [...tools].sort(),
    toolkits: [...toolkits].sort(),
    unresolved,
    tiers: [...tiersSeen],
  };
}

