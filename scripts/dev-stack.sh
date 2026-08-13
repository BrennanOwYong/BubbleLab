#!/usr/bin/env bash
# dev-stack.sh — bring up a full BubbleLab dev stack for THIS checkout/branch on
# auto-detected free ports, wired together, and print the frontend URL to open.
#
# The app needs three processes to be fully usable:
#   - studio  (vite frontend)              -> talks to the API
#   - api     (bun backend, apps/bubblelab-api)
#   - sidecar (node builder agent, services/builder-agent) -> the /build and /build-page agent
#
# Usage:
#   scripts/dev-stack.sh up      # start all three on free ports, print the frontend URL (default)
#   scripts/dev-stack.sh down    # stop the stack started from this checkout (kills by exact PID)
#   scripts/dev-stack.sh status  # show this checkout's stack + ports
#
# Overridable via env: DATABASE_URL, BUILDER_CLAUDE_CONFIG_DIR,
#   BUILDER_CLAUDE_CREDENTIALS_SOURCE, BUN, NODE, PORT_BASE, BUILDER_MODE
#
# BUILDER_MODE (FE5, default external):
#   external -> launch the sidecar as a stack process (today's behavior);
#               the API routes builds to BUILDER_AGENT_URL.
#   managed  -> skip the sidecar launch; the API spawns and supervises its own
#               sidecar child (see apps/bubblelab-api/src/services/
#               builder-runtime.ts). The stack becomes two processes.
#
# Assumes the workspace is already built (bun/node run the TS entrypoints directly).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
SLUG="$(printf '%s' "$BRANCH" | tr '/ .' '___')"
LOG_DIR="/tmp/bubblelab-logs"
STATE_DIR="$REPO_ROOT/.dev-stack"
PIDFILE="$STATE_DIR/${SLUG}.pids"
mkdir -p "$LOG_DIR" "$STATE_DIR"

BUN="${BUN:-$HOME/.bun/bin/bun}"
NODE="${NODE:-node}"
DATABASE_URL="${DATABASE_URL:-postgres://bubblelab:bubblelab@localhost:5432/bubblelab}"
BUILDER_CLAUDE_CONFIG_DIR="${BUILDER_CLAUDE_CONFIG_DIR:-/home/unix/builder-agent-claude-config}"
# Canonical Max-login credentials file the sidecar symlinks into its config dir
# (S8, claude-auth.ts). Default matches the sidecar's own default; override is
# for tests.
BUILDER_CLAUDE_CREDENTIALS_SOURCE="${BUILDER_CLAUDE_CREDENTIALS_SOURCE:-$HOME/.claude/.credentials.json}"
PORT_BASE="${PORT_BASE:-3100}"
BUILDER_MODE="${BUILDER_MODE:-external}"

port_free() { ! ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

find_free_port() {
  local p="$1"
  while :; do port_free "$p" && { echo "$p"; return; }; p=$((p + 1)); done
}

# wait until $1 (a URL) returns any of the space-separated codes in $2, within $3 seconds
wait_http() {
  local url="$1" ok=" $2 " t="${3:-60}" code
  for ((i = 0; i < t; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || echo 000)
    [[ "$ok" == *" $code "* ]] && return 0
    sleep 1
  done
  return 1
}

cmd_up() {
  local API_PORT SIDE_PORT STUDIO_PORT
  API_PORT="$(find_free_port "$PORT_BASE")"
  SIDE_PORT="$(find_free_port $((API_PORT + 1)))"
  STUDIO_PORT="$(find_free_port $((SIDE_PORT + 1)))"

  : >"$PIDFILE"

  echo "Starting stack for branch '$BRANCH'  (API:$API_PORT sidecar:$SIDE_PORT studio:$STUDIO_PORT)"

  local api_log="$LOG_DIR/${SLUG}-api-$API_PORT.log"
  local side_log="$LOG_DIR/${SLUG}-sidecar-$SIDE_PORT.log"
  local studio_log="$LOG_DIR/${SLUG}-studio-$STUDIO_PORT.log"

  # launch each detached with nohup; $! is the pid (GNU nohup execs the command, so $! is the
  # real process). NEVER use  $( ... & echo $! )  here: the backgrounded process holds the
  # command-substitution pipe open and the assignment hangs forever.
  cd "$REPO_ROOT/apps/bubblelab-api"
  # OAuth must target THIS stack's own ports (F0.3): NODEX_API_URL sets the
  # redirect_uri Google receives (-> this API port's /oauth/:provider/callback,
  # which must be a registered redirect URI in the Google Cloud OAuth client for
  # the whole PORT_BASE range), and DASHBOARD_URL is where the callback returns
  # the browser (this stack's studio). Without these, a parallel branch's OAuth
  # silently targets the default :3001 / a dead port.
  # FE5: the API always learns its BUILDER_MODE; in managed mode it spawns the
  # sidecar itself (builder-runtime.ts), so it also needs the builder's Claude
  # config envs and the node binary the child should run under.
  DATABASE_URL="$DATABASE_URL" PORT="$API_PORT" NODE_OPTIONS=--dns-result-order=ipv4first \
    BUILDER_AGENT_URL="http://localhost:$SIDE_PORT" \
    BUILDER_MODE="$BUILDER_MODE" \
    BUILDER_CLAUDE_CONFIG_DIR="$BUILDER_CLAUDE_CONFIG_DIR" \
    BUILDER_CLAUDE_CREDENTIALS_SOURCE="$BUILDER_CLAUDE_CREDENTIALS_SOURCE" \
    NODE="$NODE" \
    NODEX_API_URL="http://localhost:$API_PORT" \
    DASHBOARD_URL="http://localhost:$STUDIO_PORT" \
    nohup "$BUN" run src/index.ts >>"$api_log" 2>&1 &
  echo "$! api $API_PORT" >>"$PIDFILE"

  if [[ "$BUILDER_MODE" == "external" ]]; then
    cd "$REPO_ROOT/services/builder-agent"
    GLUU_API_URL="http://localhost:$API_PORT" BUILDER_PORT="$SIDE_PORT" \
      DATABASE_URL="$DATABASE_URL" BUILDER_CLAUDE_CONFIG_DIR="$BUILDER_CLAUDE_CONFIG_DIR" \
      BUILDER_CLAUDE_CREDENTIALS_SOURCE="$BUILDER_CLAUDE_CREDENTIALS_SOURCE" \
      BUILDER_SERVE_MODE=external \
      nohup "$NODE" src/index.ts >>"$side_log" 2>&1 &
    echo "$! sidecar $SIDE_PORT" >>"$PIDFILE"
  else
    echo "BUILDER_MODE=$BUILDER_MODE: sidecar not launched here (API supervises its own child)"
  fi

  local vite_bin="$REPO_ROOT/apps/bubble-studio/node_modules/.bin/vite"
  [[ -x "$vite_bin" ]] || vite_bin="$REPO_ROOT/node_modules/.bin/vite"
  cd "$REPO_ROOT/apps/bubble-studio"
  VITE_API_URL="http://localhost:$API_PORT" VITE_DISABLE_AUTH=true \
    nohup "$vite_bin" --port "$STUDIO_PORT" --strictPort >>"$studio_log" 2>&1 &
  echo "$! studio $STUDIO_PORT" >>"$PIDFILE"
  cd "$REPO_ROOT"

  echo -n "Waiting for services to come up ... "
  local ok=1
  wait_http "http://localhost:$API_PORT/" "200" 90    || { echo "API failed (see $api_log)"; ok=0; }
  # Managed mode: the API's own health implies the child; no sidecar to wait on.
  if [[ "$BUILDER_MODE" == "external" ]]; then
    wait_http "http://localhost:$SIDE_PORT/" "200 404" 60 || { echo "sidecar failed (see $side_log)"; ok=0; }
  fi
  wait_http "http://localhost:$STUDIO_PORT/" "200" 90  || { echo "studio failed (see $studio_log)"; ok=0; }
  [[ "$ok" == 1 ]] && echo "ready."

  echo
  echo "==================================================================="
  echo "  OPEN THIS IN YOUR BROWSER:   http://localhost:$STUDIO_PORT"
  echo "==================================================================="
  echo "  branch:   $BRANCH"
  echo "  API:      http://localhost:$API_PORT      (log: $api_log)"
  echo "  sidecar:  http://localhost:$SIDE_PORT      (log: $side_log)"
  echo "  stop it:  $REPO_ROOT/scripts/dev-stack.sh down"
  [[ "$ok" == 1 ]] || { echo "  NOTE: one or more services did not become healthy; check the logs above."; return 1; }
}

cmd_down() {
  [[ -f "$PIDFILE" ]] || { echo "no stack recorded for branch '$BRANCH'"; return 0; }
  while read -r pid svc port; do
    [[ -n "${pid:-}" ]] || continue
    pkill -P "$pid" 2>/dev/null || true   # children first (kills by parent pid, not -f, so no self-match)
    kill "$pid" 2>/dev/null && echo "stopped $svc (pid $pid, port $port)" || echo "$svc (pid $pid) already gone"
  done <"$PIDFILE"
  rm -f "$PIDFILE"
}

cmd_status() {
  [[ -f "$PIDFILE" ]] || { echo "no stack recorded for branch '$BRANCH'"; return 0; }
  echo "stack for branch '$BRANCH':"
  while read -r pid svc port; do
    if kill -0 "$pid" 2>/dev/null; then echo "  $svc  port $port  pid $pid  RUNNING"; else echo "  $svc  port $port  pid $pid  DEAD"; fi
  done <"$PIDFILE"
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 {up|down|status}"; exit 2 ;;
esac
