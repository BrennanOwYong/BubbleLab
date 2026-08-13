/**
 * FE5 — builder runtime manager: the sidecar as a switchable backend
 * subroutine (brief: PLAN-DOCS/discovery/FE5.md).
 *
 * Single owner of the build-routing switch and the managed child lifecycle.
 * Mode is process-local, in-memory, initialized from env BUILDER_MODE
 * (default 'external' = today's behavior; an API restart returns to the env
 * default — acceptable for an ops toggle):
 *
 *   external -> getBuilderTarget() = BUILDER_AGENT_URL (or the PUT-supplied
 *               url); no child process. The sidecar restarts independently.
 *   managed  -> the API spawns `node src/index.ts` in services/builder-agent
 *               on a probed free port, supervises it (drain via
 *               /health.activeBuilds, SIGTERM by exact pid — never a pattern
 *               kill, per the supervisor-restart-gotchas memory), and routes
 *               builds to it.
 *   off      -> getBuilderTarget() = null; the proxy routes answer 503
 *               {error:'builder_disabled'} and emit the
 *               `build_rejected_builder_off` event (Pillar 2).
 *
 * Every transition emits `builder_runtime.*` events to BOTH the structured
 * console sink ([TELEMETRY]) and the queryable /telemetry ring buffer, so the
 * FE5 acceptance test asserts on logged events, never process inspection.
 *
 * Toggle surface: routes/build-runtime.ts (GET/PUT /build-runtime,
 * POST /build-runtime/restart — the S8 stale-auth heal seam).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { emitApiTelemetry } from '../middleware/telemetry.js';
import { recordServerTelemetryEvent } from '../routes/telemetry.js';

export const BUILDER_MODES = ['external', 'managed', 'off'] as const;
export type BuilderMode = (typeof BUILDER_MODES)[number];

/** Sidecar /health shape (services/builder-agent/src/index.ts; FE5 adds pid/activeBuilds/serveMode). */
const sidecarHealthSchema = z.object({
  ok: z.boolean(),
  service: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  activeBuilds: z.number().optional(),
  serveMode: z.string().optional(),
});
export type SidecarHealth = z.infer<typeof sidecarHealthSchema>;

export interface BuilderRuntimeStatus {
  mode: BuilderMode;
  target: string | null;
  externalUrl: string;
  child: {
    pid: number;
    port: number;
    startedAt: string;
    logPath: string;
  } | null;
  health: SidecarHealth | null;
}

interface ManagedChild {
  proc: ChildProcess;
  pid: number;
  port: number;
  startedAt: string;
  logPath: string;
}

// The sidecar package, resolved from this source file (src/services/ -> repo
// root -> services/builder-agent). BUILDER_AGENT_DIR overrides for bundled
// (dist) deployments where import.meta.url no longer sits inside src/.
const SIDECAR_DIR =
  process.env.BUILDER_AGENT_DIR ??
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'services',
    'builder-agent'
  );
const LOG_DIR = process.env.BUILDER_MANAGED_LOG_DIR ?? '/tmp/bubblelab-logs';
const HEALTH_POLL_MS = 500;
const SPAWN_HEALTH_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 10_000;

function envMode(): BuilderMode {
  const raw = process.env.BUILDER_MODE;
  return raw === 'managed' || raw === 'off' ? raw : 'external';
}

let mode: BuilderMode = envMode();
let externalUrl = process.env.BUILDER_AGENT_URL ?? 'http://localhost:3010';
let child: ManagedChild | null = null;
// Transitions are serialized so a PUT racing a restart never double-spawns.
let transition: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Emit to both Pillar-2 sinks: [TELEMETRY] console line + /telemetry ring buffer. */
function record(event: string, data: Record<string, unknown> = {}): void {
  emitApiTelemetry(event, data);
  recordServerTelemetryEvent({ event, ...data });
}

function targetFor(m: BuilderMode): string | null {
  if (m === 'external') return externalUrl;
  if (m === 'managed')
    return child !== null ? `http://localhost:${child.port}` : null;
  return null;
}

/** Base URL builds route to right now, or null when the builder is off/unavailable. */
export function getBuilderTarget(): string | null {
  return targetFor(mode);
}

/**
 * Shared-secret header for every request to builder-agent. In 'external'
 * mode (a real deployment, e.g. Render) builder-agent is a public web
 * service with no platform-level network isolation, so this header is the
 * only thing stopping a stranger who finds its URL from calling it — the
 * app-layer substitute for a private service Render would otherwise charge
 * for. In 'managed' mode the spawned child inherits this same env var via
 * the `...process.env` spread in spawnChild, so the header still matches;
 * harmless when BUILDER_AGENT_SECRET is unset (local dev — builder-agent's
 * own check only enforces the header when ITS OWN copy of the secret is
 * also set, so an empty local dev setup stays open on both sides).
 */
export function builderAuthHeaders(): Record<string, string> {
  const secret = process.env.BUILDER_AGENT_SECRET;
  return secret ? { 'x-builder-secret': secret } : {};
}

export function getBuilderMode(): BuilderMode {
  return mode;
}

/**
 * The off-mode short-circuit shared by the /build*, /build-page* and /page
 * data-plane proxies: one 503 shape, one logged event
 * (`build_rejected_builder_off {path, subjectId}` — the Pillar-2 event for
 * the "around the sidecar" case). The message is customer-safe (no ports,
 * no "sidecar"), per PRODUCT-PRINCIPLES.md.
 */
export function builderDisabledResponse(
  path: string,
  subjectId: number,
  userId?: string
): Response {
  record('build_rejected_builder_off', {
    path,
    subjectId,
    ...(userId !== undefined ? { userId } : {}),
    mode,
  });
  return Response.json(
    {
      error: 'builder_disabled',
      message: 'The builder is temporarily offline. Please try again shortly.',
    },
    { status: 503 }
  );
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close(() => reject(new Error('freePort: no address assigned')));
        return;
      }
      const { port } = address;
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

async function fetchHealth(base: string): Promise<SidecarHealth | null> {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
      headers: builderAuthHeaders(),
    });
    if (!res.ok) return null;
    const parsed = sidecarHealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** This API's own base URL, so the child's tools call back into the right stack. */
function selfApiUrl(): string {
  return (
    process.env.NODEX_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
  );
}

let shutdownHooksRegistered = false;
function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  const killChild = () => {
    if (child !== null) {
      try {
        child.proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', killChild);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killChild();
      process.exit(0);
    });
  }
}

/**
 * Spawn one managed sidecar: probe a free port, launch `node src/index.ts`
 * (NODE env-resolved binary — the /mnt/c PATH-poisoning memory), pipe output
 * to a log file, poll /health until ready. Bounded retry covers the
 * probe-then-listen port race (FE5 risk 5).
 */
async function spawnChild(): Promise<ManagedChild> {
  registerShutdownHooks();
  let lastError = new Error('spawnChild: no attempt ran');
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = await freePort();
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = join(LOG_DIR, `managed-sidecar-${port}.log`);
    const logFd = openSync(logPath, 'a');
    const proc = spawn(process.env.NODE ?? 'node', ['src/index.ts'], {
      cwd: SIDECAR_DIR,
      env: {
        ...process.env,
        BUILDER_PORT: String(port),
        GLUU_API_URL: selfApiUrl(),
        BUILDER_SERVE_MODE: 'managed',
      },
      stdio: ['ignore', logFd, logFd],
      detached: false,
    });
    const startedAt = new Date().toISOString();
    const pid = proc.pid;
    if (pid === undefined) {
      lastError = new Error('spawnChild: spawn returned no pid');
      continue;
    }
    let exited = false;
    proc.once('exit', () => {
      exited = true;
    });
    const base = `http://localhost:${port}`;
    const deadline = Date.now() + SPAWN_HEALTH_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      if ((await fetchHealth(base)) !== null) {
        healthy = true;
        break;
      }
      await sleep(HEALTH_POLL_MS);
    }
    if (!healthy) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      lastError = new Error(
        `managed sidecar on port ${port} never became healthy (attempt ${attempt}; log: ${logPath})`
      );
      continue;
    }
    const managed: ManagedChild = { proc, pid, port, startedAt, logPath };
    // If the child dies underneath us, stop routing to the dead port.
    proc.once('exit', (code, exitSignal) => {
      if (child !== null && child.pid === pid) {
        child = null;
        record('builder_runtime.child_exited', {
          pid,
          port,
          code,
          signal: exitSignal,
          expected: false,
        });
      }
    });
    record('builder_runtime.child_spawned', { pid, port, logPath });
    return managed;
  }
  throw lastError;
}

/**
 * Drain (wait for /health.activeBuilds === 0), then SIGTERM by exact pid,
 * escalating to SIGKILL after a timeout. Never a pattern kill.
 */
async function drainAndStop(target: ManagedChild): Promise<void> {
  const base = `http://localhost:${target.port}`;
  const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const health = await fetchHealth(base);
    if (health === null || (health.activeBuilds ?? 0) === 0) break;
    if (Date.now() > drainDeadline) {
      record('builder_runtime.drain_timeout', {
        pid: target.pid,
        activeBuilds: health.activeBuilds ?? null,
      });
      break;
    }
    await sleep(HEALTH_POLL_MS);
  }
  const exitPromise = new Promise<void>((resolveExit) => {
    if (target.proc.exitCode !== null || target.proc.killed) {
      resolveExit();
      return;
    }
    target.proc.once('exit', () => resolveExit());
  });
  try {
    target.proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const killed = await Promise.race([
    exitPromise.then(() => true),
    sleep(KILL_TIMEOUT_MS).then(() => false),
  ]);
  if (!killed) {
    try {
      target.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await exitPromise;
  }
  record('builder_runtime.child_stopped', {
    pid: target.pid,
    port: target.port,
    forced: !killed,
  });
}

async function applyMode(next: BuilderMode, url?: string): Promise<void> {
  const from = mode;
  if (url !== undefined) {
    externalUrl = url;
  }
  if (next === 'managed') {
    if (child === null) {
      child = await spawnChild();
    }
  } else if (child !== null) {
    const stopping = child;
    child = null; // de-route first so no request lands mid-kill
    await drainAndStop(stopping);
  }
  mode = next;
  record('builder_runtime.mode_changed', {
    from,
    to: next,
    target: targetFor(next),
    childPid: child?.pid ?? null,
  });
}

/** Serialized mode switch (the PUT /build-runtime handler). */
export function setBuilderMode(
  next: BuilderMode,
  url?: string
): Promise<BuilderRuntimeStatus> {
  const run = transition.then(async () => {
    await applyMode(next, url);
    return getBuilderRuntimeStatus();
  });
  transition = run.catch(() => undefined);
  return run;
}

/**
 * Kill + respawn the managed child (the S8 heal seam: a stale-auth sidecar
 * becomes one API call to fix instead of a manual op). Managed mode only.
 */
export function restartBuilderRuntime(): Promise<BuilderRuntimeStatus> {
  const run = transition.then(async () => {
    if (mode !== 'managed') {
      throw new Error(
        `restart requires mode 'managed' (current mode: '${mode}')`
      );
    }
    const stopping = child;
    child = null;
    if (stopping !== null) {
      await drainAndStop(stopping);
    }
    child = await spawnChild();
    record('builder_runtime.restarted', {
      previousPid: stopping?.pid ?? null,
      pid: child.pid,
      port: child.port,
    });
    return getBuilderRuntimeStatus();
  });
  transition = run.catch(() => undefined);
  return run;
}

/** Live status for the ops endpoint and the acceptance test. */
export async function getBuilderRuntimeStatus(): Promise<BuilderRuntimeStatus> {
  const target = getBuilderTarget();
  return {
    mode,
    target,
    externalUrl,
    child:
      child !== null
        ? {
            pid: child.pid,
            port: child.port,
            startedAt: child.startedAt,
            logPath: child.logPath,
          }
        : null,
    health: target !== null ? await fetchHealth(target) : null,
  };
}

/**
 * Boot-time init (called once from src/index.ts after migrations): under
 * env BUILDER_MODE=managed the API spawns its child immediately so the stack
 * comes up complete. A spawn failure logs + leaves the mode managed with no
 * child (builds 503 until a PUT/restart heals it) — the API must still boot.
 */
export async function initBuilderRuntime(): Promise<void> {
  registerShutdownHooks();
  record('builder_runtime.init', { mode, externalUrl });
  if (mode === 'managed') {
    try {
      child = await spawnChild();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record('builder_runtime.init_spawn_failed', { error: message });
      console.error(
        `[builder-runtime] managed spawn at boot failed: ${message}`
      );
    }
  }
}
