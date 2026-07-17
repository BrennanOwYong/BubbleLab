/**
 * Add-a-Tool pipeline service: drives the real @bubblelab/bubble-appgen
 * generator (parse -> extract -> classify -> emit) over an uploaded or
 * fetched API spec, writes the generated file set into bubble-core, and
 * records the tool in the registered-tools registry the studio catalog reads.
 *
 * Every meaningful state change emits a structured telemetry event
 * (programmatic-telemetry principle): the studio renders the run live from
 * these events, and automated tests assert on them deterministically.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  parseOpenApiText,
  extractOperations,
  classifyOperation,
  emitBubble,
  type AppGenConfig,
  type OpenApiDocument,
  type OperationDraft,
} from '@bubblelab/bubble-appgen';
import type { OperationSideEffectMetadata } from '@bubblelab/shared-schemas';

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────────────────────────────────────

/** Monorepo root; the API dev server runs with cwd = apps/bubblelab-api. */
function repoRoot(): string {
  return process.env.TOOLS_REPO_ROOT ?? resolve(process.cwd(), '../..');
}

/** Directory of validated app manifests (the appgen example configs). */
function manifestsDir(): string {
  return join(repoRoot(), 'packages/bubble-appgen/examples');
}

/** Where generated tool folders land (bubble-core service bubbles). */
function outputRoot(): string {
  return (
    process.env.TOOLS_OUTPUT_ROOT ??
    join(repoRoot(), 'packages/bubble-core/src/bubbles/service-bubble')
  );
}

/** Registry file the studio catalog reads registered tools from. */
function registryPath(): string {
  return (
    process.env.TOOLS_REGISTRY_PATH ??
    join(process.cwd(), 'data/registered-tools.json')
  );
}

// ── Event contract ────────────────────────────────────────────────────────────

export type ToolGenErrorCode =
  | 'SPEC_URL_FETCH_FAILED'
  | 'SPEC_EMPTY'
  | 'SPEC_PARSE_FAILED'
  | 'NO_OPERATIONS_FOUND'
  | 'OPERATION_EXTRACTION_FAILED'
  | 'CONTRACT_EMIT_FAILED'
  | 'FILE_WRITE_FAILED'
  | 'REGISTRY_WRITE_FAILED';

export interface RegisteredToolOperation {
  name: string;
  method: string;
  path: string;
  sideEffect: string;
  confidence: number;
  summary?: string;
}

export interface RegisteredTool {
  name: string;
  displayName: string;
  service: string;
  credentialType: string;
  source: 'validated-manifest' | 'derived';
  specTitle: string;
  operations: RegisteredToolOperation[];
  files: string[];
  outDir: string;
  addedAt: string;
}

export type ToolGenEvent =
  | {
      type: 'run_started';
      data: { specName: string; bytes: number; source: 'upload' | 'url' };
    }
  | {
      type: 'spec_parsed';
      data: {
        title: string;
        version?: string;
        pathCount: number;
        operationCount: number;
      };
    }
  | {
      type: 'config_resolved';
      data: {
        appName: string;
        displayName: string;
        className: string;
        credentialType: string;
        source: 'validated-manifest' | 'derived';
        operationCount: number;
      };
    }
  | {
      type: 'operations_found';
      data: {
        count: number;
        operations: Array<{
          name: string;
          operationId: string;
          method: string;
          path: string;
          summary?: string;
        }>;
      };
    }
  | {
      type: 'operation_classified';
      data: {
        name: string;
        method: string;
        path: string;
        sideEffect: string;
        confidence: number;
        unverified?: boolean;
        citation: string;
      };
    }
  | {
      type: 'auth_detected';
      data: {
        credentialType: string;
        scheme: string;
        headerNames: string[];
        baseUrlParam: { name: string; description: string; example: string };
        securitySchemes: string[];
      };
    }
  | {
      type: 'contract_emitted';
      data: {
        fileName: string;
        kind: 'schema' | 'metadata' | 'class' | 'tests' | 'index';
        lines: number;
        bytes: number;
        excerpt?: string;
      };
    }
  | { type: 'files_written'; data: { outDir: string; files: string[] } }
  | { type: 'tool_registered'; data: RegisteredTool }
  | {
      type: 'generation_complete';
      data: { elapsedMs: number; operationCount: number; fileCount: number };
    }
  | {
      type: 'generation_error';
      data: { code: ToolGenErrorCode; message: string };
    };

export type ToolGenEmit = (event: ToolGenEvent) => Promise<void>;

// ── Registry ──────────────────────────────────────────────────────────────────

export async function readRegistry(): Promise<RegisteredTool[]> {
  try {
    const raw = await readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(raw) as { tools?: RegisteredTool[] };
    return parsed.tools ?? [];
  } catch {
    return [];
  }
}

async function writeRegistry(tools: RegisteredTool[]): Promise<void> {
  await mkdir(resolve(registryPath(), '..'), { recursive: true });
  await writeFile(
    registryPath(),
    JSON.stringify({ tools }, null, 2) + '\n',
    'utf8'
  );
}

export async function unregisterTool(name: string): Promise<boolean> {
  const tools = await readRegistry();
  const next = tools.filter((tool) => tool.name !== name);
  if (next.length === tools.length) return false;
  await writeRegistry(next);
  return true;
}

// ── Config resolution ─────────────────────────────────────────────────────────

interface ManifestConfig extends AppGenConfig {
  displayName?: string;
}

async function loadManifests(): Promise<ManifestConfig[]> {
  try {
    const entries = await readdir(manifestsDir());
    const configs: ManifestConfig[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.config.json')) continue;
      const raw = await readFile(join(manifestsDir(), entry), 'utf8');
      configs.push(JSON.parse(raw) as ManifestConfig);
    }
    return configs;
  } catch {
    return [];
  }
}

function specOperationIds(doc: OpenApiDocument): string[] {
  const ids: string[] = [];
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operationId = pathItem[method]?.operationId;
      if (operationId) ids.push(operationId);
    }
  }
  return ids;
}

function kebab(text: string): string {
  return text
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function pascalFromKebab(text: string): string {
  return text
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Resolve the generation config for a parsed spec: prefer a validated
 * manifest whose selected operations all exist in the spec (exact specName
 * match wins, then best coverage); otherwise derive a config from the spec
 * itself so unknown vendors still generate a full typed file set.
 */
async function resolveConfig(
  doc: OpenApiDocument,
  specName: string
): Promise<{
  config: ManifestConfig;
  source: 'validated-manifest' | 'derived';
}> {
  const ids = new Set(specOperationIds(doc));
  const manifests = await loadManifests();
  const covered = manifests.filter((manifest) =>
    manifest.operations.every((operationId) => ids.has(operationId))
  );
  const exact = covered.find((manifest) => manifest.specName === specName);
  const best =
    exact ??
    covered.sort((a, b) => b.operations.length - a.operations.length)[0];
  if (best) return { config: best, source: 'validated-manifest' };

  const title = doc.info?.title?.trim() || specName.replace(/\.[^.]+$/, '');
  const appName = kebab(title) || 'unnamed-tool';
  const serverUrl = doc.servers?.[0]?.url ?? 'https://api.example.com';
  const derived: ManifestConfig = {
    appName,
    className: pascalFromKebab(appName),
    service: appName.split('-')[0],
    displayName: title,
    shortDescription: doc.info?.description?.slice(0, 160) ?? title,
    credentialType: `${appName.split('-')[0].toUpperCase()}_CRED`,
    authHeaders: { 'User-Agent': 'bubblelab/1.0' },
    baseUrlParam: {
      name: 'baseUrl',
      description: `${title} API base URL`,
      example: serverUrl,
    },
    operations: [...ids],
    specName,
  };
  return { config: derived, source: 'derived' };
}

// ── Excerpt ───────────────────────────────────────────────────────────────────

/**
 * Contract excerpt for the UI preview: the emitted schema file body after
 * its header comment + import block, truncated to a readable window.
 */
function contractExcerpt(content: string): string {
  const lines = content.split('\n');
  let lastImport = -1;
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    if (lines[i].startsWith('import ')) lastImport = i;
  }
  const body = lines
    .slice(lastImport + 1)
    .join('\n')
    .trimStart();
  const MAX = 20000;
  return body.length > MAX ? `${body.slice(0, MAX)}\n// … truncated …` : body;
}

function fileKind(
  fileName: string
): 'schema' | 'metadata' | 'class' | 'tests' | 'index' {
  if (fileName.endsWith('.schema.test.ts')) return 'tests';
  if (fileName.endsWith('.schema.ts')) return 'schema';
  if (fileName.endsWith('.metadata.ts')) return 'metadata';
  if (fileName === 'index.ts') return 'index';
  return 'class';
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface GenerateToolRequest {
  specText?: string;
  specUrl?: string;
  specFileName?: string;
}

const MAX_SPEC_BYTES = 5 * 1024 * 1024;

/**
 * Run the full add-a-tool pipeline, emitting telemetry events as each stage
 * completes. Never throws: failures surface as a `generation_error` event
 * with a machine-branchable code.
 */
export async function generateTool(
  request: GenerateToolRequest,
  emit: ToolGenEmit
): Promise<void> {
  const started = performance.now();
  const fail = async (code: ToolGenErrorCode, message: string) => {
    await emit({ type: 'generation_error', data: { code, message } });
  };

  // S1: acquire the spec text
  let specText = request.specText ?? '';
  let source: 'upload' | 'url' = 'upload';
  let specName = request.specFileName ?? 'uploaded-spec.yaml';
  if (!specText && request.specUrl) {
    source = 'url';
    specName = request.specUrl.split('/').pop() || 'remote-spec.yaml';
    try {
      const response = await fetch(request.specUrl, {
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        return fail(
          'SPEC_URL_FETCH_FAILED',
          `Spec URL returned ${response.status}`
        );
      }
      specText = await response.text();
    } catch (error) {
      return fail(
        'SPEC_URL_FETCH_FAILED',
        `Could not fetch spec URL: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!specText.trim()) {
    return fail('SPEC_EMPTY', 'No specification content was provided');
  }
  if (Buffer.byteLength(specText, 'utf8') > MAX_SPEC_BYTES) {
    return fail('SPEC_PARSE_FAILED', 'Specification exceeds the 5 MB limit');
  }
  await emit({
    type: 'run_started',
    data: { specName, bytes: Buffer.byteLength(specText, 'utf8'), source },
  });

  // S1/S2: parse + dereference
  let doc: OpenApiDocument;
  try {
    doc = parseOpenApiText(specText, specName);
  } catch (error) {
    return fail(
      'SPEC_PARSE_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  const allIds = specOperationIds(doc);
  await emit({
    type: 'spec_parsed',
    data: {
      title: doc.info?.title ?? specName,
      version: doc.info?.version,
      pathCount: Object.keys(doc.paths ?? {}).length,
      operationCount: allIds.length,
    },
  });
  if (allIds.length === 0) {
    return fail(
      'NO_OPERATIONS_FOUND',
      'The specification documents no operations with operation ids'
    );
  }

  // S5 facts: resolve the app config (validated manifest or derived)
  const { config, source: configSource } = await resolveConfig(doc, specName);
  const displayName = config.displayName ?? config.className;
  await emit({
    type: 'config_resolved',
    data: {
      appName: config.appName,
      displayName,
      className: config.className,
      credentialType: config.credentialType,
      source: configSource,
      operationCount: config.operations.length,
    },
  });

  // S2: extract the selected operations into normalized drafts
  let drafts: OperationDraft[];
  try {
    if (configSource === 'validated-manifest') {
      drafts = extractOperations(doc, config.operations, config.specName);
    } else {
      // Derived mode: keep every operation that extracts cleanly.
      drafts = [];
      for (const operationId of config.operations) {
        try {
          drafts.push(...extractOperations(doc, [operationId], specName));
        } catch {
          // Operation lacks a documented 2xx JSON response; skip it.
        }
      }
      config.operations = drafts.map((draft) => draft.operationId);
    }
  } catch (error) {
    return fail(
      'OPERATION_EXTRACTION_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  if (drafts.length === 0) {
    return fail(
      'NO_OPERATIONS_FOUND',
      'No operation in the specification has a documented JSON response'
    );
  }
  await emit({
    type: 'operations_found',
    data: {
      count: drafts.length,
      operations: drafts.map((draft) => ({
        name: draft.name,
        operationId: draft.operationId,
        method: draft.method,
        path: draft.pathTemplate,
        summary: draft.summary?.trim(),
      })),
    },
  });

  // S4: classify side-effects with provenance
  const classified: Array<{
    draft: OperationDraft;
    metadata: OperationSideEffectMetadata;
  }> = [];
  for (const draft of drafts) {
    const metadata = classifyOperation(draft, config.carrierFields);
    classified.push({ draft, metadata });
    await emit({
      type: 'operation_classified',
      data: {
        name: draft.name,
        method: draft.method,
        path: draft.pathTemplate,
        sideEffect: metadata.sideEffect,
        confidence: metadata.confidence,
        unverified: metadata.unverified,
        citation: metadata.citation,
      },
    });
  }

  // S5: surface the auth structure the generated tool will use
  const securitySchemes = [
    ...new Set(drafts.flatMap((draft) => draft.securitySchemes)),
  ];
  await emit({
    type: 'auth_detected',
    data: {
      credentialType: config.credentialType,
      scheme: 'bearer',
      headerNames: ['Authorization', ...Object.keys(config.authHeaders)],
      baseUrlParam: config.baseUrlParam,
      securitySchemes,
    },
  });

  // S3+S6: emit the typed contract + implementation file set
  let files: ReturnType<typeof emitBubble>;
  try {
    files = emitBubble(config, classified);
  } catch (error) {
    return fail(
      'CONTRACT_EMIT_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  for (const file of files) {
    const kind = fileKind(file.fileName);
    await emit({
      type: 'contract_emitted',
      data: {
        fileName: file.fileName,
        kind,
        lines: file.content.split('\n').length,
        bytes: Buffer.byteLength(file.content, 'utf8'),
        excerpt: kind === 'schema' ? contractExcerpt(file.content) : undefined,
      },
    });
  }

  // Write the file set where service bubbles live
  const outDir = join(outputRoot(), config.appName);
  try {
    await mkdir(outDir, { recursive: true });
    for (const file of files) {
      await writeFile(join(outDir, file.fileName), file.content, 'utf8');
    }
    // Format with the repo prettier so a re-run of a validated spec is a
    // byte-identical no-op against the committed files.
    const prettierBin = join(repoRoot(), 'node_modules/.bin/prettier');
    if (existsSync(prettierBin)) {
      await execFileAsync(prettierBin, ['--write', outDir]);
    }
  } catch (error) {
    return fail(
      'FILE_WRITE_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  await emit({
    type: 'files_written',
    data: {
      outDir: outDir.startsWith(repoRoot())
        ? outDir.slice(repoRoot().length + 1)
        : outDir,
      files: files.map((file) => file.fileName),
    },
  });

  // Register the tool for the studio catalog
  const tool: RegisteredTool = {
    name: config.appName,
    displayName,
    service: config.service,
    credentialType: config.credentialType,
    source: configSource,
    specTitle: doc.info?.title ?? specName,
    operations: classified.map(({ draft, metadata }) => ({
      name: draft.name,
      method: draft.method,
      path: draft.pathTemplate,
      sideEffect: metadata.sideEffect,
      confidence: metadata.confidence,
      summary: draft.summary?.trim(),
    })),
    files: files.map((file) => file.fileName),
    outDir: join(
      'packages/bubble-core/src/bubbles/service-bubble',
      config.appName
    ),
    addedAt: new Date().toISOString(),
  };
  try {
    const tools = await readRegistry();
    const next = tools.filter((existing) => existing.name !== tool.name);
    next.push(tool);
    await writeRegistry(next);
  } catch (error) {
    return fail(
      'REGISTRY_WRITE_FAILED',
      error instanceof Error ? error.message : String(error)
    );
  }
  await emit({ type: 'tool_registered', data: tool });

  await emit({
    type: 'generation_complete',
    data: {
      elapsedMs: Math.round(performance.now() - started),
      operationCount: drafts.length,
      fileCount: files.length,
    },
  });
}
