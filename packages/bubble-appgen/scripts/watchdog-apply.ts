/**
 * Apply a held (breaking / manual-review) source change after human review.
 *
 * For auto-monitored tools: promotes the staged fixture from
 * pending/<tool>/ into fixtures/, re-runs the generator, refreshes the
 * generated-file fingerprints, re-snapshots the sources, and clears
 * pendingReview. For manual tools (hand-transcribed fixtures): assumes the
 * human already re-verified/edited the fixture, then does the same
 * regenerate + refresh + clear.
 *
 * Usage: bun scripts/watchdog-apply.ts --tool <name>
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  fetchSource,
  toSnapshot,
} from '../src/watchdog/fetch-source.js';
import { fingerprintGeneratedFiles } from '../src/watchdog/check.js';
import { loadRegistry, saveRegistry } from '../src/watchdog/registry-io.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '../..');

const toolFlag = process.argv.indexOf('--tool');
const toolName = toolFlag >= 0 ? process.argv[toolFlag + 1] : undefined;
if (!toolName) {
  console.error('usage: bun scripts/watchdog-apply.ts --tool <name>');
  process.exit(1);
}

const registry = loadRegistry(packageRoot);
const tool = registry.tools.find((t) => t.name === toolName);
if (!tool) {
  console.error(`tool not registered: ${toolName}`);
  process.exit(1);
}
if (!tool.pendingReview) {
  console.error(`${toolName}: nothing pending review`);
  process.exit(1);
}

const staged = join(
  packageRoot,
  'pending',
  tool.name,
  basename(tool.pipeline.fixture)
);
if (tool.monitoring === 'auto') {
  if (!existsSync(staged)) {
    console.error(`${toolName}: no staged fixture at ${staged}`);
    process.exit(1);
  }
  copyFileSync(staged, join(packageRoot, tool.pipeline.fixture));
  console.log(`promoted ${staged} -> ${tool.pipeline.fixture}`);
}

execFileSync(process.env.BUN_BIN ?? 'bun', tool.pipeline.generate, {
  cwd: packageRoot,
  stdio: 'inherit',
});

tool.generatedFiles = fingerprintGeneratedFiles(repoRoot, tool);
for (const source of tool.sources) {
  const outcome = await fetchSource({ ...source, snapshot: null }, tool.specType);
  if (outcome.status === 'fetched') {
    source.snapshot = toSnapshot(
      outcome,
      tool.specType,
      new Date().toISOString()
    );
  }
}
tool.pendingReview = null;
saveRegistry(packageRoot, registry);
if (existsSync(staged)) rmSync(staged);
console.log(
  `${toolName}: applied — regenerated, fingerprints refreshed, review flag cleared`
);
console.log(
  'next: pnpm --filter @bubblelab/bubble-core typecheck && commit the regenerated files'
);
