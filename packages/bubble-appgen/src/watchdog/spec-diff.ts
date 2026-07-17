/**
 * Drift detector: diff two versions of a tool's OpenAPI fixture into the
 * set of changed/added/removed operations and fields, with breaking-change
 * classification.
 *
 * The diff runs over `OperationDraft`s (extract.ts), not raw spec trees:
 * the drafts ARE the surface the generator consumes, so the diff reports
 * exactly the changes that will land in the generated Zod schemas and
 * TypeScript types — nothing more (vendor doc-prose churn elsewhere in the
 * spec is invisible here, as it is to the generated tool).
 *
 * Breaking classification (a change is breaking when previously-valid
 * caller code or previously-parsed responses can stop working):
 * - operation removed ................................ BREAKING
 * - input field removed .............................. BREAKING (flows pass it)
 * - input field added as REQUIRED .................... BREAKING
 * - input field optional->required ................... BREAKING
 * - input/response field type changed ................ BREAKING
 * - enum value removed ............................... BREAKING
 * - response property removed ........................ BREAKING (flows read it)
 * - operation added / optional input added ........... non-breaking
 * - required->optional, response property added ...... non-breaking
 * - enum value added, description/summary churn ...... non-breaking
 */
import type {
  SpecDiff,
  SpecFieldChange,
  SpecOperationDiff,
} from '@bubblelab/shared-schemas';
import { extractOperations } from '../extract.js';
import type { OpenApiDocument } from '../openapi.js';
import type { JsonSchema, OperationDraft, WireField } from '../types.js';

interface OpenApiInfo {
  info?: { version?: string };
}

/** One tolerant per-operation extraction; a miss means "not in this spec". */
function extractOne(
  doc: OpenApiDocument,
  operationId: string,
  specName: string
): OperationDraft | null {
  try {
    const drafts = extractOperations(doc, [operationId], specName);
    return drafts[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Canonical short label of a schema's type for change reporting:
 * `string`, `string(date-time)`, `array<object>`, `enum[a|b]`, `object`.
 */
export function schemaTypeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `enum[${schema.enum.map((v) => String(v)).join('|')}]`;
  }
  const base = schema.type ?? (schema.properties ? 'object' : 'unknown');
  if (base === 'array') {
    return `array<${schemaTypeLabel(schema.items)}>`;
  }
  return schema.format ? `${base}(${schema.format})` : base;
}

function diffEnums(
  path: string,
  from: JsonSchema | undefined,
  to: JsonSchema | undefined,
  changes: SpecFieldChange[]
): void {
  const fromEnum = new Set((from?.enum ?? []).map((v) => String(v)));
  const toEnum = new Set((to?.enum ?? []).map((v) => String(v)));
  if (fromEnum.size === 0 && toEnum.size === 0) return;
  for (const value of fromEnum) {
    if (!toEnum.has(value)) {
      changes.push({
        kind: 'enum-value-removed',
        path,
        from: value,
        to: null,
        breaking: true,
      });
    }
  }
  for (const value of toEnum) {
    if (!fromEnum.has(value)) {
      changes.push({
        kind: 'enum-value-added',
        path,
        from: null,
        to: value,
        breaking: false,
      });
    }
  }
}

/**
 * Structural comparison of two schema nodes at `path`. Reports type changes
 * at this node, then recurses into object properties and array items.
 * Depth-limited: the generated Zod collapses deep recursion into open maps,
 * so changes below the cap cannot affect generated code.
 */
function diffSchema(
  path: string,
  from: JsonSchema | undefined,
  to: JsonSchema | undefined,
  side: 'body' | 'response',
  changes: SpecFieldChange[],
  depth: number
): void {
  if (depth > 6) return;
  const fromLabel = schemaTypeLabel(from);
  const toLabel = schemaTypeLabel(to);
  const enumInvolved =
    (from?.enum?.length ?? 0) > 0 || (to?.enum?.length ?? 0) > 0;
  if (enumInvolved) {
    diffEnums(path, from, to, changes);
  } else if (fromLabel !== toLabel) {
    changes.push({
      kind: side === 'body' ? 'body-type-changed' : 'response-type-changed',
      path,
      from: fromLabel,
      to: toLabel,
      breaking: true,
    });
    return; // type changed wholesale; property-level noise adds nothing
  }
  const fromProps = from?.properties ?? {};
  const toProps = to?.properties ?? {};
  const fromRequired = new Set(from?.required ?? []);
  const toRequired = new Set(to?.required ?? []);
  for (const [name, fromChild] of Object.entries(fromProps)) {
    const childPath = `${path}.${name}`;
    if (!(name in toProps)) {
      changes.push({
        kind:
          side === 'body' ? 'body-property-removed' : 'response-property-removed',
        path: childPath,
        from: schemaTypeLabel(fromChild),
        to: null,
        breaking: true,
      });
      continue;
    }
    if (side === 'body') {
      if (!fromRequired.has(name) && toRequired.has(name)) {
        changes.push({
          kind: 'body-required-added',
          path: childPath,
          from: 'optional',
          to: 'required',
          breaking: true,
        });
      } else if (fromRequired.has(name) && !toRequired.has(name)) {
        changes.push({
          kind: 'body-required-removed',
          path: childPath,
          from: 'required',
          to: 'optional',
          breaking: false,
        });
      }
    }
    diffSchema(childPath, fromChild, toProps[name], side, changes, depth + 1);
  }
  for (const [name, toChild] of Object.entries(toProps)) {
    if (name in fromProps) continue;
    const childPath = `${path}.${name}`;
    const addedRequired = side === 'body' && toRequired.has(name);
    changes.push({
      kind:
        side === 'body' ? 'body-property-added' : 'response-property-added',
      path: childPath,
      from: null,
      to: schemaTypeLabel(toChild),
      breaking: addedRequired,
    });
  }
  if (from?.items || to?.items) {
    diffSchema(`${path}[]`, from?.items, to?.items, side, changes, depth + 1);
  }
}

function diffFields(
  fromFields: WireField[],
  toFields: WireField[],
  changes: SpecFieldChange[]
): void {
  const byKey = (field: WireField) => `${field.location}.${field.name}`;
  const fromMap = new Map(fromFields.map((f) => [byKey(f), f]));
  const toMap = new Map(toFields.map((f) => [byKey(f), f]));
  for (const [key, fromField] of fromMap) {
    const toField = toMap.get(key);
    if (!toField) {
      changes.push({
        kind: 'param-removed',
        path: key,
        from: schemaTypeLabel(fromField.schema),
        to: null,
        breaking: true,
      });
      continue;
    }
    if (!fromField.required && toField.required) {
      changes.push({
        kind: 'param-required-added',
        path: key,
        from: 'optional',
        to: 'required',
        breaking: true,
      });
    } else if (fromField.required && !toField.required) {
      changes.push({
        kind: 'param-required-removed',
        path: key,
        from: 'required',
        to: 'optional',
        breaking: false,
      });
    }
    const fromLabel = schemaTypeLabel(fromField.schema);
    const toLabel = schemaTypeLabel(toField.schema);
    const enumInvolved =
      (fromField.schema.enum?.length ?? 0) > 0 ||
      (toField.schema.enum?.length ?? 0) > 0;
    if (enumInvolved) {
      diffEnums(key, fromField.schema, toField.schema, changes);
    } else if (fromLabel !== toLabel) {
      changes.push({
        kind: 'param-type-changed',
        path: key,
        from: fromLabel,
        to: toLabel,
        breaking: true,
      });
    } else if (fromField.location === 'body') {
      // Body fields carry nested object schemas worth walking.
      diffSchema(key, fromField.schema, toField.schema, 'body', changes, 1);
    }
  }
  for (const [key, toField] of toMap) {
    if (fromMap.has(key)) continue;
    changes.push({
      kind: 'param-added',
      path: key,
      from: null,
      to: schemaTypeLabel(toField.schema),
      breaking: toField.required,
    });
  }
}

function diffResponses(
  from: Record<string, JsonSchema>,
  to: Record<string, JsonSchema>,
  changes: SpecFieldChange[]
): void {
  const fromWrap: JsonSchema = { type: 'object', properties: from };
  const toWrap: JsonSchema = { type: 'object', properties: to };
  diffSchema('response', fromWrap, toWrap, 'response', changes, 0);
}

/**
 * Diff the operations a tool exposes between two parsed spec documents.
 * `operationIds` is the tool's generation selection (config.operations) —
 * the watchdog only cares about the surface that was generated.
 */
export function diffSpecs(
  fromDoc: OpenApiDocument,
  toDoc: OpenApiDocument,
  operationIds: string[],
  specName: string
): SpecDiff {
  const added: SpecDiff['addedOperations'] = [];
  const removed: SpecDiff['removedOperations'] = [];
  const changedOperations: SpecOperationDiff[] = [];

  for (const operationId of operationIds) {
    const fromDraft = extractOne(fromDoc, operationId, specName);
    const toDraft = extractOne(toDoc, operationId, specName);
    if (!fromDraft && !toDraft) continue;
    if (fromDraft && !toDraft) {
      removed.push({
        operationId,
        method: fromDraft.method,
        path: fromDraft.pathTemplate,
      });
      continue;
    }
    if (!fromDraft && toDraft) {
      added.push({
        operationId,
        method: toDraft.method,
        path: toDraft.pathTemplate,
      });
      continue;
    }
    if (!fromDraft || !toDraft) continue;
    const changes: SpecFieldChange[] = [];
    diffFields(fromDraft.fields, toDraft.fields, changes);
    diffResponses(
      fromDraft.responseProperties,
      toDraft.responseProperties,
      changes
    );
    if (
      (fromDraft.summary ?? '') !== (toDraft.summary ?? '') ||
      (fromDraft.description ?? '') !== (toDraft.description ?? '')
    ) {
      changes.push({
        kind: 'description-changed',
        path: 'docs',
        from: null,
        to: null,
        breaking: false,
      });
    }
    if (changes.length > 0) {
      changedOperations.push({
        operationId,
        method: toDraft.method,
        path: toDraft.pathTemplate,
        changes,
      });
    }
  }

  const fromVersion = (fromDoc as OpenApiInfo).info?.version ?? null;
  const toVersion = (toDoc as OpenApiInfo).info?.version ?? null;

  const breakingFindings: string[] = [
    ...removed.map(
      (op) => `operation removed: ${op.operationId} (${op.method} ${op.path})`
    ),
    ...changedOperations.flatMap((op) =>
      op.changes
        .filter((c) => c.breaking)
        .map(
          (c) =>
            `${op.operationId}: ${c.kind} at ${c.path}` +
            (c.from !== null || c.to !== null
              ? ` (${c.from ?? '—'} -> ${c.to ?? '—'})`
              : '')
        )
    ),
  ];

  return {
    infoVersion: { from: fromVersion, to: toVersion },
    addedOperations: added,
    removedOperations: removed,
    changedOperations,
    breaking: breakingFindings.length > 0,
    breakingFindings,
  };
}

/** True when the diff contains any change at all (incl. non-breaking). */
export function hasChanges(diff: SpecDiff): boolean {
  return (
    diff.addedOperations.length > 0 ||
    diff.removedOperations.length > 0 ||
    diff.changedOperations.length > 0 ||
    diff.infoVersion.from !== diff.infoVersion.to
  );
}
