/**
 * Library surface of the contract-first bubble generator (ADD-ANY-APP S1-S6).
 *
 * The CLI (src/cli.ts) and the bubblelab-api /tools/generate endpoint both
 * drive this same pipeline: parse spec -> extract operations -> classify
 * side-effects -> emit the typed bubble file set.
 */
export { loadOpenApi, parseOpenApiText } from './openapi.js';
export type { OpenApiDocument, OpenApiOperation } from './openapi.js';
export { extractOperations, toSnakeCase } from './extract.js';
export { classifyOperation } from './classify.js';
export { emitBubble } from './emit-bubble.js';
export type { GeneratedFile } from './emit-bubble.js';
export type {
  AppGenConfig,
  OperationDraft,
  WireField,
  WireLocation,
  BodyEncoding,
  JsonSchema,
} from './types.js';
