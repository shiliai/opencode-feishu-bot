# Contributing to OpenCode Feishu Bridge

Thanks for your interest in contributing! This guide covers the basics.

## Development Setup

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run in dev mode (build + start)
npm run dev
```

## Making Changes

### Code Style

- TypeScript strict mode (`strict: true`).
- 2-space indentation, semicolons, double quotes (enforced by Prettier).
- No `any` — prefer `unknown` with type guards.
- No `console.*` in `src/**` (except `src/index.ts`).
- Use `node:` built-in specifiers and `.js` suffix on relative ESM imports.

### Pre-commit Checks

Run these before pushing:

```bash
npm run lint
npm run test
npm run build
```

All three must pass with zero errors.

### Testing

- Unit tests live in `tests/unit/`.
- Integration tests in `tests/integration/`.
- Contract tests in `tests/contracts/`.
- Smoke tests in `tests/smoke/`.
- Use [Vitest](https://vitest.dev/) (`describe`, `it`, `expect`, `vi`).
- Prefer deterministic mocks. Avoid testing implementation details.

```bash
# All tests
npm run test

# Single test file
npm test -- tests/unit/config.test.ts

# By test name pattern
npm test -- -t "strips mention placeholders"
```

## Pull Requests

1. Fork the repository and create a feature branch from `main`.
2. Make focused, well-described commits.
3. Ensure lint, tests, and build all pass.
4. Open a pull request against `main` with a clear description of the change and motivation.

## Reporting Issues

- Use [GitHub Issues](https://github.com/shiliai/opencode-feishu-bot/issues).
- Include steps to reproduce, expected behavior, and actual behavior.
