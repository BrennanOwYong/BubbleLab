/**
 * S8 registration codemod (ADD-A-TOOL-WORKFLOW section 10 / reconciliation
 * item 2): applies the 12-location bubble registration mechanically, per
 * packages/bubble-core/CREATE_BUBBLE_README.md, replacing hand edits.
 *
 * Idempotent: every location checks whether its entry already exists before
 * inserting, so re-running on a wired bubble is a zero-diff no-op.
 *
 * Usage:
 *   bun scripts/register-bubble.ts --config packages/bubble-appgen/examples/<app>.config.json [--dry-run]
 *
 * Locations applied (numbering = the README's 12-location checklist):
 *    1. CredentialType enum                bubble-shared-schemas/src/types.ts
 *    2. CREDENTIAL_CONFIGURATION_MAP       bubble-shared-schemas/src/bubble-definition-schema.ts
 *    3. CREDENTIAL_ENV_MAP                 bubble-shared-schemas/src/credential-schema.ts
 *    4. CREDENTIAL_TYPE_CONFIG + studio typeToServiceMap
 *    5. BUBBLE_CREDENTIAL_OPTIONS          bubble-shared-schemas/src/credential-schema.ts
 *    6. BubbleName union                   bubble-shared-schemas/src/types.ts
 *    7. credential-validator test params   SKIPPED BY DESIGN (validator passes
 *       undefined; the generated constructor defaults are the probe params)
 *    8. SYSTEM_CREDENTIALS auto-injection  SKIPPED BY DESIGN (service
 *       credentials are never auto-injected)
 *    9. factory registerDefaults           bubble-core/src/bubble-factory.ts
 *   10. listBubblesForCodeGenerator        bubble-core/src/bubble-factory.ts
 *   11. core index exports                 bubble-core/src/index.ts
 *   12. studio logos/aliases/matchers      MANUAL (logo SVG + integrations.ts)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppGenConfig,
  BubbleRegistration,
} from '../packages/bubble-appgen/src/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const dryRun = process.argv.includes('--dry-run');
const configArg = argValue('--config');
if (!configArg) {
  console.error(
    'usage: bun scripts/register-bubble.ts --config <app.config.json> [--dry-run]'
  );
  process.exit(1);
}
const config = JSON.parse(
  readFileSync(resolve(repoRoot, configArg), 'utf8')
) as AppGenConfig;
const reg: BubbleRegistration | undefined = config.registration;
if (!reg) {
  console.error(
    `config ${configArg} has no "registration" block; add the S8 facts (envVar, label, description, placeholder, namePlaceholder, configurationFields, serviceLabel, credentialComment) before running the codemod`
  );
  process.exit(1);
}
const registration: BubbleRegistration = reg;

const appName = config.appName;
const cred = config.credentialType;
const bubbleClass = `${config.className}Bubble`;

// ── line-editing helpers ──────────────────────────────────────────────────────

interface SourceFile {
  path: string;
  lines: string[];
  dirty: boolean;
}
const fileCache = new Map<string, SourceFile>();

function open(relPath: string): SourceFile {
  const cached = fileCache.get(relPath);
  if (cached) return cached;
  const path = resolve(repoRoot, relPath);
  const file: SourceFile = {
    path,
    lines: readFileSync(path, 'utf8').split('\n'),
    dirty: false,
  };
  fileCache.set(relPath, file);
  return file;
}

function findLine(
  lines: string[],
  pattern: RegExp,
  from = 0,
  label?: string
): number {
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  throw new Error(`anchor not found: ${label ?? String(pattern)}`);
}

/** Insert `insert` lines at index (before the line currently there). */
function insertAt(file: SourceFile, index: number, insert: string[]): void {
  file.lines.splice(index, 0, ...insert);
  file.dirty = true;
}

interface LocationResult {
  location: string;
  status: 'wired-now' | 'already-wired' | 'skipped-by-design' | 'manual';
  detail: string;
}
const results: LocationResult[] = [];
function report(
  location: string,
  status: LocationResult['status'],
  detail: string
): void {
  results.push({ location, status, detail });
}

/** Quote a BubbleName map key only when it is not a valid identifier. */
function mapKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`;
}
const q = (text: string): string => `'${text.replace(/'/g, "\\'")}'`;

// ── 1. CredentialType enum ────────────────────────────────────────────────────
{
  const file = open('packages/bubble-shared-schemas/src/types.ts');
  const start = findLine(
    file.lines,
    /^export enum CredentialType \{/,
    0,
    'CredentialType enum'
  );
  const end = findLine(file.lines, /^\}/, start, 'CredentialType enum close');
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`${cred} = '${cred}'`));
  if (exists) {
    report('1 CredentialType enum', 'already-wired', cred);
  } else {
    insertAt(file, end, [
      '',
      `  // ${registration.credentialComment}`,
      `  ${cred} = '${cred}',`,
    ]);
    report('1 CredentialType enum', 'wired-now', cred);
  }
}

// ── 6. BubbleName union ───────────────────────────────────────────────────────
{
  const file = open('packages/bubble-shared-schemas/src/types.ts');
  const start = findLine(
    file.lines,
    /^export type BubbleName =/,
    0,
    'BubbleName union'
  );
  const end = findLine(file.lines, /;\s*$/, start, 'BubbleName union close');
  const exists = file.lines
    .slice(start, end + 1)
    .some((l) => l.includes(`| '${appName}'`));
  if (exists) {
    report('6 BubbleName union', 'already-wired', appName);
  } else {
    file.lines[end] = file.lines[end].replace(/;\s*$/, '');
    insertAt(file, end + 1, [`  | '${appName}';`]);
    report('6 BubbleName union', 'wired-now', appName);
  }
}

// ── 2. CREDENTIAL_CONFIGURATION_MAP ───────────────────────────────────────────
{
  const file = open(
    'packages/bubble-shared-schemas/src/bubble-definition-schema.ts'
  );
  const start = findLine(
    file.lines,
    /^export const CREDENTIAL_CONFIGURATION_MAP/,
    0,
    'CREDENTIAL_CONFIGURATION_MAP'
  );
  const end = findLine(
    file.lines,
    /^\};/,
    start,
    'CREDENTIAL_CONFIGURATION_MAP close'
  );
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`[CredentialType.${cred}]:`));
  if (exists) {
    report('2 CREDENTIAL_CONFIGURATION_MAP', 'already-wired', cred);
  } else {
    const fields = Object.entries(registration.configurationFields);
    const entry =
      fields.length === 0
        ? [`  [CredentialType.${cred}]: {},`]
        : [
            `  [CredentialType.${cred}]: {`,
            ...fields.map(
              ([name, type]) => `    ${name}: BubbleParameterType.${type},`
            ),
            '  },',
          ];
    insertAt(file, end, entry);
    report(
      '2 CREDENTIAL_CONFIGURATION_MAP',
      'wired-now',
      `${cred} (${fields.length} config field(s))`
    );
  }
}

// ── 3. CREDENTIAL_ENV_MAP ─────────────────────────────────────────────────────
{
  const file = open('packages/bubble-shared-schemas/src/credential-schema.ts');
  const start = findLine(
    file.lines,
    /^export const CREDENTIAL_ENV_MAP/,
    0,
    'CREDENTIAL_ENV_MAP'
  );
  const end = findLine(file.lines, /^\};/, start, 'CREDENTIAL_ENV_MAP close');
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`[CredentialType.${cred}]:`));
  if (exists) {
    report('3 CREDENTIAL_ENV_MAP', 'already-wired', cred);
  } else {
    const value =
      registration.envVar === ''
        ? `'', // no single env var`
        : `'${registration.envVar}',`;
    insertAt(file, end, [`  [CredentialType.${cred}]: ${value}`]);
    report(
      '3 CREDENTIAL_ENV_MAP',
      'wired-now',
      `${cred} -> ${registration.envVar || '(none)'}`
    );
  }
}

// ── 4a. CREDENTIAL_TYPE_CONFIG ────────────────────────────────────────────────
{
  const file = open('packages/bubble-shared-schemas/src/credential-schema.ts');
  const start = findLine(
    file.lines,
    /^export const CREDENTIAL_TYPE_CONFIG/,
    0,
    'CREDENTIAL_TYPE_CONFIG'
  );
  // Closes with `  } as const satisfies Record<CredentialType, ...>;`
  const end = findLine(
    file.lines,
    /^\s{2}\}/,
    start,
    'CREDENTIAL_TYPE_CONFIG close'
  );
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`[CredentialType.${cred}]:`));
  if (exists) {
    report('4a CREDENTIAL_TYPE_CONFIG', 'already-wired', cred);
  } else {
    insertAt(file, end, [
      `    [CredentialType.${cred}]: {`,
      `      label: ${q(registration.label)},`,
      `      description: ${q(registration.description)},`,
      `      placeholder: ${q(registration.placeholder)},`,
      `      namePlaceholder: ${q(registration.namePlaceholder)},`,
      '      credentialConfigurations: {},',
      '    },',
    ]);
    report('4a CREDENTIAL_TYPE_CONFIG', 'wired-now', registration.label);
  }
}

// ── 5. BUBBLE_CREDENTIAL_OPTIONS ──────────────────────────────────────────────
{
  const file = open('packages/bubble-shared-schemas/src/credential-schema.ts');
  const start = findLine(
    file.lines,
    /^export const BUBBLE_CREDENTIAL_OPTIONS/,
    0,
    'BUBBLE_CREDENTIAL_OPTIONS'
  );
  const end = findLine(
    file.lines,
    /^\};/,
    start,
    'BUBBLE_CREDENTIAL_OPTIONS close'
  );
  const exists = file.lines
    .slice(start, end)
    .some(
      (l) =>
        l.includes(`'${appName}':`) ||
        /^\s*([A-Za-z_$][\w$]*):/.exec(l)?.[1] === appName
    );
  if (exists) {
    report('5 BUBBLE_CREDENTIAL_OPTIONS', 'already-wired', appName);
  } else {
    insertAt(file, end, [`  ${mapKey(appName)}: [CredentialType.${cred}],`]);
    report('5 BUBBLE_CREDENTIAL_OPTIONS', 'wired-now', `${appName} -> ${cred}`);
  }
}

// ── 4b. Studio typeToServiceMap ───────────────────────────────────────────────
{
  const file = open('apps/bubble-studio/src/pages/CredentialsPage.tsx');
  const start = findLine(
    file.lines,
    /const typeToServiceMap: Record<CredentialType, string> = \{/,
    0,
    'typeToServiceMap'
  );
  const end = findLine(file.lines, /^\s*\};/, start, 'typeToServiceMap close');
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`[CredentialType.${cred}]:`));
  if (exists) {
    report('4b studio typeToServiceMap', 'already-wired', cred);
  } else {
    insertAt(file, end, [
      `    [CredentialType.${cred}]: ${q(registration.serviceLabel)},`,
    ]);
    report(
      '4b studio typeToServiceMap',
      'wired-now',
      `${cred} -> ${registration.serviceLabel}`
    );
  }
}

// ── 10. listBubblesForCodeGenerator ───────────────────────────────────────────
{
  const file = open('packages/bubble-core/src/bubble-factory.ts');
  const start = findLine(
    file.lines,
    /listBubblesForCodeGenerator\(\): BubbleName\[\] \{/,
    0,
    'listBubblesForCodeGenerator'
  );
  const end = findLine(
    file.lines,
    /^\s*\];/,
    start,
    'listBubblesForCodeGenerator close'
  );
  const exists = file.lines
    .slice(start, end)
    .some((l) => l.includes(`'${appName}',`));
  if (exists) {
    report('10 listBubblesForCodeGenerator', 'already-wired', appName);
  } else {
    insertAt(file, end, [`      '${appName}',`]);
    report('10 listBubblesForCodeGenerator', 'wired-now', appName);
  }
}

// ── 9. Factory registerDefaults (dynamic import + register) ──────────────────
{
  const file = open('packages/bubble-core/src/bubble-factory.ts');
  const text = file.lines.join('\n');
  const importKey = `./bubbles/service-bubble/${appName}/index.js`;
  const start = findLine(
    file.lines,
    /async registerDefaults\(\): Promise<void> \{/,
    0,
    'registerDefaults'
  );
  if (text.includes(importKey)) {
    report('9a factory dynamic import', 'already-wired', importKey);
  } else {
    const firstRegister = findLine(
      file.lines,
      /^\s*this\.register\(/,
      start,
      'first this.register(...)'
    );
    insertAt(file, firstRegister, [
      `    const { ${bubbleClass} } = await import(`,
      `      '${importKey}'`,
      '    );',
      '',
    ]);
    report('9a factory dynamic import', 'wired-now', bubbleClass);
  }

  const registerPattern = new RegExp(`this\\.register\\(\\s*'${appName}'`, 'm');
  if (registerPattern.test(file.lines.join('\n'))) {
    report('9b factory this.register', 'already-wired', appName);
  } else {
    // After the LAST register statement inside registerDefaults.
    let lastRegister = -1;
    for (let i = start; i < file.lines.length; i++) {
      if (/^\s*this\.register\(/.test(file.lines[i])) lastRegister = i;
    }
    if (lastRegister < 0) throw new Error('no this.register(...) lines found');
    const stmtEnd = findLine(
      file.lines,
      /\);\s*$/,
      lastRegister,
      'register statement end'
    );
    insertAt(file, stmtEnd + 1, [
      `    this.register('${appName}', ${bubbleClass} as BubbleClassWithMetadata);`,
    ]);
    report(
      '9b factory this.register',
      'wired-now',
      `${appName} -> ${bubbleClass}`
    );
  }
}

// ── 11. Core index exports ────────────────────────────────────────────────────
{
  const file = open('packages/bubble-core/src/index.ts');
  const importKey = `./bubbles/service-bubble/${appName}/index.js`;
  if (file.lines.some((l) => l.includes(importKey))) {
    report('11 core index exports', 'already-wired', bubbleClass);
  } else {
    let lastServiceExport = -1;
    for (let i = 0; i < file.lines.length; i++) {
      if (
        /from '\.\/bubbles\/service-bubble\/[^']+\/index\.js';/.test(
          file.lines[i]
        )
      ) {
        lastServiceExport = i;
      }
    }
    if (lastServiceExport < 0)
      throw new Error('no service-bubble exports found in core index.ts');
    insertAt(file, lastServiceExport + 1, [
      `export { ${bubbleClass} } from '${importKey}';`,
      `export type { ${config.className}ParamsInput } from '${importKey}';`,
    ]);
    report('11 core index exports', 'wired-now', bubbleClass);
  }
}

// ── 7 / 8 / 12: by-design skips + manual follow-ups ───────────────────────────
report(
  '7 credential-validator test params',
  'skipped-by-design',
  'validator passes undefined; the generated constructor defaults are the complete probe params'
);
report(
  '8 SYSTEM_CREDENTIALS auto-injection',
  'skipped-by-design',
  'service credentials are never auto-injected (README + ADD-ANY-APP #8)'
);
report(
  '12 studio logos/aliases/matchers',
  'manual',
  `add a logo SVG + entry in apps/bubble-studio/src/lib/integrations.ts for '${appName}' when a logo exists`
);

// ── write + format ────────────────────────────────────────────────────────────
const touched = [...fileCache.values()].filter((f) => f.dirty);
if (!dryRun) {
  for (const file of touched) {
    writeFileSync(file.path, file.lines.join('\n'));
  }
  const prettierBin = resolve(repoRoot, 'node_modules/.bin/prettier');
  if (touched.length > 0 && existsSync(prettierBin)) {
    execFileSync(prettierBin, ['--write', ...touched.map((f) => f.path)], {
      stdio: 'ignore',
    });
  }
}

console.log(
  `register-bubble: ${appName} (${cred})${dryRun ? ' [dry-run]' : ''}`
);
for (const r of results) {
  console.log(`  [${r.status}] ${r.location} — ${r.detail}`);
}
console.log(
  touched.length > 0
    ? `${dryRun ? 'would modify' : 'modified'} ${touched.length} file(s): ${touched
        .map((f) => f.path.replace(repoRoot + '/', ''))
        .join(', ')}`
    : 'no files modified (fully wired already)'
);
console.log(
  'next: rebuild shared-schemas -> bubble-core, then typecheck + run the generated schema tests'
);
