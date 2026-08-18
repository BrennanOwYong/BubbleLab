#!/usr/bin/env bash
# Read-only: pull per-toolkit tool schemas at BOTH the default (base) version and `latest`.
# The two differ. That difference is the point of the probe.
set -euo pipefail
KEY=$(grep -E '^COMPOSIO_API_KEY=' /mnt/c/Users/brenn/Documents/gluu/backend/.env \
  | sed -E 's/^COMPOSIO_API_KEY=([^ #]+).*/\1/' | tr -d '\r\n')
RAW="$(dirname "$0")/../raw"
for tk in "${@:-notion slack googlesheets}"; do
  curl -s -H "x-api-key: $KEY" \
    "https://backend.composio.dev/api/v3/tools?toolkit_slug=$tk&limit=100" \
    > "$RAW/tools-$tk.json"
  curl -s -H "x-api-key: $KEY" \
    "https://backend.composio.dev/api/v3/tools?toolkit_slug=$tk&limit=100&toolkit_versions=latest" \
    > "$RAW/tools-$tk-latest.json"
  python3 -c "
import json
b=json.load(open('$RAW/tools-$tk.json')); l=json.load(open('$RAW/tools-$tk-latest.json'))
print('$tk: base=%s latest=%s' % (b.get('total_items'), l.get('total_items')))
"
done

