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

## 16) Definition of done

- Build passes: `npm run build`.
- Lint passes: `npm run lint`.
- Tests pass: `npm run test` (or pre-existing failures are documented).
- No new `any`, no stray console logs, no broken imports.
- Behavior changes are covered by tests.
