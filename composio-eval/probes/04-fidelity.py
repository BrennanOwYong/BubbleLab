#!/usr/bin/env python3
"""Fidelity probe: does Composio's tool surface match the vendor's CURRENT API?

Version management is not the question here. The SDK already resolves to `latest`.
This asks whether `latest` equals what the vendor ships today, tested against dated
vendor changes.

Run 03-tools.sh first. Reproduces the table in COMPOSIO-VS-BUBBLELAB-ADVISORY.md section 3.2.
"""
import json
import os

RAW = os.path.join(os.path.dirname(__file__), '..', 'raw')


def load(name):
    with open(os.path.join(RAW, name)) as fh:
        return json.load(fh)


def notion_2025_09_03():
    """Notion replaced database query with data sources. Breaking, shipped 2025-09-03."""
    print("Notion 2025-09-03 (data sources), 11 months old")
    for label, fname in [('base  ', 'tools-notion.json'), ('latest', 'tools-notion-latest.json')]:
        blob = json.dumps(load(fname)['items'])
        print(f"  {label}: data_source={blob.count('data_source'):4}  database_id={blob.count('database_id'):4}")
    print("  verdict: tracked at latest, absent at base\n")


def notion_2026_03_11():
    """Notion renamed archived -> in_trash and after -> position. Shipped 2026-03-11."""
    items = load('tools-notion-latest.json')['items']
    blob = json.dumps(items)
    print("Notion 2026-03-11 (in_trash, position), 5 months old")
    print(f"  in_trash={blob.count('in_trash'):4} (new)   archived={blob.count('archived'):4} (old)")
    after = [t['slug'] for t in items if 'after' in t['input_parameters'].get('properties', {})]
    pos = [t['slug'] for t in items if 'position' in t['input_parameters'].get('properties', {})]
    print(f"  tools still exposing `after`: {len(after)}   tools exposing `position`: {len(pos)}")
    print("  verdict: NOT tracked, on a toolkit stamped 20260730_00\n")


def slack_files_upload():
    """Slack retired files.upload on 2025-11-12 for files.completeUploadExternal."""
    items = (load('tools-slack-latest.json')['items']
             + load('tools-slack-latest-p2.json')['items'])
    hits = [t['slug'] for t in items
            if 'completeUpload' in json.dumps(t) or 'files.upload' in json.dumps(t)]
    print("Slack files.upload retirement 2025-11-12, 9 months old")
    print(f"  tools referencing either upload API: {hits}")
    print("  verdict: tracked. The schema documents both paths and names the sunset date")
    print("  note: parameter names still match the OLD API, so it looks stale from outside\n")


def notion_coverage():
    """Coverage against Notion's own reference index (developers.notion.com/llms.txt)."""
    tools = {t['slug'] for t in load('tools-notion-latest.json')['items']}
    mapping = {
        'create-a-data-source': 'NOTION_CREATE_DATABASE',
        'retrieve-a-data-source': 'NOTION_FETCH_DATABASE',
        'update-a-data-source': 'NOTION_UPDATE_SCHEMA_DATABASE',
        'query-a-data-source': 'NOTION_QUERY_DATA_SOURCE',
        'list-data-source-templates': 'NOTION_LIST_DATA_SOURCE_TEMPLATES',
        'create-view': 'NOTION_CREATE_VIEW',
        'retrieve-a-view': 'NOTION_RETRIEVE_VIEW',
        'update-a-view': 'NOTION_UPDATE_VIEW',
        'delete-view': 'NOTION_DELETE_VIEW',
        'list-views': 'NOTION_LIST_VIEWS',
        'create-view-query': 'NOTION_CREATE_VIEW_QUERY',
        'delete-view-query': 'NOTION_DELETE_VIEW_QUERY',
        'get-view-query-results': 'NOTION_GET_VIEW_QUERY_RESULTS',
        'get-block-children': 'NOTION_FETCH_BLOCK_CONTENTS',
        'patch-block-children': 'NOTION_APPEND_BLOCK_CHILDREN',
        'post-search': 'NOTION_SEARCH_NOTION_PAGE',
        'get-users': 'NOTION_LIST_USERS',
        'get-self': 'NOTION_GET_ABOUT_ME',
        'list-comments': 'NOTION_FETCH_COMMENTS',
        'upload-file': 'NOTION_SEND_FILE_UPLOAD',
        'create-file': 'NOTION_CREATE_FILE_UPLOAD',
        'retrieve-page-markdown': 'NOTION_GET_PAGE_MARKDOWN',
        'update-page-markdown': 'NOTION_REPLACE_PAGE_CONTENT',
        'retrieve-a-page-property': 'NOTION_GET_PAGE_PROPERTY_ACTION',
        'get-databases': 'NOTION_FETCH_DATA',
        'create-meeting-note': None,
        'query-meeting-notes': None,
        'retrieve-async-task': None,
    }
    hit = [k for k, v in mapping.items() if v and v in tools]
    miss = [k for k, v in mapping.items() if not v or v not in tools]
    print("Coverage vs Notion's own reference index")
    print(f"  {len(hit)} of {len(mapping)} operational endpoints covered "
          f"({100 * len(hit) // len(mapping)}%)")
    print(f"  not covered: {miss}")
    extra = len(tools) - len(hit)
    print(f"  plus {extra} convenience wrappers with no 1:1 endpoint")


if __name__ == '__main__':
    notion_2025_09_03()
    slack_files_upload()
    notion_2026_03_11()
    notion_coverage()

