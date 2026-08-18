#!/usr/bin/env python3
"""Coverage probe: BubbleLab's integration surface against Composio's.

Verifies the claim in COMPOSIO-VS-BUBBLELAB-ADVISORY.md section 3.8.

Counting note that matters: most service bubbles are DIRECTORIES (slack/slack.ts,
notion/, hubspot/), not flat files. Listing `service-bubble/*.ts` misses about a
third of them and undercounts the registry. This walks both.

Operations are counted from `operation: z.literal('...')` discriminants, allowing
newlines between the tokens, since several bubbles format them across lines.
"""
import json
import os
import re
import sys
import glob

SERVICE = ('/home/unix/bubblelab-suite/packages/bubble-core/src/bubbles/service-bubble')
RAW = os.path.join(os.path.dirname(__file__), '..', 'raw')
OP = re.compile(r"operation:\s*z\s*\.\s*literal\(\s*['\"]([\w-]+)['\"]", re.S)
SKIP = re.compile(r'\.(test|integration|metadata|auth-methods|utils|flow)\.')

# bubble name -> composio slug where they differ; None means "verified absent"
ALIAS = {
    'google-drive': 'googledrive', 'google-sheets': 'googlesheets',
    'google-calendar': 'googlecalendar', 'eleven-labs': 'elevenlabs',
    'followupboss': 'follow_up_boss', 'bigquery': 'googlebigquery',
    'browserbase': 'browserbase_tool', 'granola': 'granola_mcp',
    'stripe-payments-api': 'stripe', 'snowflake-sql-api': 'snowflake',
    'databricks-sql': 'databricks',
    'redshift-data': None, 's3': None, 'postgresql': None, 'insforge-db': None,
    'agi-inc': None, 'kraken-spot-api': None, 'sendsafely': None, 'slab': None,
    'assembled': None, 'luma': None, 'memberful': None, 'clerk': None, 'sortly': None,
}
# bubbles that are not third-party integrations
INTERNAL = {'hello-world', 'http', 'ai-agent', 'ai-agent-before-action',
            'ai-agent-slack-tools', 'agent-memory', 'capability-pipeline', 'storage'}


def scan_bubbles():
    if not os.path.isdir(SERVICE):
        sys.exit(f"service-bubble dir not found: {SERVICE}")
    names = set()
    for e in os.listdir(SERVICE):
        p = os.path.join(SERVICE, e)
        if os.path.isdir(p):
            names.add(e)
        elif e.endswith('.ts') and not SKIP.search(e):
            names.add(e[:-3])
    out = {}
    for n in sorted(names):
        p = os.path.join(SERVICE, n)
        files = (glob.glob(f'{p}/**/*.ts', recursive=True)
                 if os.path.isdir(p) else [p + '.ts'])
        ops = set()
        for f in files:
            if re.search(r'\.(test|integration)\.', f):
                continue
            ops |= set(OP.findall(open(f, encoding='utf8', errors='ignore').read()))
        out[n] = len(ops)
    return out


def main():
    bubbles = scan_bubbles()
    toolkits = {t['slug']: t for t in json.load(open(os.path.join(RAW, 'toolkits.json')))}
    third_party = {k: v for k, v in bubbles.items() if k not in INTERNAL}

    print(f"service bubbles:            {len(bubbles)}")
    print(f"  third-party integrations: {len(third_party)}")
    print(f"  total operations:         {sum(bubbles.values())}")
    print(f"composio toolkits:          {len(toolkits)}")
    print(f"  catalog-reported tools:   {sum(t['meta']['tools_count'] for t in toolkits.values()):,}")

    hit, miss = [], []
    for b, ops in sorted(third_party.items(), key=lambda x: -x[1]):
        slug = ALIAS.get(b, b)
        if slug and slug in toolkits:
            hit.append((b, ops, slug, toolkits[slug]['meta']['tools_count']))
        else:
            miss.append(b)
    print(f"\noverlap: {len(hit)} present, {len(miss)} absent")
    print(f"\n{'bubble':22}{'ops':>6}{'composio':>10}  ratio")
    for b, ops, slug, ct in hit:
        print(f"  {b:20}{ops:>6}{ct:>10}  {ct / ops:.0f}x" if ops
              else f"  {b:20}{ops:>6}{ct:>10}  n/a")
    print(f"\nabsent from Composio: {miss}")


if __name__ == '__main__':
    main()

