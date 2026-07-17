/**
 * Watchdog check orchestration: for every registered tool, poll its
 * source(s) of truth, detect drift, and drive the auto-update path —
 * re-run the SAME deterministic converter/trimmer + generator scripts a
 * human runs, emit a changelog, and hold breaking changes for review
 * instead of applying them.
 *
 * Auto-apply-vs-review policy:
 * - upstream changed, tool's fixture unchanged  -> snapshot update only
 * - non-breaking spec drift                     -> regenerate + changelog
 * - BREAKING spec drift                         -> fixtures restored, new
 *   fixture staged under pending/<tool>/, changelog written, registry
 *   pendingReview set; `watchdog:apply --tool <name>` applies after review
 * - monitoring: 'manual' (hand-transcribed)     -> flag only, never touch
 *
 * Every decision emits exactly one typed ToolWatchdogEvent.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type {
  RegisteredToolSource,
  SpecDiff,
  ToolSourceRegistry,
  ToolWatchdogEvent,
} from '@bubblelab/shared-schemas';
import { loadOpenApi } from '../openapi.js';
import { diffSpecs } from './spec-diff.js';
import { writeChangelog } from './changelog.js';
import {
  fetchSource,
  sha256Hex,
  toSnapshot,
  type FetchOutcome,
} from './fetch-source.js';
import { loadRegistry, saveRegistry } from './registry-io.js';

export type EmitEvent = (event: ToolWatchdogEvent) => void;

export interface CheckOptions {
  /** bubble-appgen package root (registry, fixtures, scripts live here). */
  packageRoot: string;
  /** Monorepo root (generated tool folders live under it). */
  repoRoot: string;
  emit: EmitEvent;
  /** Restrict the run to one tool. */
  onlyTool?: string;
  /** Per-tool source URL overrides: `<tool>/<sourceKey>` -> URL. */
  sourceOverrides?: Record<string, string>;
  trigger: 'schedule' | 'manual' | 'cli';
  now?: () => string;
}

export interface CheckSummary {
  checked: number;
  unchanged: number;
  drifted: number;
  regenerated: number;
  flagged: number;
  failed: number;
}

const GENERATED_FILE_SUFFIXES = [
  '.ts',
  '.schema.ts',
  '.metadata.ts',
  '.schema.test.ts',
];

/** The emitter's fixed output set for a tool name. */
export function generatedFileNames(toolName: string): string[] {
  return [
    ...GENERATED_FILE_SUFFIXES.map((suffix) => `${toolName}${suffix}`),
    'index.ts',
  ];
}

export function fingerprintGeneratedFiles(
  repoRoot: string,
  tool: Pick<RegisteredToolSource, 'name' | 'outDir'>
): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const fileName of generatedFileNames(tool.name)) {
    const path = join(repoRoot, tool.outDir, fileName);
    if (existsSync(path)) {
      fingerprints[fileName] = sha256Hex(readFileSync(path, 'utf8'));
    }
  }
  return fingerprints;
}

function bunBin(): string {
  return process.env.BUN_BIN ?? 'bun';
}

function runBun(packageRoot: string, argv: string[]): void {
  execFileSync(bunBin(), argv, {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runPrettier(packageRoot: string, targets: string[]): void {
  const prettier = resolve(packageRoot, '../../node_modules/.bin/prettier');
  if (!existsSync(prettier)) return;
  execFileSync(prettier, ['--write', ...targets], {
    cwd: packageRoot,
    stdio: 'ignore',
  });
}

function tmpDir(packageRoot: string): string {
  const dir = join(packageRoot, 'data', 'tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingDir(packageRoot: string, toolName: string): string {
  const dir = join(packageRoot, 'pending', toolName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface FetchedSource {
  key: string;
  url: string;
  outcome: Extract<FetchOutcome, { status: 'fetched' }>;
  /** Where the body was written for converter consumption. */
  downloadPath: string;
}

/**
 * Check every source of one tool. Returns the sources whose content
 * changed (drift), or null when a fetch failed (event already emitted).
 */
async function checkSources(
  tool: RegisteredToolSource,
  options: CheckOptions,
  counters: CheckSummary
): Promise<FetchedSource[] | null> {
  const now = options.now ?? (() => new Date().toISOString());
  const changed: FetchedSource[] = [];
  for (const source of tool.sources) {
    const overrideKey = `${tool.name}/${source.key}`;
    const url = options.sourceOverrides?.[overrideKey] ?? source.url;
    const outcome = await fetchSource({ ...source, url }, tool.specType);
    counters.checked += 1;
    if (outcome.status === 'failed') {
      counters.failed += 1;
      options.emit({
        type: 'check_failed',
        tool: tool.name,
        at: now(),
        data: { sourceKey: source.key, message: outcome.message },
      });
      return null;
    }
    options.emit({
      type: 'source_checked',
      tool: tool.name,
      at: now(),
      data: {
        sourceKey: source.key,
        url,
        specType: tool.specType,
        mechanism: outcome.mechanism,
        httpStatus: outcome.httpStatus,
      },
    });
    if (
      outcome.status === 'not-modified' ||
      outcome.sha256 === source.snapshot?.sha256
    ) {
      counters.unchanged += 1;
      options.emit({
        type: 'source_unchanged',
        tool: tool.name,
        at: now(),
        data: {
          sourceKey: source.key,
          sha256:
            outcome.status === 'fetched'
              ? outcome.sha256
              : (source.snapshot?.sha256 ?? ''),
        },
      });
      if (outcome.status === 'fetched' && source.snapshot) {
        // Refresh validators (a server may mint a new ETag for identical
        // bytes); the hash proves the content itself is unchanged.
        source.snapshot = toSnapshot(outcome, tool.specType, now());
      }
      continue;
    }
    counters.drifted += 1;
    options.emit({
      type: 'drift_detected',
      tool: tool.name,
      at: now(),
      data: {
        sourceKey: source.key,
        url,
        previousSha256: source.snapshot?.sha256 ?? null,
        newSha256: outcome.sha256,
        previousSpecVersion: source.snapshot?.specVersion ?? null,
        newSpecVersion: toSnapshot(outcome, tool.specType, now()).specVersion,
      },
    });
    const downloadPath = join(
      tmpDir(options.packageRoot),
      `${tool.name}-${source.key}`
    );
    writeFileSync(downloadPath, outcome.body, 'utf8');
    changed.push({ key: source.key, url, outcome, downloadPath });
  }
  return changed;
}

/** Substitute `{download:<key>}` placeholders in convert argv. */
function resolveConvertArgs(
  argv: string[],
  fetched: FetchedSource[]
): string[] {
  return argv.map((arg) => {
    const match = arg.match(/^\{download:(.+)\}$/);
    if (!match) return arg;
    const source = fetched.find((f) => f.key === match[1]);
    if (!source) {
      throw new Error(`convert argv references unfetched source ${match[1]}`);
    }
    return source.downloadPath;
  });
}

/**
 * Run the tool's conversion pipeline over the fetched bodies and return
 * {oldFixture, newFixture} text. Leaves the new fixture (and rawTarget)
 * in place; the caller restores them when holding a breaking change.
 */
function runConversion(
  tool: RegisteredToolSource,
  fetched: FetchedSource[],
  options: CheckOptions
): { oldFixtureText: string; newFixtureText: string; backups: Map<string, string> } {
  const { packageRoot } = options;
  const fixturePath = join(packageRoot, tool.pipeline.fixture);
  const backups = new Map<string, string>();
  backups.set(fixturePath, readFileSync(fixturePath, 'utf8'));

  if (tool.pipeline.rawTarget) {
    const rawPath = join(packageRoot, tool.pipeline.rawTarget);
    if (existsSync(rawPath)) {
      backups.set(rawPath, readFileSync(rawPath, 'utf8'));
    }
    const body = fetched.find((f) => f.key === tool.sources[0].key);
    // Single-source tools write their body to the raw target; multi-source
    // manual tools never reach this path (monitoring: 'manual').
    if (body) {
      writeFileSync(rawPath, body.outcome.body, 'utf8');
      if (tool.pipeline.prettierRawTarget) {
        runPrettier(packageRoot, [rawPath]);
      }
    }
  }
  if (tool.pipeline.convert) {
    runBun(packageRoot, resolveConvertArgs(tool.pipeline.convert, fetched));
  }
  // When rawTarget === fixture (Snowflake) the write + prettier above IS the
  // conversion; nothing further to run.
  const oldFixtureText = backups.get(fixturePath) ?? '';
  const newFixtureText = readFileSync(fixturePath, 'utf8');
  return { oldFixtureText, newFixtureText, backups };
}

function restoreBackups(backups: Map<string, string>): void {
  for (const [path, content] of backups) {
    writeFileSync(path, content, 'utf8');
  }
}

function parseFixtureText(
  packageRoot: string,
  toolName: string,
  label: string,
  text: string,
  fixtureName: string
) {
  // loadOpenApi reads from disk; stage the text under data/tmp first.
  const path = join(
    tmpDir(packageRoot),
    `${toolName}-${label}-${basename(fixtureName)}`
  );
  writeFileSync(path, text, 'utf8');
  return loadOpenApi(path);
}

async function checkTool(
  tool: RegisteredToolSource,
  options: CheckOptions,
  counters: CheckSummary
): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const changed = await checkSources(tool, options, counters);
  if (changed === null || changed.length === 0) return;

  if (tool.monitoring === 'manual') {
    for (const source of changed) {
      options.emit({
        type: 'manual_review_required',
        tool: tool.name,
        at: now(),
        data: {
          sourceKey: source.key,
          url: source.url,
          reason:
            'hand-transcribed fixture: reference source changed upstream; ' +
            're-verify the transcription, then run watchdog:apply',
        },
      });
    }
    counters.flagged += 1;
    tool.pendingReview = {
      detectedAt: now(),
      sourceSha256: changed[0].outcome.sha256,
      summary: `reference source(s) changed: ${changed
        .map((c) => c.key)
        .join(', ')} — hand-transcribed fixture must be re-verified`,
      changelog: '',
    };
    for (const source of tool.sources) {
      const match = changed.find((c) => c.key === source.key);
      if (match) {
        source.snapshot = toSnapshot(match.outcome, tool.specType, now());
      }
    }
    return;
  }

  let conversion: ReturnType<typeof runConversion>;
  try {
    conversion = runConversion(tool, changed, options);
  } catch (error) {
    counters.failed += 1;
    options.emit({
      type: 'regeneration_failed',
      tool: tool.name,
      at: now(),
      data: {
        step: 'convert',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  const updateSnapshots = () => {
    for (const source of tool.sources) {
      const match = changed.find((c) => c.key === source.key);
      if (match) {
        source.snapshot = toSnapshot(match.outcome, tool.specType, now());
      }
    }
  };

  if (conversion.newFixtureText === conversion.oldFixtureText) {
    options.emit({
      type: 'subset_unchanged',
      tool: tool.name,
      at: now(),
      data: {
        fixture: tool.pipeline.fixture,
        newSourceSha256: changed[0].outcome.sha256,
      },
    });
    updateSnapshots();
    return;
  }

  // Real drift in the tool's surface: diff old vs new fixture.
  let diff: SpecDiff;
  try {
    const fixtureName = basename(tool.pipeline.fixture);
    const fromDoc = parseFixtureText(
      options.packageRoot,
      tool.name,
      'previous',
      conversion.oldFixtureText,
      fixtureName
    );
    const toDoc = parseFixtureText(
      options.packageRoot,
      tool.name,
      'next',
      conversion.newFixtureText,
      fixtureName
    );
    const config = JSON.parse(
      readFileSync(join(options.packageRoot, tool.pipeline.config), 'utf8')
    ) as { operations: string[] };
    diff = diffSpecs(fromDoc, toDoc, config.operations, fixtureName);
  } catch (error) {
    restoreBackups(conversion.backups);
    counters.failed += 1;
    options.emit({
      type: 'regeneration_failed',
      tool: tool.name,
      at: now(),
      data: {
        step: 'diff',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }

  if (diff.breaking) {
    // Hold: stage the new fixture for review, restore the working tree.
    const staged = join(
      pendingDir(options.packageRoot, tool.name),
      basename(tool.pipeline.fixture)
    );
    copyFileSync(join(options.packageRoot, tool.pipeline.fixture), staged);
    restoreBackups(conversion.backups);
    const changelog = writeChangelog(options.packageRoot, {
      tool,
      diff,
      newSourceSha256: changed[0].outcome.sha256,
      detectedAt: now(),
      action: 'held-for-review',
      changedFiles: [],
    });
    options.emit({
      type: 'changelog_written',
      tool: tool.name,
      at: now(),
      data: { file: changelog, breaking: true },
    });
    options.emit({
      type: 'breaking_change_flagged',
      tool: tool.name,
      at: now(),
      data: { findings: diff.breakingFindings, changelog, held: true },
    });
    counters.flagged += 1;
    tool.pendingReview = {
      detectedAt: now(),
      sourceSha256: changed[0].outcome.sha256,
      summary: diff.breakingFindings.join('; '),
      changelog,
    };
    updateSnapshots();
    return;
  }

  // Non-breaking drift: auto-regenerate.
  options.emit({
    type: 'regeneration_started',
    tool: tool.name,
    at: now(),
    data: { diff },
  });
  const started = Date.now();
  try {
    runBun(options.packageRoot, tool.pipeline.generate);
  } catch (error) {
    restoreBackups(conversion.backups);
    counters.failed += 1;
    options.emit({
      type: 'regeneration_failed',
      tool: tool.name,
      at: now(),
      data: {
        step: 'generate',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  const fingerprints = fingerprintGeneratedFiles(options.repoRoot, tool);
  const changedFiles = Object.entries(fingerprints)
    .filter(([file, hash]) => tool.generatedFiles[file] !== hash)
    .map(([file]) => file);
  const unchangedFiles = Object.keys(fingerprints).filter(
    (file) => !changedFiles.includes(file)
  );
  const changelog = writeChangelog(options.packageRoot, {
    tool,
    diff,
    newSourceSha256: changed[0].outcome.sha256,
    detectedAt: now(),
    action: 'regenerated',
    changedFiles,
  });
  options.emit({
    type: 'changelog_written',
    tool: tool.name,
    at: now(),
    data: { file: changelog, breaking: false },
  });
  options.emit({
    type: 'regenerated',
    tool: tool.name,
    at: now(),
    data: { changedFiles, unchangedFiles, elapsedMs: Date.now() - started },
  });
  counters.regenerated += 1;
  tool.generatedFiles = fingerprints;
  updateSnapshots();
}

/** Run one watchdog cycle over the registry. */
export async function runWatchdogCheck(
  options: CheckOptions
): Promise<CheckSummary> {
  const now = options.now ?? (() => new Date().toISOString());
  const started = Date.now();
  const registry: ToolSourceRegistry = loadRegistry(options.packageRoot);
  const tools = registry.tools.filter(
    (tool) => !options.onlyTool || tool.name === options.onlyTool
  );
  options.emit({
    type: 'run_started',
    at: now(),
    data: { toolCount: tools.length, trigger: options.trigger },
  });
  const counters: CheckSummary = {
    checked: 0,
    unchanged: 0,
    drifted: 0,
    regenerated: 0,
    flagged: 0,
    failed: 0,
  };
  for (const tool of tools) {
    try {
      await checkTool(tool, options, counters);
    } catch (error) {
      counters.failed += 1;
      options.emit({
        type: 'check_failed',
        tool: tool.name,
        at: now(),
        data: {
          sourceKey: null,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  saveRegistry(options.packageRoot, registry);
  options.emit({
    type: 'registry_updated',
    tool: '*',
    at: now(),
    data: { fields: ['snapshots', 'generatedFiles', 'pendingReview'] },
  });
  options.emit({
    type: 'run_complete',
    at: now(),
    data: { ...counters, elapsedMs: Date.now() - started },
  });
  return counters;
}
