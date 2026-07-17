/**
 * Changelog rendering: one markdown file per drift detection, written to
 * changelogs/<tool>/<yyyy-mm-dd>-<shortSha>.md inside bubble-appgen. The
 * file is the human review artifact for the drift — what moved upstream,
 * per operation and field, with breaking findings called out first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  RegisteredToolSource,
  SpecDiff,
  SpecFieldChange,
} from '@bubblelab/shared-schemas';

export interface ChangelogInput {
  tool: RegisteredToolSource;
  diff: SpecDiff;
  newSourceSha256: string;
  detectedAt: string;
  /** What the watchdog did about it. */
  action: 'regenerated' | 'held-for-review';
  /** Files the regeneration changed (empty when held). */
  changedFiles: string[];
}

function line(change: SpecFieldChange): string {
  const movement =
    change.from !== null || change.to !== null
      ? ` (${change.from ?? '—'} -> ${change.to ?? '—'})`
      : '';
  const marker = change.breaking ? '**BREAKING** ' : '';
  return `- ${marker}\`${change.kind}\` at \`${change.path}\`${movement}`;
}

export function renderChangelog(input: ChangelogInput): string {
  const { tool, diff, action } = input;
  const parts: string[] = [];
  parts.push(`# ${tool.name} — source drift ${input.detectedAt}`);
  parts.push('');
  parts.push(`- source sha256 (new): \`${input.newSourceSha256}\``);
  parts.push(
    `- spec version: ${diff.infoVersion.from ?? '—'} -> ${diff.infoVersion.to ?? '—'}`
  );
  parts.push(`- docs: ${tool.docsUrl}`);
  parts.push(
    `- action: ${
      action === 'regenerated'
        ? `auto-regenerated (${input.changedFiles.length} file(s) changed)`
        : 'HELD FOR REVIEW — generated files untouched; run `pnpm watchdog:apply --tool ' +
          tool.name +
          '` after review'
    }`
  );
  parts.push('');
  if (diff.breakingFindings.length > 0) {
    parts.push('## Breaking findings');
    parts.push('');
    for (const finding of diff.breakingFindings) {
      parts.push(`- **${finding}**`);
    }
    parts.push('');
  }
  if (diff.removedOperations.length > 0) {
    parts.push('## Removed operations');
    parts.push('');
    for (const op of diff.removedOperations) {
      parts.push(`- \`${op.operationId}\` (${op.method} ${op.path})`);
    }
    parts.push('');
  }
  if (diff.addedOperations.length > 0) {
    parts.push('## Added operations (in the tool selection)');
    parts.push('');
    for (const op of diff.addedOperations) {
      parts.push(`- \`${op.operationId}\` (${op.method} ${op.path})`);
    }
    parts.push('');
  }
  if (diff.changedOperations.length > 0) {
    parts.push('## Changed operations');
    parts.push('');
    for (const op of diff.changedOperations) {
      parts.push(`### \`${op.operationId}\` (${op.method} ${op.path})`);
      parts.push('');
      for (const change of op.changes) {
        parts.push(line(change));
      }
      parts.push('');
    }
  }
  if (input.changedFiles.length > 0) {
    parts.push('## Regenerated files');
    parts.push('');
    for (const file of input.changedFiles) {
      parts.push(`- \`${file}\``);
    }
    parts.push('');
  }
  return `${parts.join('\n')}\n`;
}

/** Write the changelog; returns the path relative to the package root. */
export function writeChangelog(
  packageRoot: string,
  input: ChangelogInput
): string {
  const day = input.detectedAt.slice(0, 10);
  const short = input.newSourceSha256.slice(0, 8);
  const relative = join('changelogs', input.tool.name, `${day}-${short}.md`);
  const absolute = join(packageRoot, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, renderChangelog(input), 'utf8');
  return relative;
}
