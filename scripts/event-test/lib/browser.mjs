/**
 * Optional headless-UI wrapper around agent-browser (vercel-labs). Browser use
 * is a temporary bridge only: Pillar 2 says behavior with no logged event MUST
 * gain one, so tests reach for this ONLY while that event does not exist yet.
 *
 * Binary resolution: AGENT_BROWSER_BIN env, else the known local install at
 * /home/unix/vercel-browser-agent/node_modules/.bin/agent-browser.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_BIN = '/home/unix/vercel-browser-agent/node_modules/.bin/agent-browser';

export function createBrowser(session = 'event-test') {
  const bin = process.env.AGENT_BROWSER_BIN ?? DEFAULT_BIN;
  if (!existsSync(bin)) {
    throw new Error(
      `agent-browser binary not found at ${bin}; set AGENT_BROWSER_BIN or install vercel-labs/agent-browser`
    );
  }
  const ab = (args, { json = true, allowFail = false } = {}) => {
    const full = ['--session', session, ...args, ...(json ? ['--json'] : [])];
    try {
      const out = execFileSync(bin, full, {
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return json ? JSON.parse(out) : out;
    } catch (e) {
      if (allowFail) return null;
      throw e;
    }
  };
  return {
    raw: ab,
    open(url) {
      ab(['open', url]);
      ab(['wait', '--load', 'networkidle'], { allowFail: true });
    },
    /** Evaluate JS in the page; IIFE-wrap multi-statement code (eval scope persists per session). */
    evalJs(code) {
      return ab(['eval', code], { allowFail: true })?.data?.result;
    },
    clickText(text) {
      return this.evalJs(
        `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`
      );
    },
    consoleErrors() {
      return ab(['errors'], { allowFail: true });
    },
    close() {
      ab(['close'], { allowFail: true, json: false });
    },
  };
}
