import ts from 'typescript';
import { validateCronExpression } from '@bubblelab/shared-schemas';

/**
 * Represents a lint error found during validation
 */
export interface LintError {
  line: number;
  column?: number;
  message: string;
}

/**
 * Context containing pre-parsed AST information for lint rules
 * This allows rules to avoid redundant AST traversals
 */
export interface LintRuleContext {
  sourceFile: ts.SourceFile;
  bubbleFlowClass: ts.ClassDeclaration | null;
  handleMethod: ts.MethodDeclaration | null;
  handleMethodBody: ts.Block | null;
  importedBubbleClasses: Set<string>;
  /** The trigger type extracted from BubbleFlow<'trigger-type'> generic parameter */
  bubbleFlowTriggerType: string | null;
}

/**
 * Interface for lint rules that can validate BubbleFlow code
 */
export interface LintRule {
  name: string;
  validate(context: LintRuleContext): LintError[];
}

/**
 * Registry that manages and executes all lint rules
 */
export class LintRuleRegistry {
  private rules: LintRule[] = [];

  /**
   * Register a lint rule
   */
  register(rule: LintRule): void {
    this.rules.push(rule);
  }

  /**
   * Execute all registered rules on the given code
   * Traverses AST once and shares context with all rules for efficiency
   */
  validateAll(sourceFile: ts.SourceFile): LintError[] {
    // Parse AST once and create shared context
    const context = parseLintRuleContext(sourceFile);

    const errors: LintError[] = [];
    for (const rule of this.rules) {
      try {
        const ruleErrors = rule.validate(context);
        errors.push(...ruleErrors);
      } catch (error) {
        // If a rule fails, log but don't stop other rules
        console.error(`Error in lint rule ${rule.name}:`, error);
      }
    }
    return errors;
  }

  /**
   * Get all registered rule names
   */
  getRuleNames(): string[] {
    return this.rules.map((r) => r.name);
  }
}

/**
 * Parses the AST once to create a shared context for all lint rules
 * This avoids redundant AST traversals by doing a single pass
 */
function parseLintRuleContext(sourceFile: ts.SourceFile): LintRuleContext {
  let bubbleFlowClass: ts.ClassDeclaration | null = null;
  let handleMethod: ts.MethodDeclaration | null = null;
  let bubbleFlowTriggerType: string | null = null;
  const importedBubbleClasses = new Set<string>();

  // Single AST traversal to collect all needed information
  const visit = (node: ts.Node) => {
    // Find BubbleFlow class
    if (ts.isClassDeclaration(node) && !bubbleFlowClass) {
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const type of clause.types) {
              if (ts.isIdentifier(type.expression)) {
                if (type.expression.text === 'BubbleFlow') {
                  bubbleFlowClass = node;

                  // Extract trigger type from BubbleFlow<'trigger-type'> generic parameter
                  if (type.typeArguments && type.typeArguments.length > 0) {
                    const firstArg = type.typeArguments[0];
                    if (
                      ts.isLiteralTypeNode(firstArg) &&
                      ts.isStringLiteral(firstArg.literal)
                    ) {
                      bubbleFlowTriggerType = firstArg.literal.text;
                    }
                  }

                  // Find handle method in this class
                  if (node.members) {
                    for (const member of node.members) {
                      if (ts.isMethodDeclaration(member)) {
                        const name = member.name;
                        if (ts.isIdentifier(name) && name.text === 'handle') {
                          handleMethod = member;
                          break;
                        }
                      }
                    }
                  }
                  break;
                }
              }
            }
          }
        }
      }
    }

    // Collect imported bubble classes
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        (moduleSpecifier.text === '@bubblelab/bubble-core' ||
          moduleSpecifier.text === '@nodex/bubble-core')
      ) {
        if (node.importClause && node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const element of node.importClause.namedBindings.elements) {
              const importedName = element.name
                ? element.name.text
                : element.propertyName?.text;
              if (importedName) {
                if (
                  (importedName.endsWith('Bubble') ||
                    (importedName.endsWith('Tool') &&
                      !importedName.includes('Structured'))) &&
                  importedName !== 'BubbleFlow' &&
                  importedName !== 'BaseBubble'
                ) {
                  importedBubbleClasses.add(importedName);
                }
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  let handleMethodBody: ts.Block | null = null;
  if (handleMethod !== null) {
    const methodBody = (handleMethod as ts.MethodDeclaration).body;
    if (methodBody !== undefined && ts.isBlock(methodBody)) {
      handleMethodBody = methodBody;
    }
  }

  return {
    sourceFile,
    bubbleFlowClass,
    handleMethod,
    handleMethodBody,
    importedBubbleClasses,
    bubbleFlowTriggerType,
  };
}

/**
 * Lint rule that prevents throw statements directly in the handle method
 */
export const noThrowInHandleRule: LintRule = {
  name: 'no-throw-in-handle',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Use pre-parsed context
    if (!context.handleMethodBody) {
      return errors; // No handle method body found, skip this rule
    }

    // Check only direct statements in the method body (not nested)
    for (const statement of context.handleMethodBody.statements) {
      const throwError = checkStatementForThrow(statement, context.sourceFile);
      if (throwError) {
        errors.push(throwError);
      }
    }

    return errors;
  },
};

/**
 * Checks if a statement is a throw statement or contains a throw at the top level
 * Only checks direct statements, not nested blocks
 */
function checkStatementForThrow(
  statement: ts.Statement,
  sourceFile: ts.SourceFile
): LintError | null {
  // Direct throw statement
  if (ts.isThrowStatement(statement)) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      statement.getStart(sourceFile)
    );
    return {
      line: line + 1, // Convert to 1-based
      message:
        'throw statements are not allowed directly in handle method. Move error handling into another step.',
    };
  }

  // Check for if statement with direct throw in then/else branches
  // Note: We only check if the then/else is a direct throw statement, not if it's inside a block
  if (ts.isIfStatement(statement)) {
    // Check if the then branch is a direct throw statement (not inside a block)
    if (ts.isThrowStatement(statement.thenStatement)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        statement.thenStatement.getStart(sourceFile)
      );
      return {
        line: line + 1,
        message:
          'throw statements are not allowed directly in handle method. Move error handling into another step.',
      };
    }

    // Check if the else branch is a direct throw statement (not inside a block)
    if (
      statement.elseStatement &&
      ts.isThrowStatement(statement.elseStatement)
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        statement.elseStatement.getStart(sourceFile)
      );
      return {
        line: line + 1,
        message:
          'throw statements are not allowed directly in handle method. Move error handling into another step.',
      };
    }
  }

  return null;
}

/**
 * Lint rule that prevents direct bubble instantiation in the handle method
 */
export const noDirectBubbleInstantiationInHandleRule: LintRule = {
  name: 'no-direct-bubble-instantiation-in-handle',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Use pre-parsed context
    if (!context.handleMethodBody) {
      return errors; // No handle method body found, skip this rule
    }

    // Recursively check all statements in the method body, including nested blocks
    for (const statement of context.handleMethodBody.statements) {
      const bubbleErrors = checkStatementForBubbleInstantiation(
        statement,
        context.sourceFile,
        context.importedBubbleClasses
      );
      errors.push(...bubbleErrors);
    }

    return errors;
  },
};

/**
 * Checks if a statement contains a direct bubble instantiation
 * Recursively checks nested blocks to find all bubble instantiations
 */
function checkStatementForBubbleInstantiation(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  importedBubbleClasses: Set<string>
): LintError[] {
  const errors: LintError[] = [];

  // Check for variable declaration with bubble instantiation
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer) {
        const error = checkExpressionForBubbleInstantiation(
          declaration.initializer,
          sourceFile,
          importedBubbleClasses
        );
        if (error) {
          errors.push(error);
        }
      }
    }
  }

  // Check for expression statement with bubble instantiation
  if (ts.isExpressionStatement(statement)) {
    const error = checkExpressionForBubbleInstantiation(
      statement.expression,
      sourceFile,
      importedBubbleClasses
    );
    if (error) {
      errors.push(error);
    }
  }

  // Check for if statement - recursively check then/else branches
  if (ts.isIfStatement(statement)) {
    // Check the then branch
    if (ts.isBlock(statement.thenStatement)) {
      // Recursively check all statements inside the block
      for (const nestedStatement of statement.thenStatement.statements) {
        const nestedErrors = checkStatementForBubbleInstantiation(
          nestedStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    } else {
      // Single statement (not a block) - check it directly
      const nestedErrors = checkStatementForBubbleInstantiation(
        statement.thenStatement,
        sourceFile,
        importedBubbleClasses
      );
      errors.push(...nestedErrors);
    }

    // Check the else branch if it exists
    if (statement.elseStatement) {
      if (ts.isBlock(statement.elseStatement)) {
        // Recursively check all statements inside the block
        for (const nestedStatement of statement.elseStatement.statements) {
          const nestedErrors = checkStatementForBubbleInstantiation(
            nestedStatement,
            sourceFile,
            importedBubbleClasses
          );
          errors.push(...nestedErrors);
        }
      } else {
        // Single statement (not a block) - check it directly
        const nestedErrors = checkStatementForBubbleInstantiation(
          statement.elseStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    }
  }

  // Check for other block statements (for, while, etc.)
  if (
    ts.isForStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement)
  ) {
    const block = statement.statement;
    if (ts.isBlock(block)) {
      for (const nestedStatement of block.statements) {
        const nestedErrors = checkStatementForBubbleInstantiation(
          nestedStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    } else {
      // Single statement (not a block) - check it directly
      const nestedErrors = checkStatementForBubbleInstantiation(
        block,
        sourceFile,
        importedBubbleClasses
      );
      errors.push(...nestedErrors);
    }
  }

  // Check for try-catch-finally statements
  if (ts.isTryStatement(statement)) {
    // Check try block
    if (ts.isBlock(statement.tryBlock)) {
      for (const nestedStatement of statement.tryBlock.statements) {
        const nestedErrors = checkStatementForBubbleInstantiation(
          nestedStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    }
    // Check catch clause
    if (statement.catchClause && statement.catchClause.block) {
      for (const nestedStatement of statement.catchClause.block.statements) {
        const nestedErrors = checkStatementForBubbleInstantiation(
          nestedStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    }
    // Check finally block
    if (statement.finallyBlock && ts.isBlock(statement.finallyBlock)) {
      for (const nestedStatement of statement.finallyBlock.statements) {
        const nestedErrors = checkStatementForBubbleInstantiation(
          nestedStatement,
          sourceFile,
          importedBubbleClasses
        );
        errors.push(...nestedErrors);
      }
    }
  }

  return errors;
}

/**
 * Checks if an expression is a bubble instantiation (new BubbleClass(...))
 */
function checkExpressionForBubbleInstantiation(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  importedBubbleClasses: Set<string>
): LintError | null {
  // Handle await expressions
  if (ts.isAwaitExpression(expression)) {
    return checkExpressionForBubbleInstantiation(
      expression.expression,
      sourceFile,
      importedBubbleClasses
    );
  }

  // Handle call expressions (e.g., new Bubble().action())
  if (ts.isCallExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression.expression)) {
      return checkExpressionForBubbleInstantiation(
        expression.expression.expression,
        sourceFile,
        importedBubbleClasses
      );
    }
  }

  // Check for new expression
  if (ts.isNewExpression(expression)) {
    const className = getClassNameFromExpression(expression.expression);
    if (className && isBubbleClass(className, importedBubbleClasses)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        expression.getStart(sourceFile)
      );
      return {
        line: line + 1,
        message:
          'Direct bubble instantiation is not allowed in handle method. Move bubble creation into another step.',
      };
    }
  }

  return null;
}

/**
 * Gets the class name from an expression (handles identifiers and property access)
 */
function getClassNameFromExpression(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

/**
 * Checks if a class name represents a bubble class
 */
function isBubbleClass(
  className: string,
  importedBubbleClasses: Set<string>
): boolean {
  // Check if it's in the imported bubble classes
  if (importedBubbleClasses.has(className)) {
    return true;
  }

  // Fallback: check naming pattern
  // Bubble classes typically end with "Bubble" or "Tool" (but not StructuredTool)
  const endsWithBubble = className.endsWith('Bubble');
  const endsWithTool =
    className.endsWith('Tool') && !className.includes('Structured');

  return (
    (endsWithBubble || endsWithTool) &&
    className !== 'BubbleFlow' &&
    className !== 'BaseBubble' &&
    !className.includes('Error') &&
    !className.includes('Exception') &&
    !className.includes('Validation')
  );
}

/**
 * Lint rule that prevents credentials parameter from being used in bubble instantiations
 */
export const noCredentialsParameterRule: LintRule = {
  name: 'no-credentials-parameter',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Traverse entire source file to find all bubble instantiations
    const visit = (node: ts.Node) => {
      // Check for new expressions (bubble instantiations)
      if (ts.isNewExpression(node)) {
        const className = getClassNameFromExpression(node.expression);
        if (
          className &&
          isBubbleClass(className, context.importedBubbleClasses)
        ) {
          // Check constructor arguments for credentials parameter
          if (node.arguments && node.arguments.length > 0) {
            for (const arg of node.arguments) {
              const credentialError = checkForCredentialsParameter(
                arg,
                context.sourceFile
              );
              if (credentialError) {
                errors.push(credentialError);
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Checks if an expression (constructor argument) contains a credentials parameter
 */
function checkForCredentialsParameter(
  expression: ts.Expression,
  sourceFile: ts.SourceFile
): LintError | null {
  // Handle object literals: { credentials: {...} }
  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = property.name;
        if (
          (ts.isIdentifier(name) && name.text === 'credentials') ||
          (ts.isStringLiteral(name) && name.text === 'credentials')
        ) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            property.getStart(sourceFile)
          );
          return {
            line: line + 1,
            message:
              'credentials parameter is not allowed in bubble instantiation. Credentials should be injected at runtime, not passed as parameters.',
          };
        }
      }
      // Handle shorthand property: { credentials }
      if (ts.isShorthandPropertyAssignment(property)) {
        const name = property.name;
        if (ts.isIdentifier(name) && name.text === 'credentials') {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            property.getStart(sourceFile)
          );
          return {
            line: line + 1,
            message:
              'credentials parameter is not allowed in bubble instantiation. Credentials should be injected at runtime, not passed as parameters.',
          };
        }
      }
    }
  }

  // Handle spread expressions that might contain credentials
  if (ts.isSpreadElement(expression)) {
    return checkForCredentialsParameter(expression.expression, sourceFile);
  }

  // Handle type assertions: { credentials: {...} } as Record<string, string>
  if (ts.isAsExpression(expression)) {
    return checkForCredentialsParameter(expression.expression, sourceFile);
  }

  // Handle parenthesized expressions: ({ credentials: {...} })
  if (ts.isParenthesizedExpression(expression)) {
    return checkForCredentialsParameter(expression.expression, sourceFile);
  }

  return null;
}

/**
 * Lint rule that prevents usage of process.env
 */
export const noProcessEnvRule: LintRule = {
  name: 'no-process-env',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Traverse entire source file to find all process.env usages
    const visit = (node: ts.Node) => {
      // Check for property access expression: process.env
      if (ts.isPropertyAccessExpression(node)) {
        const object = node.expression;
        const property = node.name;

        // Check if it's process.env
        if (
          ts.isIdentifier(object) &&
          object.text === 'process' &&
          ts.isIdentifier(property) &&
          property.text === 'env'
        ) {
          const { line, character } =
            context.sourceFile.getLineAndCharacterOfPosition(
              node.getStart(context.sourceFile)
            );
          errors.push({
            line: line + 1,
            column: character + 1,
            message:
              'process.env is not allowed. Put the credential inside payload if the integration is not supported yet (service is not an available bubble).',
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Lint rule that prevents method invocations inside complex expressions
 */
export const noMethodInvocationInComplexExpressionRule: LintRule = {
  name: 'no-method-invocation-in-complex-expression',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Track parent nodes to detect complex expressions
    const visitWithParents = (node: ts.Node, parents: ts.Node[] = []): void => {
      // Check for method calls: this.methodName()
      if (ts.isCallExpression(node)) {
        if (ts.isPropertyAccessExpression(node.expression)) {
          const object = node.expression.expression;
          // Check if it's 'this' keyword (SyntaxKind.ThisKeyword)
          if (object.kind === ts.SyntaxKind.ThisKeyword) {
            // This is a method invocation: this.methodName()
            // Check if any parent is a complex expression
            const complexParent = findComplexExpressionParent(parents, node);
            if (complexParent) {
              const { line, character } =
                context.sourceFile.getLineAndCharacterOfPosition(
                  node.getStart(context.sourceFile)
                );
              const methodName = node.expression.name.text;
              const parentType = getReadableParentType(complexParent);
              errors.push({
                line: line + 1,
                column: character + 1,
                message: `Method invocation 'this.${methodName}()' inside ${parentType} cannot be instrumented. Extract to a separate variable before using in ${parentType}.`,
              });
            }
          }
        }
      }

      // Recursively visit children with updated parent chain
      ts.forEachChild(node, (child) => {
        visitWithParents(child, [...parents, node]);
      });
    };

    visitWithParents(context.sourceFile);
    return errors;
  },
};

/**
 * Finds if any parent node is a complex expression that cannot contain instrumented calls
 */
function findComplexExpressionParent(
  parents: ts.Node[],
  node: ts.Node
): ts.Node | null {
  // Walk through parents to find complex expressions
  // Stop at statement boundaries (these are safe)
  let currentChild: ts.Node | null = node;
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];

    // Stop at statement boundaries - these are safe contexts
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isExpressionStatement(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isBlock(parent)
    ) {
      return null;
    }

    // Check for complex expressions
    if (ts.isConditionalExpression(parent)) {
      return parent; // Ternary operator
    }
    if (ts.isObjectLiteralExpression(parent)) {
      return parent; // Object literal
    }
    if (ts.isArrayLiteralExpression(parent)) {
      if (
        currentChild &&
        isPromiseAllArrayElement(parent, currentChild as ts.Expression)
      ) {
        currentChild = parent;
        continue;
      }
      return parent; // Array literal
    }
    if (ts.isPropertyAssignment(parent)) {
      return parent; // Object property value
    }
    if (ts.isSpreadElement(parent)) {
      return parent; // Spread expression
    }

    currentChild = parent;
  }

  return null;
}

/**
 * Gets a human-readable description of the parent node type
 */
function getReadableParentType(node: ts.Node): string {
  if (ts.isConditionalExpression(node)) {
    return 'ternary operator';
  }
  if (ts.isObjectLiteralExpression(node)) {
    return 'object literal';
  }
  if (ts.isArrayLiteralExpression(node)) {
    return 'array literal';
  }
  if (ts.isPropertyAssignment(node)) {
    return 'object property';
  }
  if (ts.isSpreadElement(node)) {
    return 'spread expression';
  }
  return 'complex expression';
}

function isPromiseAllArrayElement(
  arrayNode: ts.ArrayLiteralExpression,
  childNode: ts.Expression
): boolean {
  if (!arrayNode.elements.some((element) => element === childNode)) {
    return false;
  }

  if (!arrayNode.parent || !ts.isCallExpression(arrayNode.parent)) {
    return false;
  }

  const callExpr = arrayNode.parent;
  const callee = callExpr.expression;

  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Promise' ||
    callee.name.text !== 'all'
  ) {
    return false;
  }

  return callExpr.arguments.length > 0 && callExpr.arguments[0] === arrayNode;
}

/**
 * Lint rule that prevents try-catch statements in the handle method
 * Try-catch blocks interfere with runtime instrumentation and error handling
 */
export const noTryCatchInHandleRule: LintRule = {
  name: 'no-try-catch-in-handle',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    if (!context.handleMethodBody) {
      return errors; // No handle method body found, skip this rule
    }

    // Recursively find all try statements in the handle method body
    const findTryStatements = (node: ts.Node): void => {
      if (ts.isTryStatement(node)) {
        const { line } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile)
        );
        errors.push({
          line: line + 1,
          message:
            'try-catch statements are not allowed in handle method. Error handling should be done in function steps.',
        });
        // Don't return early - continue checking nested content for multiple violations
      }

      ts.forEachChild(node, findTryStatements);
    };

    // Start recursive search from the handle method body
    findTryStatements(context.handleMethodBody);

    return errors;
  },
};

/**
 * Lint rule that prevents methods from calling other methods
 * Methods should only be called from the handle method, not from other methods
 */
export const noMethodCallingMethodRule: LintRule = {
  name: 'no-method-calling-method',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    if (!context.bubbleFlowClass) {
      return errors; // No BubbleFlow class found, skip this rule
    }

    // Find all methods in the BubbleFlow class
    const methods: ts.MethodDeclaration[] = [];
    if (context.bubbleFlowClass.members) {
      for (const member of context.bubbleFlowClass.members) {
        if (ts.isMethodDeclaration(member)) {
          // Skip the handle method - it's allowed to call other methods
          const methodName = member.name;
          if (ts.isIdentifier(methodName) && methodName.text === 'handle') {
            continue;
          }
          methods.push(member);
        }
      }
    }

    // For each method, check if it calls other methods
    for (const method of methods) {
      if (!method.body || !ts.isBlock(method.body)) {
        continue;
      }

      const methodCallErrors = findMethodCallsInNode(
        method.body,
        context.sourceFile
      );
      errors.push(...methodCallErrors);
    }

    return errors;
  },
};

/**
 * Recursively finds all method calls (this.methodName()) in a node
 */
function findMethodCallsInNode(
  node: ts.Node,
  sourceFile: ts.SourceFile
): LintError[] {
  const errors: LintError[] = [];

  const visit = (n: ts.Node) => {
    // Check for call expressions: this.methodName()
    if (ts.isCallExpression(n)) {
      if (ts.isPropertyAccessExpression(n.expression)) {
        const object = n.expression.expression;
        // Check if it's 'this' keyword (SyntaxKind.ThisKeyword)
        if (object.kind === ts.SyntaxKind.ThisKeyword) {
          const methodName = n.expression.name.text;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            n.getStart(sourceFile)
          );
          errors.push({
            line: line + 1,
            column: character + 1,
            message: `Method 'this.${methodName}()' cannot be called from another method. Methods should only be called from the handle method.`,
          });
        }
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(node);
  return errors;
}

/**
 * Lint rule that prevents usage of 'any' type
 * Using 'any' bypasses TypeScript's type checking and should be avoided
 */
export const noAnyTypeRule: LintRule = {
  name: 'no-any-type',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const visit = (node: ts.Node) => {
      // Check for 'any' keyword in type nodes
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const { line, character } =
          context.sourceFile.getLineAndCharacterOfPosition(
            node.getStart(context.sourceFile)
          );
        errors.push({
          line: line + 1,
          column: character + 1,
          message:
            "Type 'any' is not allowed. Use a specific type, 'unknown', or a generic type parameter instead.",
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Lint rule that prevents multiple BubbleFlow classes in a single file
 * Only one class extending BubbleFlow is allowed per file for proper runtime instrumentation
 */
export const singleBubbleFlowClassRule: LintRule = {
  name: 'single-bubbleflow-class',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];
    const bubbleFlowClasses: { name: string; line: number }[] = [];

    // Traverse the entire source file to find all BubbleFlow class declarations
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
              for (const type of clause.types) {
                if (ts.isIdentifier(type.expression)) {
                  if (type.expression.text === 'BubbleFlow') {
                    const { line } =
                      context.sourceFile.getLineAndCharacterOfPosition(
                        node.getStart(context.sourceFile)
                      );
                    const className = node.name?.text || 'Anonymous';
                    bubbleFlowClasses.push({ name: className, line: line + 1 });
                  }
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);

    // If more than one BubbleFlow class found, report errors for all except the first
    if (bubbleFlowClasses.length > 1) {
      for (let i = 1; i < bubbleFlowClasses.length; i++) {
        const cls = bubbleFlowClasses[i];
        errors.push({
          line: cls.line,
          message: `Multiple BubbleFlow classes are not allowed. Found '${cls.name}' but '${bubbleFlowClasses[0].name}' already extends BubbleFlow. Remove the additional class or combine the flows into a single class.`,
        });
      }
    }

    return errors;
  },
};

/**
 * Mapping of trigger types to their expected payload type names
 * Used by the enforce-payload-type lint rule
 */
const TRIGGER_PAYLOAD_TYPE_MAP: Record<string, string> = {
  'slack/bot_mentioned': 'SlackMentionEvent',
  'slack/message_received': 'SlackMessageReceivedEvent',
  'slack/reaction_added': 'SlackReactionAddedEvent',
  'schedule/cron': 'CronEvent',
  'webhook/http': 'WebhookEvent',
};

/**
 * Set of all base trigger event type names.
 * Used to detect when a user uses the wrong base type (e.g., CronEvent for a Slack trigger).
 */
const BASE_TRIGGER_EVENT_TYPES = new Set(
  Object.values(TRIGGER_PAYLOAD_TYPE_MAP)
);

/**
 * Lint rule that enforces proper payload typing for BubbleFlow<TriggerType>
 *
 * When a class extends BubbleFlow<'slack/bot_mentioned'>, the handle() method's
 * payload parameter must be typed with the correct event type (e.g., SlackMentionEvent)
 * from BubbleTriggerEventRegistry, not 'any' or an incompatible type.
 *
 * This is a blocking error - mismatched types will prevent the flow from being saved.
 */
export const enforcePayloadTypeRule: LintRule = {
  name: 'enforce-payload-type',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Skip if no BubbleFlow class or handle method found
    if (!context.bubbleFlowClass || !context.handleMethod) {
      return errors;
    }

    // Skip if no trigger type extracted
    if (!context.bubbleFlowTriggerType) {
      return errors;
    }

    // Get the expected payload type for this trigger
    const expectedTypeName =
      TRIGGER_PAYLOAD_TYPE_MAP[context.bubbleFlowTriggerType];
    if (!expectedTypeName) {
      // Unknown trigger type, skip validation
      return errors;
    }

    // Check the handle method's first parameter
    const parameters = context.handleMethod.parameters;
    if (parameters.length === 0) {
      const { line } = context.sourceFile.getLineAndCharacterOfPosition(
        context.handleMethod.getStart(context.sourceFile)
      );
      errors.push({
        line: line + 1,
        message: `handle() method must have a payload parameter typed as '${expectedTypeName}' for trigger type '${context.bubbleFlowTriggerType}'.`,
      });
      return errors;
    }

    const firstParam = parameters[0];
    const typeAnnotation = firstParam.type;

    // Check if parameter has no type annotation
    if (!typeAnnotation) {
      const { line } = context.sourceFile.getLineAndCharacterOfPosition(
        firstParam.getStart(context.sourceFile)
      );
      errors.push({
        line: line + 1,
        message: `Payload parameter must be typed as '${expectedTypeName}' for trigger type '${context.bubbleFlowTriggerType}'. Add explicit type annotation.`,
      });
      return errors;
    }

    // Check for 'any' type
    if (typeAnnotation.kind === ts.SyntaxKind.AnyKeyword) {
      const { line } = context.sourceFile.getLineAndCharacterOfPosition(
        typeAnnotation.getStart(context.sourceFile)
      );
      errors.push({
        line: line + 1,
        message: `Payload type 'any' is not allowed. Use '${expectedTypeName}' for trigger type '${context.bubbleFlowTriggerType}'.`,
      });
      return errors;
    }

    // Check if the type is a reference type and matches expected
    if (ts.isTypeReferenceNode(typeAnnotation)) {
      const typeName = typeAnnotation.typeName;
      let actualTypeName: string | null = null;

      if (ts.isIdentifier(typeName)) {
        actualTypeName = typeName.text;
      } else if (ts.isQualifiedName(typeName)) {
        // Handle qualified names like Namespace.Type
        actualTypeName = typeName.right.text;
      }

      if (actualTypeName && actualTypeName !== expectedTypeName) {
        // Allow custom interfaces that extend the base trigger event.
        // We only error if the type is a DIFFERENT base trigger event type.
        // e.g., using CronEvent for a Slack trigger is an error,
        // but using MyCustomSlackPayload (which extends SlackMentionEvent) is allowed.
        if (BASE_TRIGGER_EVENT_TYPES.has(actualTypeName)) {
          // Using a different base trigger event type - this is an error
          const { line } = context.sourceFile.getLineAndCharacterOfPosition(
            typeAnnotation.getStart(context.sourceFile)
          );
          errors.push({
            line: line + 1,
            message: `Payload type mismatch: expected '${expectedTypeName}' (or a custom interface extending it) for trigger type '${context.bubbleFlowTriggerType}', but found '${actualTypeName}'.`,
          });
        }
        // Otherwise, it's a custom interface - allow it (parser will handle extraction)
      }
    }

    // Check for indexed access type: BubbleTriggerEventRegistry['slack/bot_mentioned']
    if (ts.isIndexedAccessTypeNode(typeAnnotation)) {
      const objectType = typeAnnotation.objectType;
      const indexType = typeAnnotation.indexType;

      // Verify it's BubbleTriggerEventRegistry
      if (
        ts.isTypeReferenceNode(objectType) &&
        ts.isIdentifier(objectType.typeName) &&
        objectType.typeName.text === 'BubbleTriggerEventRegistry'
      ) {
        // Verify the index matches the trigger type
        if (
          ts.isLiteralTypeNode(indexType) &&
          ts.isStringLiteral(indexType.literal)
        ) {
          const indexValue = indexType.literal.text;
          if (indexValue !== context.bubbleFlowTriggerType) {
            const { line } = context.sourceFile.getLineAndCharacterOfPosition(
              typeAnnotation.getStart(context.sourceFile)
            );
            errors.push({
              line: line + 1,
              message: `Payload type mismatch: indexed access uses '${indexValue}' but BubbleFlow extends '${context.bubbleFlowTriggerType}'.`,
            });
          }
        }
      }
    }

    return errors;
  },
};

/**
 * Lint rule that bans casting the payload parameter to a different type inside handle().
 *
 * This pattern defeats the type system and prevents the parser from extracting custom fields:
 *
 * BAD:
 * ```typescript
 * interface MyPayload extends SlackMentionEvent { customField: string; }
 * async handle(payload: SlackMentionEvent) {
 *   const { customField } = payload as MyPayload; // Cast inside - BAD!
 * }
 * ```
 *
 * GOOD:
 * ```typescript
 * interface MyPayload extends SlackMentionEvent { customField: string; }
 * async handle(payload: MyPayload) { // Use custom type directly
 *   const { customField } = payload; // No cast needed
 * }
 * ```
 */
export const noCastPayloadInHandleRule: LintRule = {
  name: 'no-cast-payload-in-handle',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    // Skip if no handle method or body
    if (!context.handleMethod || !context.handleMethodBody) {
      return errors;
    }

    // Get the payload parameter name
    const parameters = context.handleMethod.parameters;
    if (parameters.length === 0) {
      return errors;
    }

    const firstParam = parameters[0];
    let payloadParamName: string | null = null;

    if (ts.isIdentifier(firstParam.name)) {
      payloadParamName = firstParam.name.text;
    }

    if (!payloadParamName) {
      return errors;
    }

    // Get the declared type of the payload parameter
    const paramType = firstParam.type;
    let declaredTypeName: string | null = null;

    if (paramType && ts.isTypeReferenceNode(paramType)) {
      if (ts.isIdentifier(paramType.typeName)) {
        declaredTypeName = paramType.typeName.text;
      }
    }

    // Unwrap nested `as` expressions to get the innermost expression.
    // e.g. `payload.body as unknown as FlowInputs` → `payload.body`
    const unwrapAsExpressions = (node: ts.Expression): ts.Expression => {
      while (ts.isAsExpression(node)) {
        node = node.expression;
      }
      return node;
    };

    // Check if an expression references the payload parameter (directly or via property access).
    // Matches: `payload`, `payload.body`, `payload.something`
    const referencesPayload = (expr: ts.Expression): boolean => {
      if (ts.isIdentifier(expr) && expr.text === payloadParamName) {
        return true;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === payloadParamName
      ) {
        return true;
      }
      return false;
    };

    // Walk the handle method body looking for 'as' expressions on the payload
    const findPayloadCasts = (node: ts.Node): void => {
      // Check for type assertion: payload as SomeType or payload.body as unknown as SomeType
      if (ts.isAsExpression(node)) {
        const targetType = node.type;
        const innerExpr = unwrapAsExpressions(node);

        // Check if the innermost expression references the payload parameter
        if (referencesPayload(innerExpr)) {
          // Get the outermost target type name
          let targetTypeName: string | null = null;
          if (ts.isTypeReferenceNode(targetType)) {
            if (ts.isIdentifier(targetType.typeName)) {
              targetTypeName = targetType.typeName.text;
            }
          }

          // If casting to a different type than declared, report error
          if (targetTypeName && targetTypeName !== declaredTypeName) {
            const { line, character } =
              context.sourceFile.getLineAndCharacterOfPosition(
                node.getStart(context.sourceFile)
              );

            // Tailor the message for payload.body casts vs direct payload casts
            const isBodyAccess =
              ts.isPropertyAccessExpression(innerExpr) &&
              innerExpr.name.text === 'body';
            const fixHint = isBodyAccess
              ? `Do not access payload.body and cast it. Instead, declare your input fields by extending the trigger event type: 'export interface ${targetTypeName} extends ${declaredTypeName ?? 'WebhookEvent'} { ... }' and use it as the parameter type: handle(payload: ${targetTypeName}).`
              : `Do not cast payload to '${targetTypeName}' inside handle(). Instead, use '${targetTypeName}' as the parameter type directly: handle(payload: ${targetTypeName}).`;

            errors.push({
              line: line + 1,
              column: character + 1,
              message: `${fixHint} This allows the parser to extract custom fields from your payload interface.`,
            });
          }
        }
      }

      ts.forEachChild(node, findPayloadCasts);
    };

    findPayloadCasts(context.handleMethodBody);

    return errors;
  },
};

/**
 * Property names that accept Zod schemas for structured output.
 * - expectedOutputSchema: Used by AIAgentBubble
 * - expectedResultSchema: Used by ResearchAgentTool
 */
const SCHEMA_PROPERTY_NAMES = [
  'expectedOutputSchema',
  'expectedResultSchema',
] as const;

/**
 * Lint rule that prevents calling .toString() on Zod schemas for expectedOutputSchema/expectedResultSchema.
 *
 * Calling .toString() on a Zod schema returns a useless string like "ZodObject"
 * instead of the actual JSON schema. This causes the AI to not follow the expected
 * output structure.
 *
 * BAD:
 * ```typescript
 * expectedOutputSchema: z.object({ companies: z.array(...) }).toString()
 * expectedResultSchema: z.object({ result: z.string() }).toString()
 * ```
 *
 * GOOD:
 * ```typescript
 * expectedOutputSchema: z.object({ companies: z.array(...) })
 * expectedResultSchema: z.object({ result: z.string() })
 * ```
 */
export const noToStringOnExpectedOutputSchemaRule: LintRule = {
  name: 'no-tostring-on-expected-output-schema',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const visit = (node: ts.Node): void => {
      // Look for property assignments: expectedOutputSchema/expectedResultSchema: <value>
      if (ts.isPropertyAssignment(node)) {
        const propName = node.name;
        let matchedPropName: string | null = null;

        if (ts.isIdentifier(propName)) {
          if (
            SCHEMA_PROPERTY_NAMES.includes(
              propName.text as (typeof SCHEMA_PROPERTY_NAMES)[number]
            )
          ) {
            matchedPropName = propName.text;
          }
        } else if (ts.isStringLiteral(propName)) {
          if (
            SCHEMA_PROPERTY_NAMES.includes(
              propName.text as (typeof SCHEMA_PROPERTY_NAMES)[number]
            )
          ) {
            matchedPropName = propName.text;
          }
        }

        if (matchedPropName) {
          // Check if the value is a call expression ending with .toString()
          const value = node.initializer;
          if (ts.isCallExpression(value)) {
            const callee = value.expression;
            if (
              ts.isPropertyAccessExpression(callee) &&
              callee.name.text === 'toString'
            ) {
              const { line, character } =
                context.sourceFile.getLineAndCharacterOfPosition(
                  value.getStart(context.sourceFile)
                );
              errors.push({
                line: line + 1,
                column: character + 1,
                message: `Do not call .toString() on Zod schemas for ${matchedPropName}. Pass the Zod schema directly: ${matchedPropName}: z.object({ ... })`,
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Lint rule that prevents calling JSON.stringify() on Zod schemas for expectedOutputSchema/expectedResultSchema.
 *
 * JSON.stringify() on a Zod schema returns unusable JSON representation of the schema object
 * instead of the actual JSON schema format needed for AI structured output.
 *
 * BAD:
 * ```typescript
 * expectedOutputSchema: JSON.stringify(z.object({ ... }))
 * expectedResultSchema: JSON.stringify(z.object({ ... }))
 * ```
 *
 * GOOD:
 * ```typescript
 * expectedOutputSchema: z.object({ ... })
 * expectedResultSchema: z.object({ ... })
 * ```
 */
export const noJsonStringifyOnExpectedOutputSchemaRule: LintRule = {
  name: 'no-json-stringify-on-expected-output-schema',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const visit = (node: ts.Node): void => {
      // Look for property assignments: expectedOutputSchema/expectedResultSchema: <value>
      if (ts.isPropertyAssignment(node)) {
        const propName = node.name;
        let matchedPropName: string | null = null;

        if (ts.isIdentifier(propName)) {
          if (
            SCHEMA_PROPERTY_NAMES.includes(
              propName.text as (typeof SCHEMA_PROPERTY_NAMES)[number]
            )
          ) {
            matchedPropName = propName.text;
          }
        } else if (ts.isStringLiteral(propName)) {
          if (
            SCHEMA_PROPERTY_NAMES.includes(
              propName.text as (typeof SCHEMA_PROPERTY_NAMES)[number]
            )
          ) {
            matchedPropName = propName.text;
          }
        }

        if (matchedPropName) {
          // Check if the value is JSON.stringify(...)
          const value = node.initializer;
          if (ts.isCallExpression(value)) {
            const callee = value.expression;
            if (
              ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              callee.expression.text === 'JSON' &&
              callee.name.text === 'stringify'
            ) {
              const { line, character } =
                context.sourceFile.getLineAndCharacterOfPosition(
                  value.getStart(context.sourceFile)
                );
              errors.push({
                line: line + 1,
                column: character + 1,
                message: `Do not call JSON.stringify() on Zod schemas for ${matchedPropName}. Pass the Zod schema directly: ${matchedPropName}: z.object({ ... })`,
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Lint rule that prevents capabilities from having inline `inputs`.
 *
 * Capability inputs should be configured by the user via the Capabilities UI,
 * not hardcoded in the flow code. The runtime injects input values at execution time.
 *
 * BAD:
 * ```typescript
 * capabilities: [{ id: 'knowledge-base', inputs: { sources: [`google-doc:${docId}:edit`] } }]
 * ```
 *
 * GOOD:
 * ```typescript
 * capabilities: [{ id: 'knowledge-base' }]
 * ```
 */
export const noCapabilityInputsRule: LintRule = {
  name: 'no-capability-inputs',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const visit = (node: ts.Node): void => {
      // Look for property assignments named 'capabilities'
      if (ts.isPropertyAssignment(node)) {
        const propName = node.name;
        const isCapabilities =
          (ts.isIdentifier(propName) && propName.text === 'capabilities') ||
          (ts.isStringLiteral(propName) && propName.text === 'capabilities');

        if (isCapabilities) {
          // Check if the value is an array literal
          const value = node.initializer;
          if (ts.isArrayLiteralExpression(value)) {
            for (const element of value.elements) {
              checkCapabilityObjectForInputs(
                element,
                context.sourceFile,
                errors
              );
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Checks whether a node is a pure constant expression (no variable references).
 * Allows: string/number/boolean literals, object literals with constant values,
 * array literals with constant values, template literals without expressions.
 * Disallows: identifiers (variables), template expressions, call expressions, etc.
 */
function isConstantExpression(node: ts.Node): boolean {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((el) => isConstantExpression(el));
  }

  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) {
        return isConstantExpression(prop.initializer);
      }
      // Spread, shorthand, etc. are not constant
      return false;
    });
  }

  return false;
}

/**
 * Checks if a capability object literal contains an 'inputs' property
 * that references variables. Constant/literal inputs are allowed.
 */
function checkCapabilityObjectForInputs(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  errors: LintError[]
): void {
  if (!ts.isObjectLiteralExpression(node)) return;

  // Verify this looks like a capability object (has an 'id' property)
  let hasIdProperty = false;
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      if (
        (ts.isIdentifier(name) && name.text === 'id') ||
        (ts.isStringLiteral(name) && name.text === 'id')
      ) {
        hasIdProperty = true;
        break;
      }
    }
  }

  if (!hasIdProperty) return;

  // Now check for 'inputs' property — only flag if the value contains variables
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const name = prop.name;
      if (
        (ts.isIdentifier(name) && name.text === 'inputs') ||
        (ts.isStringLiteral(name) && name.text === 'inputs')
      ) {
        // Allow constant/literal inputs — only flag variable references
        if (isConstantExpression(prop.initializer)) {
          continue;
        }

        const { line } = sourceFile.getLineAndCharacterOfPosition(
          prop.getStart(sourceFile)
        );
        errors.push({
          line: line + 1,
          message:
            "Capability 'inputs' should not reference variables in code. Use constant values only, or remove the inputs property and configure capability inputs in the Capabilities panel. Also remove all references of this variable if it is only used for the agent (commonly flow input).",
        });
      }
    }
  }
}

/**
 * Lint rule that requires a literal cronSchedule class property when the
 * trigger is 'schedule/cron'.
 *
 * Without this rule, a cron flow with a missing/invalid cronSchedule passes
 * validateBubbleFlow (all lint rules green) and only fails later at
 * validateAndExtract/save. Surfacing it at validity time lets the generation
 * loop fix it before shipping.
 *
 * Mirrors the parser (BubbleScript.getBubbleTriggerEventType): only a plain
 * string-literal initializer on a class property named 'cronSchedule' is
 * extracted, so template literals and computed values are rejected here too.
 */
export const requireCronScheduleRule: LintRule = {
  name: 'require-cron-schedule',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    if (context.bubbleFlowTriggerType !== 'schedule/cron') {
      return errors;
    }
    if (!context.bubbleFlowClass) {
      return errors;
    }

    const cls: ts.ClassDeclaration = context.bubbleFlowClass;
    let cronProperty: ts.PropertyDeclaration | null = null;
    for (const member of cls.members) {
      if (
        ts.isPropertyDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'cronSchedule'
      ) {
        cronProperty = member;
        break;
      }
    }

    if (!cronProperty) {
      const { line } = context.sourceFile.getLineAndCharacterOfPosition(
        cls.getStart(context.sourceFile)
      );
      errors.push({
        line: line + 1,
        message:
          "Trigger 'schedule/cron' requires a cronSchedule class property. Declare it inside the class as: readonly cronSchedule = '0 0 * * *'; (cron expression in UTC).",
      });
      return errors;
    }

    const { line } = context.sourceFile.getLineAndCharacterOfPosition(
      cronProperty.getStart(context.sourceFile)
    );

    const initializer = cronProperty.initializer;
    if (!initializer || !ts.isStringLiteral(initializer)) {
      errors.push({
        line: line + 1,
        message:
          "cronSchedule must be a plain string literal cron expression (e.g. readonly cronSchedule = '0 0 * * *';). Computed values and template literals are not extracted by the parser.",
      });
      return errors;
    }

    if (!validateCronExpression(initializer.text).valid) {
      errors.push({
        line: line + 1,
        message: `Invalid cron expression '${initializer.text}' in cronSchedule. Use a valid cron expression in UTC, e.g. readonly cronSchedule = '0 0 * * *';`,
      });
    }

    return errors;
  },
};

/**
 * Lint rule that requires a custom payload interface to extend the trigger's
 * base event type (WebhookEvent, CronEvent, SlackMentionEvent, ...).
 *
 * enforce-payload-type allows any custom interface name; if that interface
 * does not extend the trigger event, lint passes silently but the studio
 * cannot extract the flow's input schema. This rule closes that hole by
 * resolving the interface/type-alias chain declared in the file and checking
 * it reaches the expected base event type.
 *
 * Types declared outside the file (imports) are skipped - they cannot be
 * verified statically here.
 */
export const payloadMustExtendTriggerEventRule: LintRule = {
  name: 'payload-must-extend-trigger-event',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    if (!context.handleMethod || !context.bubbleFlowTriggerType) {
      return errors;
    }

    const expectedTypeName =
      TRIGGER_PAYLOAD_TYPE_MAP[context.bubbleFlowTriggerType];
    if (!expectedTypeName) {
      return errors; // Unknown trigger type, skip
    }

    const parameters = context.handleMethod.parameters;
    if (parameters.length === 0) {
      return errors; // enforce-payload-type reports missing parameter
    }

    const typeAnnotation = parameters[0].type;
    // Missing/any/indexed-access annotations are handled by enforce-payload-type
    if (!typeAnnotation || !ts.isTypeReferenceNode(typeAnnotation)) {
      return errors;
    }
    if (!ts.isIdentifier(typeAnnotation.typeName)) {
      return errors;
    }

    const payloadTypeName = typeAnnotation.typeName.text;
    // Using a base trigger event type directly (right or wrong one) is
    // already fully checked by enforce-payload-type
    if (BASE_TRIGGER_EVENT_TYPES.has(payloadTypeName)) {
      return errors;
    }

    // Collect interface and type alias declarations in this file
    const interfaces = new Map<string, ts.InterfaceDeclaration>();
    const aliases = new Map<string, ts.TypeAliasDeclaration>();
    const collect = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        interfaces.set(node.name.text, node);
      } else if (ts.isTypeAliasDeclaration(node)) {
        aliases.set(node.name.text, node);
      }
      ts.forEachChild(node, collect);
    };
    collect(context.sourceFile);

    if (!interfaces.has(payloadTypeName) && !aliases.has(payloadTypeName)) {
      return errors; // Declared elsewhere (import); cannot verify statically
    }

    // Walk the extends/alias chain looking for the expected base event type
    const reachesExpectedBase = (
      typeName: string,
      visited: Set<string>
    ): boolean => {
      if (typeName === expectedTypeName) {
        return true;
      }
      if (visited.has(typeName)) {
        return false;
      }
      visited.add(typeName);

      const iface = interfaces.get(typeName);
      if (iface) {
        for (const clause of iface.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const heritageType of clause.types) {
            if (
              ts.isIdentifier(heritageType.expression) &&
              reachesExpectedBase(heritageType.expression.text, visited)
            ) {
              return true;
            }
          }
        }
        return false;
      }

      const alias = aliases.get(typeName);
      if (alias) {
        return typeNodeReachesExpectedBase(alias.type, visited);
      }

      return false;
    };

    const typeNodeReachesExpectedBase = (
      typeNode: ts.TypeNode,
      visited: Set<string>
    ): boolean => {
      if (
        ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName)
      ) {
        return reachesExpectedBase(typeNode.typeName.text, visited);
      }
      if (ts.isIntersectionTypeNode(typeNode)) {
        return typeNode.types.some((t) =>
          typeNodeReachesExpectedBase(t, visited)
        );
      }
      return false;
    };

    if (!reachesExpectedBase(payloadTypeName, new Set<string>())) {
      const { line } = context.sourceFile.getLineAndCharacterOfPosition(
        typeAnnotation.getStart(context.sourceFile)
      );
      errors.push({
        line: line + 1,
        message: `Payload type '${payloadTypeName}' must extend '${expectedTypeName}' for trigger '${context.bubbleFlowTriggerType}'. Declare it as: export interface ${payloadTypeName} extends ${expectedTypeName} { ... }. Without this the studio cannot extract the flow's input schema.`,
      });
    }

    return errors;
  },
};

/**
 * Lint rule that catches throw statements NESTED anywhere inside handle().
 *
 * no-throw-in-handle only checks direct statements of the handle body (and
 * direct if-then/else throws), so a throw wrapped in a block, loop, try, or
 * callback escapes it. This rule deep-scans the handle body and reports every
 * throw the shallow rule does not, without double-reporting.
 */
export const noNestedThrowInHandleRule: LintRule = {
  name: 'no-nested-throw-in-handle',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const body = context.handleMethodBody;
    if (!body) {
      return errors;
    }

    // Throws already reported by the shallow no-throw-in-handle rule:
    // a direct statement of the body, or the direct (non-block) then/else
    // of an if statement that is itself a direct statement of the body.
    const isShallowReported = (throwStmt: ts.ThrowStatement): boolean => {
      const parent = throwStmt.parent;
      if (parent === body) {
        return true;
      }
      if (
        parent &&
        ts.isIfStatement(parent) &&
        parent.parent === body &&
        (parent.thenStatement === throwStmt ||
          parent.elseStatement === throwStmt)
      ) {
        return true;
      }
      return false;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node) && !isShallowReported(node)) {
        const { line } = context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile)
        );
        errors.push({
          line: line + 1,
          message:
            'throw statements are not allowed anywhere inside the handle method (including nested blocks, loops, and callbacks). Return a result object from handle, or move error handling into a private method.',
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(body);
    return errors;
  },
};

/**
 * Lint rule that bans type casts: `expr as T`, `expr as unknown as T`,
 * `expr as any`, and `<T>expr`. Only `as const` assertions are allowed.
 *
 * A cast makes the type checker agree with a shape the runtime never
 * produces; bubble results are Zod-parsed against their declared schema, so
 * the laundered shape fails in the user's run instead of at validation. The
 * common offender is `JSON.parse(...) as T`, which silently widens `any`
 * into a claimed shape.
 */
export const noWideningCastRule: LintRule = {
  name: 'no-widening-cast',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const isConstAssertion = (node: ts.AsExpression): boolean =>
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.type.typeName.text === 'const';

    // Report only the outermost cast of an `x as unknown as T` chain
    const isInnerCastOfChain = (node: ts.AsExpression): boolean => {
      let parent: ts.Node = node.parent;
      while (parent && ts.isParenthesizedExpression(parent)) {
        parent = parent.parent;
      }
      return parent !== undefined && ts.isAsExpression(parent);
    };

    const unwrapCastChain = (
      node: ts.Expression
    ): { inner: ts.Expression; laundersViaUnknownOrAny: boolean } => {
      let laundersViaUnknownOrAny = false;
      let current: ts.Expression = node;
      while (
        ts.isAsExpression(current) ||
        ts.isParenthesizedExpression(current)
      ) {
        if (ts.isAsExpression(current)) {
          if (
            current.type.kind === ts.SyntaxKind.UnknownKeyword ||
            current.type.kind === ts.SyntaxKind.AnyKeyword
          ) {
            laundersViaUnknownOrAny = true;
          }
        }
        current = current.expression;
      }
      return { inner: current, laundersViaUnknownOrAny };
    };

    const isJsonParseCall = (expr: ts.Expression): boolean =>
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === 'JSON' &&
      expr.expression.name.text === 'parse';

    const reportCast = (
      node: ts.Node,
      typeText: string,
      inner: ts.Expression,
      laundersViaUnknownOrAny: boolean
    ): void => {
      const { line, character } =
        context.sourceFile.getLineAndCharacterOfPosition(
          node.getStart(context.sourceFile)
        );
      const jsonParseHint = isJsonParseCall(inner)
        ? ' For JSON.parse results, declare the fields in the payload interface or narrow with typeof/in checks instead of casting.'
        : '';
      const launderHint = laundersViaUnknownOrAny
        ? ' Casting through unknown/any launders a type error instead of fixing it.'
        : '';
      errors.push({
        line: line + 1,
        column: character + 1,
        message: `Type cast 'as ${typeText}' is not allowed. Casts hide real type mismatches from validation and shift the failure into the user's run - fix the underlying type instead.${launderHint}${jsonParseHint}`,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node)) {
        if (!isConstAssertion(node) && !isInnerCastOfChain(node)) {
          const { inner, laundersViaUnknownOrAny } = unwrapCastChain(node);
          reportCast(
            node,
            node.type.getText(context.sourceFile),
            inner,
            laundersViaUnknownOrAny
          );
        }
      } else if (ts.isTypeAssertionExpression(node)) {
        // Angle-bracket assertion: <T>expr
        const { inner, laundersViaUnknownOrAny } = unwrapCastChain(
          node.expression
        );
        reportCast(
          node,
          node.type.getText(context.sourceFile),
          inner,
          laundersViaUnknownOrAny
        );
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Patterns that identify placeholder string values a user would have to
 * hand-edit in code. Each pattern is matched against the raw text of string
 * literals and no-substitution template literals.
 */
const PLACEHOLDER_STRING_PATTERNS: { pattern: RegExp; label: string }[] = [
  // YOUR_API_KEY, your_folder_id_here, YOUR-CHANNEL-ID ...
  { pattern: /\bYOUR[_-][A-Z0-9_-]{2,}\b/i, label: "'YOUR_*' placeholder" },
  // Whole string is one angle-bracketed uppercase token: <FOLDER_ID>, <YOUR-TOKEN>
  {
    pattern: /^<\s*[A-Z][A-Z0-9 _-]*\s*>$/,
    label: 'angle-bracket placeholder',
  },
  // Whole string is a TODO-style token
  {
    pattern:
      /^\s*(TODO|FIXME|TBD|CHANGE[-_ ]?ME|REPLACE[-_ ]?(ME|THIS)|PLACEHOLDER([-_ ]?(VALUE|HERE))?|INSERT[-_ ]?HERE)\s*[:.!]?\s*$/i,
    label: 'TODO-style placeholder',
  },
  // Whole string is an ALL_CAPS_..._HERE token: API_KEY_HERE, PASTE_ID_HERE
  {
    pattern: /^[A-Z][A-Z0-9_-]*[_-]HERE$/,
    label: "'*_HERE' placeholder",
  },
];

/**
 * Lint rule that flags placeholder string constants (YOUR_*, <LIKE_THIS>,
 * TODO-style tokens).
 *
 * A shipped placeholder is invisible to the mock run - the mocked write
 * succeeds regardless of the value - so the flow validates and test-runs
 * green, then fails in the user's hands. User-specific values belong in the
 * payload interface as JSDoc-documented inputs with realistic example
 * defaults.
 */
export const noPlaceholderValuesRule: LintRule = {
  name: 'no-placeholder-values',
  validate(context: LintRuleContext): LintError[] {
    const errors: LintError[] = [];

    const checkText = (node: ts.Node, text: string): void => {
      for (const { pattern, label } of PLACEHOLDER_STRING_PATTERNS) {
        if (pattern.test(text)) {
          const { line, character } =
            context.sourceFile.getLineAndCharacterOfPosition(
              node.getStart(context.sourceFile)
            );
          const shown = text.length > 40 ? `${text.slice(0, 40)}...` : text;
          errors.push({
            line: line + 1,
            column: character + 1,
            message: `Placeholder value '${shown}' (${label}) is not allowed. Move user-specific values into the payload interface as a JSDoc-documented input field with a realistic example default; constants may only hold truly static values.`,
          });
          return; // One report per literal is enough
        }
      }
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)
      ) {
        checkText(node, node.text);
      } else if (ts.isTemplateExpression(node)) {
        // Check the static chunks of `...${x}...` templates
        checkText(node, node.head.text);
        for (const span of node.templateSpans) {
          checkText(span.literal, span.literal.text);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(context.sourceFile);
    return errors;
  },
};

/**
 * Default registry instance with all rules registered
 */
export const defaultLintRuleRegistry = new LintRuleRegistry();
defaultLintRuleRegistry.register(noThrowInHandleRule);
defaultLintRuleRegistry.register(noDirectBubbleInstantiationInHandleRule);
defaultLintRuleRegistry.register(noCredentialsParameterRule);
defaultLintRuleRegistry.register(noMethodInvocationInComplexExpressionRule);
defaultLintRuleRegistry.register(noProcessEnvRule);
defaultLintRuleRegistry.register(noMethodCallingMethodRule);
defaultLintRuleRegistry.register(noTryCatchInHandleRule);
defaultLintRuleRegistry.register(noAnyTypeRule);
defaultLintRuleRegistry.register(singleBubbleFlowClassRule);
defaultLintRuleRegistry.register(enforcePayloadTypeRule);
defaultLintRuleRegistry.register(noCastPayloadInHandleRule);
defaultLintRuleRegistry.register(noToStringOnExpectedOutputSchemaRule);
defaultLintRuleRegistry.register(noJsonStringifyOnExpectedOutputSchemaRule);
defaultLintRuleRegistry.register(noCapabilityInputsRule);
defaultLintRuleRegistry.register(requireCronScheduleRule);
defaultLintRuleRegistry.register(payloadMustExtendTriggerEventRule);
defaultLintRuleRegistry.register(noNestedThrowInHandleRule);
defaultLintRuleRegistry.register(noWideningCastRule);
defaultLintRuleRegistry.register(noPlaceholderValuesRule);
