# Native SDK baseline for integration hedging

This branch records the BubbleLab structure immediately after the SDK and repository map were
documented and before the later integration refactors.

- Baseline parent: `b110d4d` (`docs(plan): add REPO-MAP — file-level patch plan for improvement graft`)
- Baseline date: 2026-07-14
- Branch: `hedge/native-sdk-baseline`

Use this branch as the native-integration fallback while Composio-backed integrations are tested.
New tool generation must preserve the contracts documented in `docs/plan/REPO-MAP.md`, including
the BubbleFactory registry, ServiceBubble shape, credential injection path, parser recognition
rules, metadata catalogue, and build order.
