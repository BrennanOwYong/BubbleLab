import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Load services/builder-agent/.env before reading process.env below. Silent
// no-op when the file is absent (prod/CI set real env vars instead). This is
// the ONLY source of OPENROUTER_API_KEY — never committed, gitignored at the
// repo root.
try {
  process.loadEnvFile(resolve(import.meta.dirname, '..', '.env'));
} catch {
  // no .env file present — fine, config below falls back to process.env
}

/**
 * Sidecar configuration, all overridable via env:
 * - BUILDER_PORT        HTTP port for this sidecar (default 3010; never 3000/3001)
 * - GLUU_API_URL        Bun API base URL the builder tools call (default http://localhost:3001)
 * - DATABASE_URL        repo Postgres for session persistence
 * - BUILDER_CLAUDE_CONFIG_DIR  clean CLAUDE_CONFIG_DIR whose .credentials.json
 *   is a SYMLINK to the canonical source (see claude-auth.ts) and which holds
 *   none of the dev box's global hooks/settings — the global ~/.claude hooks
 *   fire inside SDK sessions otherwise (spike gotcha). Provisioned/self-healed
 *   by ensureClaudeAuth() before every turn; never a point-in-time copy (the
 *   copy model rots on refresh-token rotation and clobbers to expiresAt:0).
 *   Unused for auth when OPENROUTER_API_KEY is set (still used for session/
 *   project state dirs).
 * - BUILDER_CLAUDE_CREDENTIALS_SOURCE  canonical Max-login credentials file
 *   the config-dir symlink targets (default ~/.claude/.credentials.json)
 * - OPENROUTER_API_KEY  when set, the agent SDK routes through OpenRouter's
 *   Anthropic-Messages-compatible endpoint (ANTHROPIC_BASE_URL=
 *   https://openrouter.ai/api) instead of the machine's Claude Max OAuth
 *   login — a stable API key, no token-rotation/revocation risk (see
 *   BACKLOG, flow-287 401 incident). Read from services/builder-agent/.env
 *   (gitignored), never from a Max-login credentials file.
 *   Docs: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
 * - BUILDER_PROJECT_KEY session-store scope key (default 'bubblelab-builder')
 * - BUILDER_SERVE_MODE  who launched this process (FE5 serve-identity stamp):
 *   'managed' when spawned by the API's builder runtime manager, 'external'
 *   (default) when launched by dev-stack.sh or by hand. The child cannot
 *   infer its launcher, so the spawner declares it.
 */
export const config = {
  port: Number(process.env.BUILDER_PORT ?? 3010),
  gluuApiUrl: process.env.GLUU_API_URL ?? 'http://localhost:3001',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://bubblelab:bubblelab@localhost:5432/bubblelab',
  claudeConfigDir:
    process.env.BUILDER_CLAUDE_CONFIG_DIR ??
    '/home/unix/builder-agent-claude-config',
  claudeCredentialsSource:
    process.env.BUILDER_CLAUDE_CREDENTIALS_SOURCE ??
    join(homedir(), '.claude', '.credentials.json'),
  projectKey: process.env.BUILDER_PROJECT_KEY ?? 'bubblelab-builder',
  model:
    process.env.BUILDER_MODEL ??
    (process.env.OPENROUTER_API_KEY ? 'z-ai/glm-5.2' : 'claude-sonnet-5'),
  serveMode:
    process.env.BUILDER_SERVE_MODE === 'managed' ? 'managed' : 'external',
  /** Set -> route the agent SDK through OpenRouter instead of Claude Max OAuth. */
  openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
  openrouterBaseUrl: 'https://openrouter.ai/api',
} as const;
