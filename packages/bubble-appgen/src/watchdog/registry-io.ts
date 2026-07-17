/**
 * Registry persistence: registry/tool-sources.json, Zod-validated on every
 * read and written atomically (tmp + rename) so a crashed run can never
 * leave a torn registry behind.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ToolSourceRegistrySchema,
  type ToolSourceRegistry,
} from '@bubblelab/shared-schemas';

export const REGISTRY_RELATIVE_PATH = 'registry/tool-sources.json';

export function registryPath(packageRoot: string): string {
  return join(packageRoot, REGISTRY_RELATIVE_PATH);
}

export function loadRegistry(packageRoot: string): ToolSourceRegistry {
  const raw = readFileSync(registryPath(packageRoot), 'utf8');
  return ToolSourceRegistrySchema.parse(JSON.parse(raw));
}

export function saveRegistry(
  packageRoot: string,
  registry: ToolSourceRegistry
): void {
  const validated = ToolSourceRegistrySchema.parse(registry);
  const path = registryPath(packageRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}
