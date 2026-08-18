#!/usr/bin/env python3
"""Read-only analysis of the pulled Composio catalog + per-toolkit tool schemas.

Reproduces every number quoted in COMPOSIO-VS-BUBBLELAB-ADVISORY.md.
Run 01-catalog.sh first, then 03-tools.sh, then this.
"""
import collections
import json
import os

RAW = os.path.join(os.path.dirname(__file__), '..', 'raw')


def load(name):
    with open(os.path.join(RAW, name)) as fh:
        return json.load(fh)


def catalog_shape(toolkits):
    print(f"toolkits: {len(toolkits)}")
    schemes = collections.Counter()
    for t in toolkits:
        for s in t.get('auth_schemes') or []:
            schemes[s] += 1
    print("auth_schemes:", dict(schemes.most_common()))

    oauthish = {'OAUTH2', 'OAUTH1', 'DCR_OAUTH', 'S2S_OAUTH2'}
    oauth = [t for t in toolkits if set(t.get('auth_schemes') or []) & oauthish]
    managed = [t for t in oauth if t.get('composio_managed_auth_schemes')]
    unmanaged = [t for t in oauth if not t.get('composio_managed_auth_schemes')]
    fallback = [t for t in unmanaged
                if set(t.get('auth_schemes') or []) & {'API_KEY', 'BEARER_TOKEN', 'BASIC'}]
    print(f"oauth-family toolkits: {len(oauth)} | managed: {len(managed)} | "
          f"self-registered: {len(unmanaged)} | of those with key fallback: {len(fallback)} | "
          f"oauth-only dead end: {len(unmanaged) - len(fallback)}")

    print(f"summed meta.tools_count: {sum(t['meta'].get('tools_count', 0) for t in toolkits)}")
    print(f"summed triggers: {sum(t['meta'].get('triggers_count', 0) for t in toolkits)}")

    buckets = collections.Counter(t['meta']['updated_at'][:7]
                                  for t in toolkits if t['meta'].get('updated_at'))
    print("updated_at by month:", dict(sorted(buckets.items())))


def count_divergence(toolkits, slugs):
    """The same toolkit reports three different tool counts."""
    by = {t['slug']: t for t in toolkits}
    print(f"\n{'toolkit':16} {'catalog':>8} {'base':>6} {'latest':>7}  latest_version")
    for s in slugs:
        base = load(f'tools-{s}.json')['total_items']
        latest = load(f'tools-{s}-latest.json')['total_items']
        print(f"{s:16} {by[s]['meta']['tools_count']:8} {base:6} {latest:7}  "
              f"{by[s]['meta'].get('version')}")


def schema_quality(slugs):
    """Are published output schemas complete enough to generate types from?"""
    print(f"\n{'toolkit(latest)':22} {'tools':>6} {'typed':>6} {'median bytes':>13} {'total bytes':>12}")
    for s in slugs:
        items = load(f'tools-{s}-latest.json')['items']
        typed = sum(1 for t in items
                    if '$ref' in (t['output_parameters'].get('properties') or {}).get('data', {})
                    or ((t['output_parameters'].get('properties') or {})
                        .get('data', {}).get('properties')))
        sizes = sorted(len(json.dumps(t['input_parameters'])) +
                       len(json.dumps(t['output_parameters'])) for t in items)
        print(f"{s:22} {len(items):6} {typed:6} {sizes[len(sizes) // 2]:13} {sum(sizes):12}")


def notion_freshness():
    """Notion moved to the data-source model on 2025-09-03. Which version tracks it?"""
    for label, fname in [('base', 'tools-notion.json'), ('latest', 'tools-notion-latest.json')]:
        blob = json.dumps(load(fname)['items'])
        print(f"notion {label:6}: 'data_source' mentions={blob.count('data_source'):4} "
              f"'database_id' mentions={blob.count('database_id'):4}")


if __name__ == '__main__':
    toolkits = load('toolkits.json')
    sample = ['notion', 'slack', 'googlesheets']
    catalog_shape(toolkits)
    count_divergence(toolkits, sample)
    schema_quality(sample)
    print()
    notion_freshness()

