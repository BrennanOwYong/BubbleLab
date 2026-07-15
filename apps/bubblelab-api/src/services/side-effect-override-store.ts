/**
 * Persistence wiring for the docs-lie correction channel: loads runtime-
 * verified side-effect overrides at boot and persists new corrections as they
 * are observed. File-backed by default (SIDE_EFFECT_OVERRIDES_PATH env var);
 * the Contract KB task (IR-11/12) can swap in a DB-backed store implementing
 * the same SideEffectOverrideStore interface.
 */

import path from 'node:path';
import {
  FileSideEffectOverrideStore,
  getSideEffectOverrideRegistry,
} from '@bubblelab/bubble-core';

export async function configureSideEffectOverridePersistence(): Promise<void> {
  const storePath =
    process.env.SIDE_EFFECT_OVERRIDES_PATH ||
    path.join(process.cwd(), 'data', 'side-effect-overrides.json');
  const registry = getSideEffectOverrideRegistry();
  try {
    await registry.configureStore(new FileSideEffectOverrideStore(storePath));
    const loaded = registry.list().length;
    if (loaded > 0) {
      console.log(
        `[side-effect-overrides] Loaded ${loaded} runtime-verified correction(s) from ${storePath}`
      );
    }
  } catch (error) {
    // A broken store must not block the server; corrections learned in this
    // process stay in memory and detection keeps working.
    console.error(
      `[side-effect-overrides] Failed to load store at ${storePath}:`,
      error
    );
  }
}
