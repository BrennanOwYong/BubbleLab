# Composio evaluation research manifest

This directory is the source pack for the Composio integration decision and for a future
documentation-digestion pipeline.

## Read first

1. `../docs/plan/REPO-MAP.md` — BubbleLab file-level architecture and patch map.
2. `../docs/reference/BUBBLELAB_SDK_DISTILLED.md` — distilled SDK contracts and flow rules.
3. `COMPOSIO-VS-BUBBLELAB-ADVISORY.md` — measured trade-offs, coverage, and fidelity findings.
4. `IMPLEMENTATION-GUIDE.md` — implementation phases and verification gates.
5. `AUTH-AND-TRIGGER-ARCHITECTURE-NOTES.md` — authentication and trigger design constraints.

## Research inputs

- `raw/toolkits.json` contains the captured toolkit catalogue.
- `raw/tools-*.json` contains pinned tool metadata for the evaluated toolkits.
- `probes/` contains repeatable catalogue, fidelity, and coverage probes.
- `ast-detector/` contains the static tool-call detection prototype.
- `asks-matrix.json` and `c0-result.json` contain the evaluation cases and pilot result.

## Pipeline rule

The future add-a-tool pipeline must digest current vendor or Composio documentation into
BubbleLab's existing contracts. It must not replace the contracts with a new per-tool runtime
shape. The generated result must remain a registered named bubble with compatible schemas,
credentials, parser visibility, metadata, and tests.
