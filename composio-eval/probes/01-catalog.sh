#!/usr/bin/env bash
# Read-only: pull the full Composio v3 toolkit catalog into raw/toolkits.json
# Usage: ./01-catalog.sh   (reads COMPOSIO_API_KEY from gluu backend/.env)
set -euo pipefail
# .env line carries a trailing " # comment" and CRLF-free \n; strip both
KEY=$(grep -E '^COMPOSIO_API_KEY=' /mnt/c/Users/brenn/Documents/gluu/backend/.env | sed -E 's/^COMPOSIO_API_KEY=([^ #]+).*/\1/' | tr -d '\r\n')
OUT=$(dirname "$0")/../raw/toolkits.json
CURSOR=""
echo "[" > "$OUT"
FIRST=1
PAGE=0
while :; do
  URL="https://backend.composio.dev/api/v3/toolkits?limit=100"
  [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"
  RESP=$(curl -s -H "x-api-key: $KEY" "$URL")
  ITEMS=$(printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["items"]))')
  COUNT=$(printf '%s' "$ITEMS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
  [ "$COUNT" = "0" ] && break
  printf '%s' "$ITEMS" | python3 -c '
import json,sys
for it in json.load(sys.stdin):
    print(json.dumps(it)+",")
' >> "$OUT"
  PAGE=$((PAGE+1))
  CURSOR=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("next_cursor") or "")')
  [ -z "$CURSOR" ] && break
done
# strip trailing comma, close array
python3 - "$OUT" <<'EOF'
import sys
p=sys.argv[1]
s=open(p).read().rstrip()
if s.endswith(','): s=s[:-1]
open(p,'w').write(s+"\n]\n")
EOF
python3 -c "import json;d=json.load(open('$OUT'));print('toolkits pulled:',len(d))"

