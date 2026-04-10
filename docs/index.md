# Docs Index

Start here before scanning `_reference/opencode` or re-reading the full bridge codebase.

## Recommended reading order

1. [`docs/feishu-bridge-state-analysis.md`](./feishu-bridge-state-analysis.md) — master diagnosis of the stuck question/permission flow, ranked weaknesses, and fix vs refactor recommendations.
2. [`docs/feishu-bridge-git-hotspots.md`](./feishu-bridge-git-hotspots.md) — git churn baseline showing which bridge modules are unstable and why they matter.
3. [`docs/opencode-session-state-reference.md`](./opencode-session-state-reference.md) — OpenCode runtime state machine, including why sessions remain `busy` during human-in-the-loop waits.
4. [`docs/opencode-web-client-interaction.md`](./opencode-web-client-interaction.md) — how the browser app hydrates pending state, subscribes to events, and clears UI after follow-up server events.
5. [`docs/opencode-server-api-reference.md`](./opencode-server-api-reference.md) — server API contracts for sessions, events, questions, and permissions.
6. [`docs/opencode-session-state.md`](./opencode-session-state.md) — pre-existing bridge-focused implementation notes for current local state ownership.

## By topic

### Bridge diagnosis

- [`docs/feishu-bridge-state-analysis.md`](./feishu-bridge-state-analysis.md)
- [`docs/feishu-bridge-git-hotspots.md`](./feishu-bridge-git-hotspots.md)
- [`docs/opencode-session-state.md`](./opencode-session-state.md)

### OpenCode reference model

- [`docs/opencode-session-state-reference.md`](./opencode-session-state-reference.md)
- [`docs/opencode-web-client-interaction.md`](./opencode-web-client-interaction.md)
- [`docs/opencode-server-api-reference.md`](./opencode-server-api-reference.md)

## When to scan `_reference/opencode`

Use the cloned reference repository only when the docs above are missing coverage, appear stale, or need line-level verification against upstream code.
