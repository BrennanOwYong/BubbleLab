/**
 * Assertion recording + the one structured report JSON on stdout.
 *
 * Contract (FND.md F0.1): stdout carries exactly one JSON document; stderr
 * carries human PASS/FAIL lines. Full raw events go to an event-dump file
 * under .reports/ (never inlined — agent turns produce hundreds of frames).
 * Exit codes are load-bearing for F0.2:
 *   0 all pass | 1 assertion failed | 2 usage/config | 3 stack unavailable.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.reports');

export function createReporter({ name, backlogId, branch, stack }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const assertions = [];
  const eventDumps = {}; // source label -> raw events
  const artifacts = { flowIds: [], executionIds: [], sessionId: null };
  let currentSection = null;

  return {
    artifacts,
    section(label) {
      currentSection = label;
      console.error(`--- ${label}`);
    },
    assert(assertName, pass, detail) {
      assertions.push({
        section: currentSection,
        name: assertName,
        pass: Boolean(pass),
        ...(detail !== undefined && detail !== null
          ? { detail: String(detail).slice(0, 500) }
          : {}),
      });
      console.error(
        `${pass ? 'PASS' : 'FAIL'}  ${assertName}${detail ? `  — ${String(detail).slice(0, 200)}` : ''}`
      );
      return Boolean(pass);
    },
    /** Register raw events for the dump file; counts land in the report. */
    recordEvents(source, events) {
      (eventDumps[source] ??= []).push(...events);
    },
    /** Assemble the report. Does NOT exit — the harness owns process exit. */
    build() {
      const pass = assertions.length > 0 && assertions.every((a) => a.pass);
      const exitCode = pass ? 0 : 1;
      let eventDumpPath = null;
      const eventCounts = Object.fromEntries(
        Object.entries(eventDumps).map(([k, v]) => [k, v.length])
      );
      if (Object.keys(eventDumps).length > 0) {
        mkdirSync(REPORTS_DIR, { recursive: true });
        eventDumpPath = join(
          REPORTS_DIR,
          `${name.replace(/[^\w.-]/g, '_')}-${Math.floor(t0 / 1000)}.events.json`
        );
        writeFileSync(eventDumpPath, JSON.stringify(eventDumps, null, 2));
      }
      return {
        test: name,
        ...(backlogId ? { backlogId } : {}),
        branch,
        stack,
        startedAt,
        durationMs: Date.now() - t0,
        assertions,
        artifacts,
        eventCounts,
        eventDumpPath,
        pass,
        exitCode,
      };
    },
  };
}
