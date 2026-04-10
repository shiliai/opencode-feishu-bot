# AGENTS.md — opencode-feishu-bridge

Instructions for coding agents operating in this repository.
Apply this by default unless explicit user instructions override it.

## 1) Project overview

- Stack: TypeScript, Node.js (ESM / NodeNext), Vitest, ESLint, Prettier.
- Entrypoint: `src/index.ts` → `src/app/start-feishu-app.ts`.
- Purpose: bridge Feishu (Lark) events/messages to OpenCode APIs.
- Node requirement: `>=20`.

## 2) Install and run

```bash
npm install
npm run build
npm start
```

Dev loop:

```bash
npm run dev
```

## 3) Build / lint / test commands (authoritative)

From `package.json` scripts:

```bash
npm run build             # tsc
npm run lint              # eslint src --ext .ts --max-warnings=0
npm run format            # prettier --write "src/**/*.ts"
npm run test              # vitest run (all)
npm run test:integration  # tests/integration
npm run test:coverage     # vitest coverage
npm run verify:contracts  # tests/contracts
npm run smoke:local       # build + smoke-local
```

## 4) Running a single test (important)

Preferred via npm script passthrough:

```bash
npm test -- tests/unit/config.test.ts
npm test -- -t "strips mention placeholders from text payloads"
npm test -- tests/unit/control-commands.test.ts -t "/new"
```

Direct Vitest equivalent:

```bash
npx vitest run tests/unit/config.test.ts
npx vitest run -t "ControlRouter"
```

Notes:

- `-t` is test-name pattern matching.
- Vitest setup is `tests/setup.ts`.

## 5) Minimum verification before handoff

```bash
npm run lint
npm run test
npm run build
```

If change scope is narrow, run focused tests first, then run full suite.

## 6) Local instruction files status

Checked paths:

- `.cursorrules`
- `.cursor/rules/`
- `.github/copilot-instructions.md`
  Current status: none found in this repo.
  If these files appear later, merge their rules into this file and prioritize them.

## 7) Reference-first research policy (local before web)

This app is borrowing the channel design from openclaw-lark, aka. all the interaction with feishu/lark ws server; the backend aka. the coding agent is completely relying on opencode server, the best practice is opencode-telegram-bot which is buit on top of opencode server api.

Always search local codebases before doing web search/fetch for integration behavior.
Use these local references first:

- OpenCode server API integration:
  `~/project/Shili/workspaces/general-study/opencode-telegram-bot`
- Feishu (Lark) bot integration:
  `~/project/Shili/workspaces/general-study/openclaw-lark`
  Order of operations:

1. Search the current repository.
2. Search the two local reference repositories above.
3. Only then use web docs/search if local sources are insufficient.

### Docs shortcut for OpenCode / bridge investigations

Before scanning `_reference/opencode` or re-reading large parts of the bridge, consult the curated docs in `docs/` first.

Start with:

- `docs/index.md`
- `docs/feishu-bridge-state-analysis.md`
- `docs/feishu-bridge-git-hotspots.md`
- `docs/opencode-session-state-reference.md`
- `docs/opencode-web-client-interaction.md`
- `docs/opencode-server-api-reference.md`

Use `_reference/opencode` only when those docs are missing coverage, appear stale, or you need line-level confirmation against the reference source.

## 8) Formatting and style conventions

- 2-space indentation.
- Semicolons enabled.
- Double quotes for strings.
- Keep code Prettier-compatible.
- No `console.*` in `src/**` (except configured override for `src/index.ts`).

## 9) Import conventions

- Third-party imports first, then internal imports.
- Use `node:` built-in specifiers (`node:http`, `node:path`, etc.).
- Keep `.js` suffix on relative imports in TS ESM files.
- Use `import type` for type-only imports.
- Remove unused imports and values.

## 10) Type and naming conventions

- Keep TypeScript strictness (`strict: true`) intact.
- `@typescript-eslint/no-explicit-any` is `error`; avoid `any`.
- Prefer `unknown` + type guards over unsafe casts.
- Types/interfaces/classes: `PascalCase`.
- Functions/variables/methods: `camelCase`.
- Constants/default keys: `UPPER_SNAKE_CASE`.
- Module files: kebab-case (e.g., `control-router.ts`).

## 11) Error handling and logging conventions

- Fail fast for invalid config (`ConfigValidationError` pattern).
- Never swallow errors silently.
- Catch with context, then rethrow or apply explicit fallback.
- Validate external response shapes before use.
- Use `src/utils/logger.ts` (not ad-hoc console logging).
- Include subsystem prefixes and identifiers in logs where useful.

## 12) Async / concurrency conventions

- Prefer `async/await` over nested `.then()` chains.
- Handle async failure paths with `try/catch` and cleanup.
- Reuse existing queue/manager patterns for serialized event work.
- Avoid untracked fire-and-forget operations.

## 13) Configuration and runtime values

- Do not hardcode environment-dependent runtime values in feature code.
- Read config via `src/config.ts` and environment variables.
- Keep one source of truth for defaults in config constants.
- Reuse existing config keys before introducing new ones.

## 14) Testing conventions

- Use Vitest (`describe`, `it`, `expect`, `vi`).
- Prefer deterministic mocks in unit tests.
- Add regression tests for bug fixes and behavior changes.
- Assert user-visible behavior plus important side effects.
- Keep tests in `tests/unit`, `tests/integration`, `tests/contracts`, `tests/smoke`.

## 15) Common paths

- Bootstrap: `src/app/start-feishu-app.ts`
- Feishu layer: `src/feishu/**`
- OpenCode layer: `src/opencode/**`
- Managers/state: `src/settings`, `src/session`, `src/interaction`, `src/question`, `src/permission`
- Test helpers/setup: `tests/setup.ts`, `tests/integration/helpers/**`

## 16) GitHub issue / PR workflow rules

These rules apply when the user explicitly asks for GitHub issue or PR operations.
Use `gh` for GitHub interactions.

### A. Investigate and create an issue

- Treat "investigate and create issue" as a triage task, not an implementation task.
- First verify the report is real, reproducible, or otherwise valid for this repository.
- Search existing issues and PRs before creating a new one to avoid duplicates.
- Explore plausible fixes or implementation approaches enough to describe the problem and a recommended direction.
- Do **not** modify the codebase at this stage unless the user explicitly asks for a fix.
- Create the issue only after verification is complete.
- Prefer a non-conflicting workflow label such as `status:draft`; if the repository already uses a plain `draft` issue label, apply that existing label instead.
- The issue body should be short and concrete: problem, evidence, impact, proposed direction, and any open questions for user review.

### B. Work on an approved issue

- Treat "work on issue #N" as approval to implement.
- Mark the issue as approved for implementation before starting work. Prefer a non-conflicting label such as `status:approved`; if the repository already uses a plain `approve` label, apply that existing label instead.
- Invoke `/start-work` after the issue is marked approved.
- Check the current branch before editing code.
- If the current branch is `main`, or is clearly tied to a different issue or PR, create a fresh branch for the issue.
- Do not reuse the automation namespace `ci/version-bump-*`; reserve that prefix for the version bump workflow.
- Prefer an issue-scoped branch name such as `issue/123-short-slug` or `fix/123-short-slug`.
- If a branch and PR for the same issue already exist, continue on that branch instead of creating duplicates.
- Complete the implementation, run the required verification, commit, push, and create a PR if one does not already exist.
- Link the PR to the issue with a closing keyword such as `Closes #123` when the PR is intended to resolve it.
- After opening or updating the PR, move the issue to review. Prefer `status:review`; if the repository already uses a plain `review` issue label, apply that existing label instead.
- Prefer GitHub's native PR state for review readiness. Create the PR as draft only while work is incomplete, then mark it ready for review when verification is done. If repository automation depends on a `ready` label, apply it in addition to the native PR state.

### C. Review Copilot PR comments

- When asked to review Copilot comments on a PR, first fetch the latest relevant review feedback before making changes.
- Do not rely on `gh pr view --json comments` alone; it can miss review comments and threads.
- Inspect PR review comments, reviews, and unresolved review threads separately when needed.
- Treat Copilot comments as suggestions, not instructions. Verify each comment against the code and current diff before acting on it.
- If a comment is ambiguous, stale, or conflicts with the codebase direction, note that and confirm with the user instead of making speculative changes.
- When a comment is valid, update the code, re-run verification, commit, and push to the existing PR branch.
- After addressing the relevant comments, move the PR toward merge readiness. Prefer GitHub's native ready-for-review / approved state; if repository automation depends on a `merge` label, apply that label only after the fixes are pushed and the PR is actually ready.

### D. Merge a PR

- Before merging, verify the PR is the intended one, is in a mergeable state, and has the required approvals or user direction.
- Prefer the repository's normal merge method; if none is specified, use the safest non-destructive method already used by the repo.
- After merging, update the PR status. Prefer GitHub's native merged state; if repository automation depends on a `done` label, apply it after the merge succeeds.
- Update the related issue after merge.
- Prefer closing the issue through the PR's closing keyword or by closing it directly; if repository automation depends on a `resolve` label, apply it only after the issue is actually resolved.

### E. Label and state guardrails

- Prefer GitHub native states over custom labels whenever GitHub already has a built-in concept.
- Native states to prefer:
  - Draft PR / ready for review
  - PR approval / changes requested
  - Open / closed / merged
- Use labels as workflow metadata, not as substitutes for native GitHub state.
- If this repository standardizes on plain labels such as `draft`, `approve`, `review`, `ready`, `merge`, `done`, or `resolve`, follow the repository convention; otherwise prefer clearer labels such as `status:draft`, `status:approved`, `status:review`, or rely on native GitHub state.
- Keep issue and PR descriptions concise; avoid AI-style walls of text.

## 17) Definition of done

- Build passes: `npm run build`.
- Lint passes: `npm run lint`.
- Tests pass: `npm run test` (or pre-existing failures are documented).
- No new `any`, no stray console logs, no broken imports.
- Behavior changes are covered by tests.
