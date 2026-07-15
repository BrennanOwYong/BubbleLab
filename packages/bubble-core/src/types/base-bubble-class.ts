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
  ContractDriftEvent,
  ExecutionMeta,
  MutationStateProbe,
} from '@bubblelab/shared-schemas';
import { MockDataGenerator, DRIFT_ERROR_CODE } from '@bubblelab/shared-schemas';
import type { DependencyGraphNode } from '@bubblelab/shared-schemas';
import {
  BubbleValidationError,
  BubbleExecutionError,
  BubbleDriftError,
} from './bubble-errors.js';
import { sanitizeParams } from '@bubblelab/shared-schemas';
import { formatSchemaExpectedVsActual } from '../utils/schema-comparison.js';
import type { OperationSideEffectMap } from './operation-side-effect.js';
import { getSideEffectOverrideRegistry } from '../utils/side-effect-overrides.js';
import {
  detectMutationEvidence,
  downgradeLyingRead,
  probeCapturesDiffer,
} from '../utils/mutation-evidence.js';

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
    const operation = this.getOperationName();
    // Runtime-verified overrides outrank the doc-derived static metadata
    // (docs lie; runs don't — REPO-MAP §4a step 5).
    const override = getSideEffectOverrideRegistry().get(
      this.name,
      operation ?? '*'
    );
    if (override) return override.sideEffect;
    const ctor = this.constructor as {
      operationMetadata?: OperationSideEffectMap;
    };
    const metadata = ctor.operationMetadata;
    if (!metadata) return 'write';
    const hint =
      (operation !== undefined ? metadata[operation] : undefined) ??
      metadata['*'];
    return hint?.sideEffect ?? 'write';
  }

  /**
   * Full classification (with provenance: confidence, source, citation) for the
   * current operation, or undefined when the operation is unclassified.
   * Runtime-verified overrides outrank the static declaration.
   */
  get operationSideEffectMetadata(): OperationSideEffectMetadata | undefined {
    const ctor = this.constructor as typeof BaseBubble & {
      operationMetadata?: BubbleOperationMetadata;
    };
    const operation = (this.params as { operation?: unknown } | undefined)
      ?.operation;
    if (typeof operation !== 'string') return undefined;
    const override = getSideEffectOverrideRegistry().get(this.name, operation);
    return override ?? ctor.operationMetadata?.[operation];
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

    // WRITE GATES — intercept ABOVE performAction so no client is ever
    // constructed and no credential is ever read, regardless of auth type.
    //
    // Test mode: write-hinted operations (the fail-safe default for
    // unclassified ones) return a recorded or generated mock; read-hinted
    // operations run for real. An explicit per-call-site grant
    // (approvedWriteCallSites) lets a write execute for real.
    //
    // Sign-off enforcement (real runs, REPO-MAP §4b defense in depth): when
    // the server stamped enforceWriteSignOff, a write-hinted operation whose
    // call site is not covered by the approved set is mocked even if a client
    // bypassed the pre-dispatch gate. UI is convenience; base class is law.
    const resolvedSideEffect = this.sideEffect;
    const testModeRun = this.isTestModeRun();
    let mockGateReason: string | undefined;
    if (
      testModeRun &&
      resolvedSideEffect !== 'read' &&
      !this.hasApprovedWriteGrant()
    ) {
      mockGateReason = 'Test mode';
    } else if (
      !testModeRun &&
      this.isWriteSignOffEnforced() &&
      resolvedSideEffect !== 'read' &&
      !this.hasWriteSignOffCover()
    ) {
      mockGateReason = 'Write sign-off enforcement';
    }
    if (mockGateReason) {
      const operation = this.getOperationName();
      logger?.info(
        `[${this.name}] ${mockGateReason}: operation '${operation ?? '(none)'}' is ` +
          `${resolvedSideEffect}-hinted — returning a mock result without executing. ` +
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

      return mockResult;
    }

    // Docs-lie detection setup: for a read-hinted operation about to run for
    // real, capture the optional caller-supplied state snapshot BEFORE
    // execution (executionMeta.mutationProbe).
    const mutationProbe =
      resolvedSideEffect === 'read' ? this.getMutationProbe() : undefined;
    let probeBefore: unknown;
    let probeCaptured = false;
    if (mutationProbe) {
      try {
        probeBefore = await mutationProbe();
        probeCaptured = true;
      } catch (probeError) {
        logger?.warn(
          `[${this.name}] mutationProbe (before) failed; docs-lie state ` +
            `comparison disabled for this invocation: ${
              probeError instanceof Error
                ? probeError.message
                : String(probeError)
            }`
        );
      }
    }

    let result: TResult;
    try {
      result = await this.performAction(this.context);
    } catch (error) {
      console.error('Error executing bubble:', error);
      this.context?.logger?.logBubbleExecutionComplete(
        this.context?.variableId ?? -999,
        this.name,
        this.name,
        {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          executionId: randomUUID(),
          timestamp: new Date(),
        }
      );
      this.context?.logger?.error(
        `[${this.name}] Unexpected error when performing action: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      throw new BubbleExecutionError(
        error instanceof Error ? error.message : 'Unknown error',
        {
          variableId: this.context?.variableId,
          bubbleName: this.name,
          executionPhase: 'execution',
          cause: error instanceof Error ? error : undefined,
        }
      );
    }

    // Docs-lie detection (real runs of doc-said-read operations): response
    // creation markers, or a caller-supplied before/after state snapshot,
    // reclassify the operation and persist the correction so it outranks the
    // documentation from then on.
    if (resolvedSideEffect === 'read') {
      await this.detectAndRecordDocsLie(
        result,
        mutationProbe,
        probeBefore,
        probeCaptured
      );
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
          logger?.warn(
            `[${this.name}] Execution did not succeed: ${finalResult.error}. The flow will continue to run unless you manually catch and handle the error.`
          );
        }

        return finalResult;
      } catch (validationError) {
        // CONTRACT DRIFT — the REAL response violated the declared
        // resultSchema. This is a distinct, identifiable signal
        // (OUTPUT_MISMATCH), not a generic failure: the declared contract and
        // observed reality disagree, and the Contract KB / drift consumers
        // must be able to tell it apart from every other error (HANDOFF §9).
        const deviations =
          validationError instanceof z.ZodError
            ? validationError.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
              }))
            : [
                {
                  path: '',
                  message:
                    validationError instanceof Error
                      ? validationError.message
                      : 'Unknown validation error',
                },
              ];
        const errorMessage = `Result contract drift (${DRIFT_ERROR_CODE}): real response violated the declared resultSchema: ${deviations
          .map((d) => `${d.path}: ${d.message}`)
          .join(', ')}`;

        // Generate schema comparison for detailed debugging
        const diffReport = formatSchemaExpectedVsActual(
          this.resultSchema,
          result
        );
        const detailedError = `${errorMessage}\n\n${diffReport}`;

        // Notify the drift consumer BEFORE throwing, so the signal survives
        // even when flow code catches the error.
        const callSiteKey =
          this.context?.invocationCallSiteKey ?? this.context?.currentUniqueId;
        const driftEvent: ContractDriftEvent = {
          code: DRIFT_ERROR_CODE,
          bubbleName: this.name,
          operation: this.getOperationName(),
          callSiteKey,
          variableId: this.context?.variableId,
          deviations,
          observedAt: new Date().toISOString(),
        };
        const driftObserver = this.getExecutionMeta()?.onContractDrift;
        if (typeof driftObserver === 'function') {
          try {
            driftObserver(driftEvent);
          } catch (observerError) {
            logger?.warn(
              `[${this.name}] onContractDrift observer failed: ${
                observerError instanceof Error
                  ? observerError.message
                  : String(observerError)
              }`
            );
          }
        }

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

        throw new BubbleDriftError(errorMessage, {
          variableId: this.context?.variableId,
          bubbleName: this.name,
          operation: this.getOperationName(),
          callSiteKey,
          deviations,
          cause: validationError instanceof Error ? validationError : undefined,
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

  /** The executionMeta carried by the context, when present. */
  protected getExecutionMeta(): ExecutionMeta | undefined {
    return this.context?.executionMeta;
  }

  /** True when the server stamped write-sign-off enforcement onto this run. */
  protected isWriteSignOffEnforced(): boolean {
    return this.getExecutionMeta()?.enforceWriteSignOff === true;
  }

  /**
   * Sign-off coverage for REAL runs (enforceWriteSignOff). Covered when this
   * call site's identity — invocationCallSiteKey, currentUniqueId, or
   * String(variableId) — matches an approved key exactly, or when
   * currentUniqueId is a CHILD of an approved site (`${approvedKey}.` prefix):
   * approving an agent/workflow call site covers the bubbles it spawns
   * dynamically, whose own identities cannot exist at sign-off time.
   */
  protected hasWriteSignOffCover(): boolean {
    const ctx = this.context;
    if (!ctx) return false;
    const approved =
      ctx.approvedWriteCallSites ?? ctx.executionMeta?.approvedWriteCallSites;
    if (!Array.isArray(approved) || approved.length === 0) return false;
    const keys = [
      ctx.invocationCallSiteKey,
      ctx.currentUniqueId,
      typeof ctx.variableId === 'number' ? String(ctx.variableId) : undefined,
    ].filter((key): key is string => typeof key === 'string' && key.length > 0);
    if (keys.some((key) => approved.includes(key))) return true;
    const uniqueId = ctx.currentUniqueId;
    if (typeof uniqueId === 'string' && uniqueId.length > 0) {
      return approved.some((key) => uniqueId.startsWith(`${key}.`));
    }
    return false;
  }

  /** Caller-supplied state probe for docs-lie detection, when wired. */
  protected getMutationProbe(): MutationStateProbe | undefined {
    const probe = this.getExecutionMeta()?.mutationProbe;
    return typeof probe === 'function' ? probe : undefined;
  }

  /**
   * Docs-lie detector: a doc-said-read operation just executed for REAL.
   * Evidence of mutation — a creation marker in the response, or a
   * before/after state-probe difference — reclassifies the operation to
   * 'read_with_side_effects' with runtime-verified provenance
   * (source 'observed') and persists the correction through the override
   * registry so it outranks the documentation from then on and is never
   * re-learned. Detection failures never break the run.
   */
  private async detectAndRecordDocsLie(
    result: TResult,
    mutationProbe: MutationStateProbe | undefined,
    probeBefore: unknown,
    probeCaptured: boolean
  ): Promise<void> {
    const logger = this.context?.logger;
    try {
      let evidence: string | undefined;

      const markerEvidence = detectMutationEvidence(result);
      if (markerEvidence.detected) {
        evidence = markerEvidence.evidence;
      } else if (mutationProbe && probeCaptured) {
        const probeAfter = await mutationProbe();
        if (probeCapturesDiffer(probeBefore, probeAfter)) {
          evidence =
            'caller-supplied state probe observed a state change across the operation';
        }
      }
      if (!evidence) return;

      const operation = this.getOperationName() ?? '*';
      const registry = getSideEffectOverrideRegistry();
      const previous = this.operationSideEffectMetadata;
      const corrected = downgradeLyingRead(
        previous,
        `${evidence} (observed on ${this.name}.${operation})`
      );
      const newlyLearned = registry.record({
        bubbleName: this.name,
        operation,
        metadata: corrected,
        evidence,
        observedAt: new Date().toISOString(),
      });
      if (!newlyLearned) return;

      logger?.warn(
        `[${this.name}] DOCS LIE DETECTED: operation '${operation}' was ` +
          `documented as 'read' but was observed mutating state (${evidence}). ` +
          `Reclassified to 'read_with_side_effects' (source: observed) and ` +
          `persisted — runtime verification outranks the documentation from now on.`
      );

      const correctionObserver = this.getExecutionMeta()?.onSideEffectCorrection;
      if (typeof correctionObserver === 'function') {
        correctionObserver({
          override: {
            bubbleName: this.name,
            operation,
            metadata: corrected,
            evidence,
            observedAt: new Date().toISOString(),
          },
          previous,
        });
      }
    } catch (detectionError) {
      logger?.warn(
        `[${this.name}] Docs-lie detection failed (run unaffected): ${
          detectionError instanceof Error
            ? detectionError.message
            : String(detectionError)
        }`
      );
    }
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
