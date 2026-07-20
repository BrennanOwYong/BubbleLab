import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { IBubble, BubbleContext } from './bubble.js';
import type {
  BubbleResult,
  BubbleOperationResult,
  BubbleName,
  BubbleOperationMetadata,
  OperationSideEffectMetadata,
  SideEffect,
} from '@bubblelab/shared-schemas';
import { MockDataGenerator } from '@bubblelab/shared-schemas';
import type { DependencyGraphNode } from '@bubblelab/shared-schemas';
import {
  BubbleValidationError,
  BubbleExecutionError,
  FlowHaltedByPolicyError,
} from './bubble-errors.js';
import {
  sanitizeParams,
  resolveReaction,
  WorkflowEventBus,
} from '@bubblelab/shared-schemas';
import type {
  WorkflowEvent,
  WorkflowEventInput,
  WorkflowEventPolicy,
} from '@bubblelab/shared-schemas';
import { sanitizeErrorMessage } from '../utils/error-sanitizer.js';
import { formatSchemaExpectedVsActual } from '../utils/schema-comparison.js';
import type { OperationSideEffectMap } from './operation-side-effect.js';

/**
 * Abstract base class for all bubble types
 * Implements common properties and methods defined in IBubble interface
 */
export abstract class BaseBubble<
  TParams = unknown,
  TResult extends BubbleOperationResult = BubbleOperationResult,
> implements IBubble<TResult>
{
  public readonly name: string;
  public readonly schema: z.ZodObject<z.ZodRawShape>;
  public readonly resultSchema: z.ZodObject<z.ZodRawShape>;
  public readonly shortDescription: string;
  public readonly longDescription: string;
  public readonly alias?: string;
  public abstract readonly type:
    | 'service'
    | 'workflow'
    | 'tool'
    | 'ui'
    | 'infra';

  protected readonly params: TParams;
  protected context?: BubbleContext;
  public previousResult: BubbleResult<BubbleOperationResult> | undefined;
  protected readonly instanceId?: string;

  constructor(params: unknown, context?: BubbleContext, instanceId?: string) {
    // Use static properties from the class - typed as required static metadata
    const ctor = this.constructor as typeof BaseBubble & {
      readonly bubbleName: BubbleName;
      readonly schema: z.ZodObject<z.ZodRawShape>;
      readonly resultSchema: z.ZodObject<z.ZodRawShape>;
      readonly shortDescription: string;
      readonly longDescription: string;
      readonly alias?: string;
      readonly secret: boolean;
    };

    this.name = ctor.bubbleName;
    this.schema = ctor.schema;
    this.resultSchema = ctor.resultSchema;
    this.shortDescription = ctor.shortDescription;
    this.longDescription = ctor.longDescription;
    this.alias = ctor.alias;
    this.instanceId = instanceId;

    try {
      this.params = this.schema.parse(params) as TParams;
      const normalizedContext = context;
      // Enrich context with child variableId/currentUniqueId if dependencyGraph is provided
      if (
        normalizedContext &&
        normalizedContext.dependencyGraph &&
        normalizedContext.currentUniqueId
      ) {
        const next = this.computeChildContext(normalizedContext);
        this.context = next;
      } else {
        this.context = normalizedContext;
      }
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? `Input Schema validation failed: ${error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
          : `Input Schema validation failed: ${error instanceof Error ? error.message : 'Unknown validation error'}`;

      // Errors-as-events: input-schema deviations are emitted before the
      // existing throw (fire-and-forget — constructors cannot await). No
      // reaction applies here: an unconstructed bubble cannot continue/retry.
      const bus = context?.executionMeta?.eventBus;
      if (bus instanceof WorkflowEventBus) {
        void bus.emit({
          type: 'validation_deviation',
          code: 'INPUT_SCHEMA_VALIDATION_FAILED',
          severity: 'error',
          timestamp: new Date().toISOString(),
          stepId: context?.currentUniqueId ?? context?.invocationCallSiteKey,
          variableId: context?.variableId,
          bubbleName: ctor.bubbleName,
          message: sanitizeErrorMessage(errorMessage),
          errorClass: 'BubbleValidationError',
          payload: { phase: 'input' },
        });
      }

      throw new BubbleValidationError(errorMessage, {
        variableId: context?.variableId,
        bubbleName: ctor.bubbleName,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Compute child context based on dependency graph and current unique id.
   * Finds the node matching currentUniqueId, then determines this child's unique id as:
   * - If instanceId is provided: `${currentUniqueId}.${this.name}#${instanceId}`
   * - Otherwise: `${currentUniqueId}.${this.name}#k` for the next ordinal k
   * Assigns the variableId from the dependency graph if present, otherwise keeps parent's variableId.
   */
  private computeChildContext(parentContext: BubbleContext): BubbleContext {
    const graph = parentContext.dependencyGraph;
    const currentId = parentContext.currentUniqueId || '';
    if (!graph) return parentContext;

    // Depth-first search to find node by uniqueId
    const findByUniqueId = (
      node: DependencyGraphNode,
      target: string
    ): DependencyGraphNode | null => {
      if ((node as any).uniqueId === target) return node;
      for (const child of node.dependencies || []) {
        const found = findByUniqueId(child, target);
        if (found) return found;
      }
      return null;
    };

    const parentNode = currentId ? findByUniqueId(graph, currentId) : graph;

    // If the current bubble matches the node at currentUniqueId, don't advance; keep IDs from that node
    if (parentNode && parentNode.name === this.name) {
      const sameNodeVarId =
        parentContext.variableId ??
        (parentNode as unknown as { variableId?: number }).variableId ??
        parentContext.variableId;
      return {
        ...parentContext,
        variableId: sameNodeVarId,
        currentUniqueId: currentId,
        __uniqueIdCounters__: { ...(parentContext.__uniqueIdCounters__ || {}) },
      };
    }

    // Determine this bubble's identifier under the parent
    const children = parentNode?.dependencies || [];
    const counters = { ...(parentContext.__uniqueIdCounters__ || {}) };

    let selectedChild: DependencyGraphNode | undefined = undefined;

    // Use ordinal counter as before
    const counterKey = `${currentId || 'ROOT'}|${this.name}`;
    const ordinal = (counters[counterKey] || 0) + 1;
    const suffix = `#${ordinal}`;

    counters[counterKey] = ordinal;
    // Try to select the nth child by name for an exact uniqueId match
    const sameNameChildren = children.filter((c) => c.name === this.name);
    selectedChild = sameNameChildren[ordinal - 1];

    const childUniqueId =
      (selectedChild as unknown as { uniqueId?: string })?.uniqueId ||
      (currentId
        ? `${currentId}.${this.name}${suffix}`
        : `${this.name}${suffix}`);

    // Try to find a matching child node to get variableId; fallback to parent's
    let matchingChild = children.find(
      (c) => c.variableName === this.instanceId
    );
    // if no match is found fallback to || c.uniqueId === childUniqueId || c.name === this.name
    if (!matchingChild) {
      matchingChild = children.find(
        (c) => c.uniqueId === childUniqueId || c.name === this.name
      );
    }
    const childVariableId =
      (matchingChild && typeof matchingChild.variableId === 'number'
        ? matchingChild.variableId
        : parentContext.variableId) || parentContext.variableId;

    return {
      ...parentContext,
      variableId: childVariableId,
      currentUniqueId: childUniqueId,
      __uniqueIdCounters__: counters,
    };
  }

  /**
   * Doc-grounded side-effect classification of the CURRENT operation (IR-8).
   * Resolves the instance's `operation` param against the class's static
   * `operationMetadata` map (declared per operation, with provenance).
   * Fail-safe default: an unknown operation, a bubble without metadata, or a
   * bubble without an `operation` param classifies as 'write' — never assume
   * an unclassified operation is safe to run.
   */
  get sideEffect(): SideEffect {
    const ctor = this.constructor as {
      operationMetadata?: OperationSideEffectMap;
    };
    const metadata = ctor.operationMetadata;
    if (!metadata) return 'write';
    const operation = this.getOperationName();
    const hint =
      (operation !== undefined ? metadata[operation] : undefined) ??
      metadata['*'];
    return hint?.sideEffect ?? 'write';
  }

  /**
   * Full classification (with provenance: confidence, source, citation) for the
   * current operation, or undefined when the operation is unclassified.
   */
  get operationSideEffectMetadata(): OperationSideEffectMetadata | undefined {
    const ctor = this.constructor as typeof BaseBubble & {
      operationMetadata?: BubbleOperationMetadata;
    };
    const operation = (this.params as { operation?: unknown } | undefined)
      ?.operation;
    if (typeof operation !== 'string') return undefined;
    return ctor.operationMetadata?.[operation];
  }

  saveResult<R extends BubbleOperationResult>(result: BubbleResult<R>): void {
    this.previousResult = result as BubbleResult<BubbleOperationResult>;
  }

  clearSavedResult(): void {
    this.previousResult = undefined;
  }

  /**
   * Override toJSON to prevent credential leaking via JSON.stringify or console.log
   * Only exposes safe metadata, never params which may contain credentials
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      type: this.type,
      shortDescription: this.shortDescription,
      alias: this.alias,
      // Explicitly exclude params, context, and previousResult
      // These may contain sensitive credentials
    };
  }

  /**
   * Hook called before action execution. Subclasses can override to
   * transform params (e.g., inject memory, conversation history).
   * Runs BEFORE parameter logging so the logged params reflect overrides.
   */
  protected async beforeAction(): Promise<void> {
    // No-op by default — subclasses override as needed
  }

  /**
   * Execute the bubble - just runs the action
   */
  async action(): Promise<BubbleResult<TResult>> {
    const logger = this.context?.logger;

    // Run pre-action hook (e.g., AI agent injects memory/conversation)
    await this.beforeAction();

    // Log params AFTER beforeAction so overrides are captured
    logger?.logBubbleExecution(
      this.context?.variableId ?? -999,
      this.name,
      this.name,
      sanitizeParams(this.params as Record<string, unknown>)
    );
    // If we have a saved result, return it instead of executing
    if (this.previousResult) {
      logger?.debug(`[BubbleClass - ${this.name}] Returning saved result`);
      // Narrow saved base result to current TResult by keeping metadata and
      // treating data as unknown (caller side should only read known fields)
      const savedResult = this.previousResult as BubbleResult<TResult>;

      // Log bubble execution completion for saved result
      logger?.logBubbleExecutionComplete(
        this.context?.variableId ?? -999,
        this.name,
        this.name,
        savedResult
      );

      return savedResult;
    }

    // Errors-as-events: the step lifecycle starts here. Saved-result returns
    // above execute nothing, so they emit nothing.
    await this.emitWorkflowEvent({
      type: 'step_started',
      code: 'STEP_STARTED',
      severity: 'info',
      message: `Executing bubble ${this.name}`,
      payload: { operation: this.getOperationName() },
    });
    const stepStartedAt = Date.now();

    // TEST-MODE SWITCH — intercept ABOVE performAction so no client is ever
    // constructed and no credential is ever read, regardless of auth type.
    // Write-hinted operations (the fail-safe default for unclassified ones)
    // return a recorded or generated mock; read-hinted operations run for real.
    // An explicit per-call-site grant (approvedWriteCallSites) lets a write
    // execute for real in test mode.
    if (
      this.isTestModeRun() &&
      this.sideEffect !== 'read' &&
      !this.hasApprovedWriteGrant()
    ) {
      const operation = this.getOperationName();
      logger?.info(
        `[${this.name}] Test mode: operation '${operation ?? '(none)'}' is ` +
          `${this.sideEffect}-hinted — returning a mock result without executing. ` +
          `The operation DID NOT happen.`
      );

      const mockResult =
        (await this.getRecordedMock()) ?? this.generateTestModeMockResult();

      logger?.logBubbleExecutionComplete(
        this.context?.variableId ?? -999,
        this.name,
        this.name,
        mockResult
      );

      await this.emitWorkflowEvent({
        type: 'step_succeeded',
        code: 'STEP_SUCCEEDED',
        severity: 'info',
        message: `Bubble ${this.name} returned a test-mode mock`,
        payload: { durationMs: Date.now() - stepStartedAt, mocked: true },
      });

      return mockResult;
    }

    // Errors-as-events: the attempt loop wraps performAction + result
    // validation so a declared retry reaction can re-run the step. With no
    // policy the loop runs exactly once and every path below preserves the
    // pre-events behavior (same logs, same throws, same returns).
    const eventPolicy = this.getWorkflowEventPolicy();
    let attempt = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result: TResult;
      try {
        result = await this.performAction(this.context);
      } catch (error) {
        console.error('Error executing bubble:', error);
        const rawMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.context?.logger?.logBubbleExecutionComplete(
          this.context?.variableId ?? -999,
          this.name,
          this.name,
          {
            success: false,
            error: rawMessage,
            executionId: randomUUID(),
            timestamp: new Date(),
          }
        );
        this.context?.logger?.error(
          `[${this.name}] Unexpected error when performing action: ${rawMessage}`
        );

        const event = await this.emitWorkflowEvent({
          type: 'step_failed',
          code: 'BUBBLE_EXECUTION_ERROR',
          severity: 'error',
          message: sanitizeErrorMessage(rawMessage),
          errorClass: 'BubbleExecutionError',
          payload: { failureMode: 'thrown', attempt },
        });
        const { control, ruleIndex } = await this.resolveFlowControl(
          event,
          eventPolicy,
          attempt
        );
        if (control === 'retry') {
          attempt++;
          continue;
        }
        if (control === 'continue') {
          // A continued failure has no result data by definition; a consumer
          // opting into 'continue' must branch on success before touching
          // data (the flow-level ExecutionResult has the same contract).
          return {
            success: false,
            data: undefined as unknown as TResult,
            error: sanitizeErrorMessage(rawMessage),
            executionId: randomUUID(),
            timestamp: new Date(),
          };
        }
        if (control === 'halt-by-policy') {
          throw this.buildHaltError(event, ruleIndex);
        }
        // Default: the pre-events typed throw.
        throw new BubbleExecutionError(rawMessage, {
          variableId: this.context?.variableId,
          bubbleName: this.name,
          executionPhase: 'execution',
          cause: error instanceof Error ? error : undefined,
        });
      }

      // Validate result if schema is provided
      if (this.resultSchema) {
        try {
          const validatedResult = this.resultSchema.parse(result);

          const finalResult = {
            success: result.success,
            data: result,
            executionId: randomUUID(),
            error: validatedResult.error || '',
            timestamp: new Date(),
          };

          // Log bubble execution completion
          logger?.logBubbleExecutionComplete(
            this.context?.variableId ?? -999,
            this.name,
            this.name,
            finalResult
          );

          if (!finalResult.success) {
            // Errors-as-events: a SOFT failure is an event. Default keeps the
            // pre-events warn-and-continue; the policy can halt or retry it.
            const event = await this.emitWorkflowEvent({
              type: 'step_failed',
              code: 'BUBBLE_SOFT_FAILURE',
              severity: 'warning',
              message: sanitizeErrorMessage(String(finalResult.error ?? '')),
              payload: { failureMode: 'soft', attempt },
            });
            const { control, ruleIndex } = await this.resolveFlowControl(
              event,
              eventPolicy,
              attempt
            );
            if (control === 'retry') {
              attempt++;
              continue;
            }
            if (control === 'halt-by-policy') {
              throw this.buildHaltError(event, ruleIndex);
            }
            logger?.warn(
              `[${this.name}] Execution did not succeed: ${finalResult.error}. The flow will continue to run unless you manually catch and handle the error.`
            );
          } else {
            await this.emitWorkflowEvent({
              type: 'step_succeeded',
              code: 'STEP_SUCCEEDED',
              severity: 'info',
              message: `Bubble ${this.name} succeeded`,
              payload: { durationMs: Date.now() - stepStartedAt },
            });
          }

          return finalResult;
        } catch (validationError) {
          // Policy-driven control flow above throws through this try block;
          // pass those through untouched.
          if (validationError instanceof FlowHaltedByPolicyError) {
            throw validationError;
          }
          // Validation error for result validation failures
          const errorMessage =
            validationError instanceof z.ZodError
              ? `Result schema validation failed: ${validationError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
              : `Result validation failed: ${validationError instanceof Error ? validationError.message : 'Unknown validation error'}`;

          // Generate schema comparison for detailed debugging
          const diffReport = formatSchemaExpectedVsActual(
            this.resultSchema,
            result
          );
          const detailedError = `${errorMessage}\n\n${diffReport}`;

          // Log the validation error before throwing
          logger?.logBubbleExecutionComplete(
            this.context?.variableId ?? -999,
            this.name,
            this.name,
            {
              success: false,
              error: detailedError,
              executionId: randomUUID(),
              timestamp: new Date(),
            }
          );
          logger?.error(`[${this.name}] ${detailedError}`);

          // Errors-as-events: a result-schema deviation is a typed event
          // carrying the expected-vs-actual diff.
          const event = await this.emitWorkflowEvent({
            type: 'validation_deviation',
            code: 'RESULT_SCHEMA_DEVIATION',
            severity: 'error',
            message: sanitizeErrorMessage(errorMessage),
            errorClass: 'BubbleValidationError',
            payload: {
              phase: 'result',
              schemaDiff: sanitizeErrorMessage(diffReport),
            },
          });
          const { control, ruleIndex } = await this.resolveFlowControl(
            event,
            eventPolicy,
            attempt
          );
          if (control === 'retry') {
            attempt++;
            continue;
          }
          if (control === 'continue') {
            // A continued failure has no result data by definition; a consumer
            // opting into 'continue' must branch on success before touching
            // data (the flow-level ExecutionResult has the same contract).
            return {
              success: false,
              data: undefined as unknown as TResult,
              error: sanitizeErrorMessage(detailedError),
              executionId: randomUUID(),
              timestamp: new Date(),
            };
          }
          if (control === 'halt-by-policy') {
            throw this.buildHaltError(event, ruleIndex);
          }
          // Default: the pre-events typed throw.
          throw new BubbleValidationError(errorMessage, {
            variableId: this.context?.variableId,
            bubbleName: this.name,
            cause:
              validationError instanceof Error ? validationError : undefined,
          });
        }
      }

      // No result schema defined - proceed without validation
      const finalResult = {
        success: result.success,
        // For data we strip out any excessive fields
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        data: (({ ...rest }) => rest)(result) as TResult,
        error: result.error || '',
        executionId: randomUUID(),
        timestamp: new Date(),
      };

      if (!result.success) {
        logger?.error(
          `[${this.name}] Execution error when performing action: ${result.error}`
        );
        // Errors-as-events: soft failure without a result schema.
        const event = await this.emitWorkflowEvent({
          type: 'step_failed',
          code: 'BUBBLE_SOFT_FAILURE',
          severity: 'warning',
          message: sanitizeErrorMessage(String(result.error ?? '')),
          payload: { failureMode: 'soft', attempt },
        });
        const { control, ruleIndex } = await this.resolveFlowControl(
          event,
          eventPolicy,
          attempt
        );
        if (control === 'retry') {
          attempt++;
          continue;
        }
        if (control === 'halt-by-policy') {
          throw this.buildHaltError(event, ruleIndex);
        }
      } else {
        await this.emitWorkflowEvent({
          type: 'step_succeeded',
          code: 'STEP_SUCCEEDED',
          severity: 'info',
          message: `Bubble ${this.name} succeeded`,
          payload: { durationMs: Date.now() - stepStartedAt },
        });
      }

      // Log bubble execution completion
      logger?.logBubbleExecutionComplete(
        this.context?.variableId ?? -999,
        this.name,
        this.name,
        finalResult
      );

      return finalResult;
    }
  }

  // -------------------------------------------------------------------------
  // Errors-as-events machinery (design doc: docs/plan/ERRORS-AS-EVENTS-DESIGN.md)
  // -------------------------------------------------------------------------

  /** The per-execution event bus, threaded via executionMeta like testMode. */
  protected getWorkflowEventBus(): WorkflowEventBus | undefined {
    const bus = this.context?.executionMeta?.eventBus;
    return bus instanceof WorkflowEventBus ? bus : undefined;
  }

  /** The user-declared reaction policy for this flow, when present. */
  protected getWorkflowEventPolicy(): WorkflowEventPolicy | undefined {
    return this.context?.executionMeta?.eventPolicy;
  }

  /**
   * Build the full event from emitter input (identity fields filled from this
   * bubble's context), emit it on the bus when one is wired, and return it so
   * the caller can match it against the policy even without a bus.
   */
  protected async emitWorkflowEvent(
    input: WorkflowEventInput
  ): Promise<WorkflowEvent> {
    const event = {
      stepId:
        this.context?.currentUniqueId ?? this.context?.invocationCallSiteKey,
      variableId: this.context?.variableId,
      bubbleName: this.name,
      timestamp: new Date().toISOString(),
      ...input,
    } as WorkflowEvent;
    const bus = this.getWorkflowEventBus();
    if (bus) {
      await bus.emit(event);
    }
    return event;
  }

  private async emitReactionApplied(
    reaction: string,
    ruleIndex: number,
    source: WorkflowEvent
  ): Promise<void> {
    await this.emitWorkflowEvent({
      type: 'reaction_applied',
      code: 'REACTION_APPLIED',
      severity: 'info',
      message: `Policy rule ${ruleIndex} applied reaction '${reaction}' to ${source.code}`,
      payload: {
        reaction,
        ruleIndex,
        detail: { sourceType: source.type, sourceCode: source.code },
      },
    });
  }

  private buildHaltError(
    event: WorkflowEvent,
    ruleIndex?: number
  ): FlowHaltedByPolicyError {
    return new FlowHaltedByPolicyError(
      `Flow halted by event policy (${event.code}) at ${this.name}: ${event.message}`,
      {
        variableId: this.context?.variableId,
        bubbleName: this.name,
        eventCode: event.code,
        ruleIndex,
      }
    );
  }

  /**
   * Resolve the FLOW-CONTROL consequence of a failure-class event against the
   * declared policy. External reactions (notify, trigger_flow dispatch) are
   * the API-layer reactor's job; here only halt/continue/retry (and
   * trigger_flow.haltAfter) change control flow. No matching rule = 'default'
   * = exactly the pre-events behavior at each call site.
   */
  private async resolveFlowControl(
    event: WorkflowEvent,
    policy: WorkflowEventPolicy | undefined,
    attempt: number
  ): Promise<{
    control: 'default' | 'retry' | 'continue' | 'halt-by-policy';
    ruleIndex?: number;
  }> {
    const resolved = resolveReaction(policy, event);
    if (!resolved) return { control: 'default' };
    const { rule, ruleIndex } = resolved;
    const reaction = rule.reaction;

    if (reaction.kind === 'retry') {
      if (attempt < reaction.maxAttempts) {
        await this.emitWorkflowEvent({
          type: 'step_retried',
          code: 'STEP_RETRIED',
          severity: 'warning',
          message: `Retrying ${this.name} (attempt ${attempt + 1}/${reaction.maxAttempts}) per policy rule ${ruleIndex}`,
          payload: {
            attempt: attempt + 1,
            maxAttempts: reaction.maxAttempts,
            backoffMs: reaction.backoffMs,
          },
        });
        if (reaction.backoffMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, reaction.backoffMs)
          );
        }
        return { control: 'retry', ruleIndex };
      }
      // Retries exhausted: apply the declared `then` fallback.
      if (reaction.then === 'continue') {
        await this.emitReactionApplied(
          'retry_exhausted_continue',
          ruleIndex,
          event
        );
        return { control: 'continue', ruleIndex };
      }
      await this.emitReactionApplied('retry_exhausted_halt', ruleIndex, event);
      return { control: 'halt-by-policy', ruleIndex };
    }
    if (reaction.kind === 'continue') {
      await this.emitReactionApplied('continue', ruleIndex, event);
      return { control: 'continue', ruleIndex };
    }
    if (reaction.kind === 'halt') {
      await this.emitReactionApplied('halt', ruleIndex, event);
      return { control: 'halt-by-policy', ruleIndex };
    }
    if (reaction.kind === 'trigger_flow' && reaction.haltAfter) {
      // Dispatching the target flow is the API reactor's job; the declared
      // flow-control consequence (halt) is applied here.
      await this.emitReactionApplied(
        'trigger_flow_halt_after',
        ruleIndex,
        event
      );
      return { control: 'halt-by-policy', ruleIndex };
    }
    // notify / trigger_flow without haltAfter: external effect only.
    return { control: 'default' };
  }

  /** The `operation` discriminator of the current params, when present. */
  protected getOperationName(): string | undefined {
    const operation = (this.params as { operation?: unknown } | undefined)
      ?.operation;
    return typeof operation === 'string' ? operation : undefined;
  }

  /** True when the run is marked as a test, via context or executionMeta. */
  protected isTestModeRun(): boolean {
    const ctx = this.context;
    if (!ctx) return false;
    return ctx.testMode === true || ctx.executionMeta?.testMode === true;
  }

  /**
   * True only when this exact call site carries the explicit "dummy-data"
   * grant to execute a write for real in test mode. Exact string match against
   * invocationCallSiteKey or currentUniqueId — no wildcards, and a bubble with
   * no call-site identity never matches.
   */
  protected hasApprovedWriteGrant(): boolean {
    const ctx = this.context;
    if (!ctx) return false;
    const approved =
      ctx.approvedWriteCallSites ?? ctx.executionMeta?.approvedWriteCallSites;
    if (!Array.isArray(approved) || approved.length === 0) return false;
    const keys = [ctx.invocationCallSiteKey, ctx.currentUniqueId].filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    );
    return keys.some((key) => approved.includes(key));
  }

  /**
   * Contract KB seam: ask the context's recordedMockProvider for a RECORDED
   * real response for this invocation. Returns undefined (falling back to the
   * generated mock) when no provider is wired or no recording exists. Provider
   * failures also fall back — a broken recording store must not break a test run.
   */
  protected async getRecordedMock(): Promise<
    BubbleResult<TResult> | undefined
  > {
    const ctx = this.context;
    const provider =
      ctx?.recordedMockProvider ?? ctx?.executionMeta?.recordedMockProvider;
    if (typeof provider !== 'function') return undefined;
    try {
      const recorded = await provider({
        bubbleName: this.name,
        operation: this.getOperationName(),
        callSiteKey: ctx?.invocationCallSiteKey ?? ctx?.currentUniqueId,
      });
      if (!recorded) return undefined;
      return {
        success: true,
        error: '',
        data: recorded as TResult,
        executionId: randomUUID(),
        timestamp: new Date(),
        mocked: true,
      };
    } catch (error) {
      ctx?.logger?.warn(
        `[${this.name}] recordedMockProvider failed, falling back to generated mock: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
      return undefined;
    }
  }

  /**
   * Schema-derived mock for the test-mode gate. Operation-aware: when the
   * result schema is a discriminated union on `operation`, the mock is
   * generated from the option matching the CURRENT operation so downstream
   * code that switches on `data.operation` still works.
   */
  protected generateTestModeMockResult(): BubbleResult<TResult> {
    const operationSchema = this.resolveOperationResultSchema();
    const base = MockDataGenerator.generateMockResult<TResult>(
      operationSchema ?? this.resultSchema
    );
    // Mocked results always report success with an empty error, matching the
    // shape performAction would produce on the happy path.
    const data = {
      ...(base.data as Record<string, unknown>),
      success: true,
      error: '',
    } as TResult;
    return { ...base, data, success: true, error: '', mocked: true };
  }

  /**
   * When resultSchema is a discriminated union on `operation`, return the
   * option whose literal matches the current operation param.
   */
  private resolveOperationResultSchema():
    | z.ZodObject<z.ZodRawShape>
    | undefined {
    const operation = this.getOperationName();
    if (operation === undefined) return undefined;
    const def = (
      this.resultSchema as unknown as {
        _def?: {
          typeName?: string;
          options?: z.ZodTypeAny[];
        };
      }
    )._def;
    if (!def || def.typeName !== 'ZodDiscriminatedUnion') return undefined;
    for (const option of def.options ?? []) {
      const shape = (option as z.ZodObject<z.ZodRawShape>).shape;
      const operationDef = (
        shape?.operation as { _def?: { typeName?: string; value?: unknown } }
      )?._def;
      if (
        operationDef?.typeName === 'ZodLiteral' &&
        operationDef.value === operation
      ) {
        return option as z.ZodObject<z.ZodRawShape>;
      }
    }
    return undefined;
  }

  /**
   * Generate mock result data based on the result schema
   * Useful for testing and development when you need sample data
   */
  generateMockResult(): BubbleResult<TResult> {
    return MockDataGenerator.generateMockResult<TResult>(this.resultSchema);
  }

  /**
   * Generate mock result with a specific seed for reproducible results
   * Useful for consistent testing scenarios
   */
  generateMockResultWithSeed(seed: number): BubbleResult<TResult> {
    const mockResult = MockDataGenerator.generateMockWithSeed<TResult>(
      this.resultSchema,
      seed
    );

    // Override executionId to use randomUUID() instead of seeded value
    // This ensures executionId is always unique even with the same seed
    return {
      ...mockResult,
      executionId: randomUUID(),
    };
  }

  /**
   * Perform the actual bubble action - must be implemented by subclasses
   */
  protected abstract performAction(context?: BubbleContext): Promise<TResult>;
}
