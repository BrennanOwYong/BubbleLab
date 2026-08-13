/**
 * Stack resolution: which API / sidecar / studio base URLs the test drives.
 *
 * Resolution order per value (FND.md F0.1 interface):
 *   explicit opts > EVENT_TEST_{API,SIDECAR,STUDIO}_URL env > .dev-stack/<slug>.pids
 *   for the current branch > StackUnavailableError (exitCode 3).
 *
 * The pidfile format comes from scripts/dev-stack.sh:21-25: one line per
 * service, `<pid> <svc> <port>`, svc in api|sidecar|studio; SLUG = branch with
 * '/ .' mapped to '_'. Pids can go stale while the port stays served (the API
 * supervisor loop respawns with a new pid), so the HTTP probe is the
 * authority; kill -0 liveness is informational only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT_STACK_UNAVAILABLE = 3;

export class StackUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StackUnavailableError';
    this.exitCode = EXIT_STACK_UNAVAILABLE;
  }
}

export function repoRoot() {
  // scripts/event-test/lib/stack.mjs -> repo root is three levels up.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function currentBranch() {
  try {
    return execFileSync('git', ['-C', repoRoot(), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'detached';
  }
}

function pidfilePorts() {
  const slug = currentBranch().replace(/[/ .]/g, '_');
  const pidfile = join(repoRoot(), '.dev-stack', `${slug}.pids`);
  if (!existsSync(pidfile)) return null;
  const ports = {};
  for (const line of readFileSync(pidfile, 'utf8').split('\n')) {
    const [pid, svc, port] = line.trim().split(/\s+/);
    if (pid && svc && port) ports[svc] = { pid: Number(pid), port: Number(port) };
  }
  return Object.keys(ports).length > 0 ? { pidfile, ports } : null;
}

async function probe(url, okCodes, timeoutMs = 4000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return okCodes.includes(res.status);
  } catch {
    return false;
  }
}

/**
 * Resolve and health-probe the stack. `api` and `sidecar` must answer; the
 * studio is optional (Pillar 2 prefers logged events over the browser).
 * Returns { api, sidecar, studio, source, branch }.
 * Throws StackUnavailableError (exitCode 3) on any required-probe failure:
 * infra problem, not a code failure — callers must never report it as a red.
 */
export async function resolveStack(opts = {}) {
  const branch = currentBranch();
  let source = 'explicit';
  let api = opts.api ?? process.env.EVENT_TEST_API_URL ?? null;
  let sidecar = opts.sidecar ?? process.env.EVENT_TEST_SIDECAR_URL ?? null;
  let studio = opts.studio ?? process.env.EVENT_TEST_STUDIO_URL ?? null;
  if (!opts.api && process.env.EVENT_TEST_API_URL) source = 'env';

  if (!api || !sidecar) {
    const pf = pidfilePorts();
    if (!pf) {
      if (!api) {
        throw new StackUnavailableError(
          `no API url: no flag, no EVENT_TEST_API_URL, no .dev-stack pidfile for branch '${branch}' — run scripts/dev-stack.sh up`
        );
      }
    } else {
      source = api ? source : 'pidfile';
      api = api ?? (pf.ports.api ? `http://localhost:${pf.ports.api.port}` : null);
      sidecar = sidecar ?? (pf.ports.sidecar ? `http://localhost:${pf.ports.sidecar.port}` : null);
      studio = studio ?? (pf.ports.studio ? `http://localhost:${pf.ports.studio.port}` : null);
    }
  }
  if (!api) throw new StackUnavailableError('API base url unresolved');

  if (!(await probe(`${api}/`, [200]))) {
    throw new StackUnavailableError(`API health probe failed at ${api}/ — stack down?`);
  }
  if (sidecar && !(await probe(`${sidecar}/health`, [200]))) {
    throw new StackUnavailableError(`sidecar health probe failed at ${sidecar}/health`);
  }
  const studioUp = studio ? await probe(`${studio}/`, [200]) : false;

  return { api, sidecar, studio: studioUp ? studio : studio, studioUp, source, branch };
}
