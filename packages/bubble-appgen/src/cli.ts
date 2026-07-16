/**
 * add-a-tool CLI (ADD-ANY-APP pipeline, spec path: S1 acquire -> S2 extract ->
 * S3 contracts -> S4 classify -> S6 emit). Deterministic and offline: the
 * spec is a local file (the cached DocPack), output is the bubble folder.
 *
 * Usage:
 *   bun src/cli.ts --spec fixtures/sqlapi.yaml --config examples/<app>.config.json [--out <dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenApi } from './openapi.js';
import { extractOperations } from './extract.js';
import { classifyOperation } from './classify.js';
import { emitBubble } from './emit-bubble.js';
import type { AppGenConfig } from './types.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const started = performance.now();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const specArg = argValue('--spec');
const configArg = argValue('--config');
if (!specArg || !configArg) {
  console.error(
    'usage: bun src/cli.ts --spec <openapi.yaml> --config <app.config.json> [--out <dir>]'
  );
  process.exit(1);
}

const config = JSON.parse(
  readFileSync(resolve(packageRoot, configArg), 'utf8')
) as AppGenConfig;
const outDir = resolve(
  packageRoot,
  argValue('--out') ??
    `../bubble-core/src/bubbles/service-bubble/${config.appName}`
);

// S1/S2: acquire (local DocPack) + extract
const doc = loadOpenApi(resolve(packageRoot, specArg));
const drafts = extractOperations(doc, config.operations, config.specName);
console.log(`extracted ${drafts.length} operation(s) from ${config.specName}:`);

// S4: classify with provenance
const classified = drafts.map((draft) => {
  const metadata = classifyOperation(draft, config.carrierFields);
  console.log(
    `  ${draft.name} (${draft.method} ${draft.pathTemplate}) -> ${metadata.sideEffect}` +
      `${metadata.unverified ? ' [unverified fail-safe]' : ''} (confidence ${metadata.confidence})`
  );
  return { draft, metadata };
});

// S3+S6: contracts + code emission
const files = emitBubble(config, classified);
mkdirSync(outDir, { recursive: true });
for (const file of files) {
  writeFileSync(join(outDir, file.fileName), file.content);
  console.log(`wrote ${join(outDir, file.fileName)}`);
}

const elapsed = Math.round(performance.now() - started);
console.log(`done in ${elapsed} ms (spec -> typed bubble, deterministic)`);
console.log(
  'next (S7/S8): register the bubble + credential type, then run typecheck and the generated schema tests'
);
