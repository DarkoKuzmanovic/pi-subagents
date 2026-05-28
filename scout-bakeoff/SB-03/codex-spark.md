# Test Infrastructure Handoff (SB-03)

## 1) Answer first
Use `node --test`-based scripts from `package.json`, not jest/mocha/vitest. For most unit work, run:
- `npm run test:unit` (single-file: `npm run test:unit -- test/unit/<name>.test.ts`)
For integration work use `npm run test:integration`.

Both flows rely on `test/support/register-loader.mjs` so imports with `.js` in source/tests are resolved to `.ts` during execution.

For a new unit test, mirror existing unit style:
- `import { describe, it, ... } from "node:test";`
- `import assert from "node:assert/strict";` (or `* as assert` where existing test does)
- import module under test from `../../src/...` with `.ts` or `.js` extension (loader supports both).

Do not introduce child-process/pi CLI mocking in unit tests; use `createMockPi` etc only in `test/integration/*`.

## 2) Evidence
- `package.json:40-45` defines runner scripts:
  - `test:unit`: `node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts`
  - `test:integration`: `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts`
  - `npm test` aliases `test:unit`.
- `AGENTS.md:75-103` states Node built-in runner only; unit/integration distinction, loader usage, and required test command detail.
- `AGENTS.md:114-119` enforces ESM/import conventions (`"type": "module"`, `.js` import extensions preferred).
- `test/support/register-loader.mjs:1-15` comment + registration clarifies purpose and required flags.
- `test/support/ts-loader.mjs:9-13` and `:111-123` show `.js`→`.ts` resolve shim and peer dependency shims.
- `test/support/helpers.ts:12-27, 55-86` exposes `makeAgent`, `makeAgentConfigs`, `createTempDir`, `removeTempDir`, etc.
- `test/support/mock-pi.ts:18-27, 62-76` defines `createMockPi` and CLI queue interception (integration-only mock child process).
- `test/unit/stdio-parser.test.ts:1-4, 5-12` and `test/unit/ts-loader.test.ts:1-7` show canonical unit import/assert/style and `.js` source import case.
- `test/integration/single-execution.test.ts:12-29, 116-123, 149-163` shows integration setup (`createMockPi`, `mockPi.install/uninstall`) and `tryImport`-style availability handling.
- `skills/test-writer/SKILL.md:20-27` explicitly says for this codebase: discover runner from package scripts and use exact loader/flags.

## 3) Flow or map
- Start from `package.json` scripts → pick unit vs integration command.
- If unit test: inspect nearest unit test for target module (same folder naming pattern) for `describe/it` structure.
- Create `<module>.test.ts` in `test/unit/` with Node test imports.
- Import shared helpers from `test/support/helpers.ts` only when helper semantics match need.
- For integration: create in `test/integration/`, use `createMockPi`/`createTempDir` and clean-up in hooks.
- Run scoped command first, then full suite gate.

Suggested command ladder:
1) `npm run test:unit -- test/unit/<new-test>.test.ts`
2) `npm run test:unit`
3) `npm run test:integration`
4) `npm run typecheck`

## 4) Risks / unknowns
- No explicit repository-wide “file-specific test command” example in `package.json`; extra args support is inferred from npm/nodetest behavior and external plan docs.
- Some unit tests import `.js`-suffixed source paths (`test/unit/stdio-parser.test.ts:3`, `output-buffer.test.ts`, etc.) while others use `.ts`; both depend on `register-loader`.
- Integration suites can be skipped when peer packages/modules are unavailable (`*_test.ts` using `tryImport`/`available` flags).
- `fix-review-blockers.md`/README indicate historical baseline noise in test runs; watch for pre-existing failures unrelated to your change.

## 5) Worker handoff
Open first: `package.json` (scripts + test flags), then `AGENTS.md` (testing policy), then `test/support/register-loader.mjs`, then nearest existing unit test for target area.
Then:
- keep runner exact to this repo’s scripts,
- keep import/assert style
- keep mock strategy aligned to unit vs integration split.
