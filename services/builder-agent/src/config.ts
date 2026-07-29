/**
 * Sidecar configuration, all overridable via env:
 * - BUILDER_PORT        HTTP port for this sidecar (default 3010; never 3000/3001)
 * - GLUU_API_URL        Bun API base URL the builder tools call (default http://localhost:3001)
 * - DATABASE_URL        repo Postgres for session persistence
 * - BUILDER_CLAUDE_CONFIG_DIR  clean CLAUDE_CONFIG_DIR holding ONLY the Max-login
 *   .credentials.json (keyless auth) and none of the dev box's global hooks/settings.
 *   The global ~/.claude hooks fire inside SDK sessions otherwise (spike gotcha).
 * - BUILDER_PROJECT_KEY session-store scope key (default 'bubblelab-builder')
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
  projectKey: process.env.BUILDER_PROJECT_KEY ?? 'bubblelab-builder',
  model: process.env.BUILDER_MODEL ?? 'claude-sonnet-5',
} as const;
