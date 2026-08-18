# composio-eval

Read-only research spike. Nothing in BubbleLab or Gluu was modified.

- `COMPOSIO-VS-BUBBLELAB-ADVISORY.md` — the findings and the advisory (whether to do it). Section 2
  scores each of your eleven asks and compares how Composio and BubbleLab answer it.
- `IMPLEMENTATION-GUIDE.md` — how to do it. Architecture, four phases, per-toolkit adoption gate,
  open decisions, verification split between builder and human.
- `asks-matrix.json` — machine-readable copy of advisory section 2, for rendering the comparison.
- `ast-detector/` — working prototype answering "can a parser tell which Composio tools a script
  uses". 22 scored cases. See advisory §5.4.
- `probes/` — the scripts that produced every number in both documents.
- `raw/` — raw Composio v3 API responses captured 2026-08-01.

## AST detection prototype

```bash
cd ast-detector
node run.mjs              # 14 realistic usage patterns, 11 of them call sites the injector refuses
node run-adversarial.mjs  # 5 cases written to break it
node run-precision.mjs    # 3 negative controls + strict-vs-relaxed comparison

cd bubble
node run.mjs              # BubbleLab side: imports vs today's string-eval vs AST walk
```

`bubble/run.mjs` answers "can imports alone tell you which bubbles a flow uses". They cannot:
0/12 exact, 95 false positives, and a nested agent tool has no import at all. An AST walk of the
tools array scores 12/12. See advisory §5.6.

Uses the TypeScript compiler's parser from the bubblelab-suite tree. Reads nothing else.

## Reproduce

```bash
cd probes
./01-catalog.sh                       # full toolkit catalog -> raw/toolkits.json
./03-tools.sh notion slack googlesheets   # per-toolkit tools at base AND latest
python3 02-analyze.py                 # catalog shape, counts, schema quality
python3 04-fidelity.py                # does `latest` match the vendor's current API?
python3 05-coverage.py                # BubbleLab's surface vs Composio's, from the registry
```

`04-fidelity.py` answers "does Composio work as advertised". It tests Composio's surface against
three dated vendor changes and reports the trail.

`05-coverage.py` answers "how much bigger is Composio really". It reads
`/home/unix/bubblelab-suite` directly. Counting note: most service bubbles are directories
(`slack/slack.ts`, `notion/`), so listing `service-bubble/*.ts` undercounts by about a third. The
script walks both.

Scripts read `COMPOSIO_API_KEY` from `/mnt/c/Users/brenn/Documents/gluu/backend/.env`.
That line carries a trailing ` # comment`, so the extraction strips it.

## External state

One `POST /auth_configs` created `ac_4X6KwN_SUuL7` (github, BEARER_TOKEN) to settle whether
Composio's advertised auth schemes match what it accepts. Deleted in the following call, 404
confirmed on re-fetch. No other write was made.

