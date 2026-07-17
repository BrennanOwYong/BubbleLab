/**
 * Tool source-of-truth watchdog scheduler (spec-drift watchdog, layer 2).
 *
 * Runs the bubble-appgen watchdog check cycle on an interval, in-process,
 * following the CronScheduler pattern (tick loop, enabled flag, console
 * logger). The cycle itself executes as `bun scripts/watchdog-check.ts`
 * inside packages/bubble-appgen — the SAME script a human runs — with the
 * JSONL event stream relayed: every ToolWatchdogEvent is Zod-validated,
 * mirrored to the server log, and appended to data/tool-watchdog-events.jsonl
 * so tests and the status route can assert on the full decision history.
 *
 * Interval default: 6h. Spec sources move on the scale of days/weeks, and
 * every mechanism is conditional-request or hash-gated, so hourly polling
 * buys nothing (see fetch-source.ts probe notes).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import {
  ToolWatchdogEventSchema,
  type ToolWatchdogEvent,
} from '@bubblelab/shared-schemas';

export interface ToolSourceWatchdogOptions {
  enabled?: boolean;
  intervalMs?: number;
  /** Delay before the first check after boot. */
  initialDelayMs?: number;
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
  /** Monorepo root; the API dev server runs with cwd = apps/bubblelab-api. */
  repoRoot?: string;
  /** Events file; JSONL, append-only. */
  eventsPath?: string;
}

export class ToolSourceWatchdog {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  private lastEvents: ToolWatchdogEvent[] = [];
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly logger: Pick<Console, 'log' | 'error' | 'warn'>;
  private readonly repoRoot: string;
  private readonly eventsPath: string;

  constructor(options: ToolSourceWatchdogOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.initialDelayMs = options.initialDelayMs ?? 30_000;
    this.logger = options.logger ?? console;
    this.repoRoot = options.repoRoot ?? resolve(process.cwd(), '../..');
    this.eventsPath =
      options.eventsPath ??
      join(process.cwd(), 'data', 'tool-watchdog-events.jsonl');
  }

  start(): void {
    if (!this.enabled) {
      this.logger.log('[tool-watchdog] disabled (enabled=false)');
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.logger.log(
      `[tool-watchdog] starting; first check in ${this.initialDelayMs}ms, ` +
        `interval ${this.intervalMs}ms`
    );
    this.timer = setTimeout(() => void this.tick(), this.initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.logger.log('[tool-watchdog] stopped');
  }

  /** Events observed during the most recent completed cycle. */
  recentEvents(): ToolWatchdogEvent[] {
    return this.lastEvents;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Run one check cycle now (also used by the manual-trigger route). */
  async runOnce(
    trigger: 'schedule' | 'manual'
  ): Promise<{ events: ToolWatchdogEvent[]; exitCode: number }> {
    if (this.running) {
      return { events: [], exitCode: -1 };
    }
    this.running = true;
    const events: ToolWatchdogEvent[] = [];
    const appgenRoot = join(this.repoRoot, 'packages', 'bubble-appgen');
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    try {
      const exitCode = await new Promise<number>((resolvePromise, reject) => {
        const child = spawn(
          process.env.BUN_BIN ?? 'bun',
          ['scripts/watchdog-check.ts', '--trigger', trigger],
          { cwd: appgenRoot, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        const lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (!line.startsWith('{')) return;
          const parsed = ToolWatchdogEventSchema.safeParse(JSON.parse(line));
          if (!parsed.success) {
            this.logger.warn(`[tool-watchdog] unrecognized event: ${line}`);
            return;
          }
          const event = parsed.data;
          events.push(event);
          const tool = 'tool' in event ? event.tool : '*';
          this.logger.log(`[tool-watchdog] ${event.type} ${tool}`);
          appendFileSync(this.eventsPath, `${line}\n`, 'utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
          this.logger.warn(`[tool-watchdog] stderr: ${chunk.toString().trim()}`);
        });
        child.on('error', reject);
        child.on('close', (code) => resolvePromise(code ?? 0));
      });
      this.lastEvents = events;
      return { events, exitCode };
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const { events, exitCode } = await this.runOnce('schedule');
      const summary = events.find((event) => event.type === 'run_complete');
      this.logger.log(
        `[tool-watchdog] cycle done exit=${exitCode} ` +
          (summary && summary.type === 'run_complete'
            ? JSON.stringify(summary.data)
            : '(no summary event)')
      );
    } catch (error) {
      this.logger.error('[tool-watchdog] cycle error', error);
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      }
    }
  }
}

let singleton: ToolSourceWatchdog | undefined;

export function startToolSourceWatchdog(): ToolSourceWatchdog {
  const enabled =
    (process.env.TOOL_WATCHDOG_ENABLED ?? 'true') === 'true' &&
    process.env.BUBBLE_ENV !== 'test';
  singleton = new ToolSourceWatchdog({
    enabled,
    intervalMs: Number(process.env.TOOL_WATCHDOG_INTERVAL_MS ?? 21_600_000),
    initialDelayMs: Number(process.env.TOOL_WATCHDOG_INITIAL_DELAY_MS ?? 30_000),
    logger: console,
  });
  singleton.start();
  return singleton;
}

export function getToolSourceWatchdog(): ToolSourceWatchdog | undefined {
  return singleton;
}
