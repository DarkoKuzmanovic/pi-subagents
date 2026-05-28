# SB-03: Test Infrastructure Handoff

## 1. Answer First

Add a unit test by:
1. Placing the file at `test/unit/<ModuleName>.test.ts`
2. Using `import { test, describe } from "node:test"` and `import assert from "node:assert/strict"`
3. Importing source with `.js` extension (the loader rewrites to `.ts`)
4. Running with: `node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/<ModuleName>.test.ts`
5. Or globally: `npm run test:unit` (runs all `test/unit/*.test.ts`)

**Do not** use `--experimental-transform-types` for unit tests. Do not use parameter properties (`constructor(private x: T)`) in source files that unit tests import.

---

## 2. Evidence

### Runner commands (package.json:41-44)
```json
"test:unit": "node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts",
"test:integration": "node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts"
```
Unit uses `--experimental-strip-types`. Integration uses `--experimental-transform-types`.

### Loader rewrites .js → .ts (test/support/ts-loader.mjs:119-122)
```js
const tsPath = jsPath.replace(/\.js$/, ".ts");
if (!fs.existsSync(jsPath) && fs.existsSync(tsPath)) {
  return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
}
```
Source files import with `.js` extensions; loader redirects to `.ts` on disk.

### Shimmed peer deps (test/support/ts-loader.mjs:104-108)
Both `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are stubbed inline in the loader as `data:text/javascript,` modules. No real Pi packages needed at test time.

### Unit test pattern (test/unit/completion-guard.test.ts, test/unit/agent-selection.test.ts)
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
// .js extension imports work
import { evaluateCompletionMutationGuard } from "../../src/runs/shared/completion-guard.ts";
```
No Pi runtime, no child processes, no `createMockPi` — unit tests import source directly and assert pure functions.

### Integration helpers NOT used in unit tests
`createMockPi()`, `createEventBus()`, `makeMinimalCtx()` live in `test/support/helpers.ts` but are **zero references in test/unit/** — only used in `test/integration/`. These require the `--experimental-transform-types` runner and full mocked Pi runtime.

### AGENTS.md rule on parameter properties
> "No parameter properties in unit-testable code. `constructor(private readonly x: T)` requires `--experimental-transform-types`; avoid in code imported by unit tests."

### Shims for type declarations (test/support/shims/)
Four `.d.ts` files stub the Pi package surface: `pi-agent-core.d.ts`, `pi-ai.d.ts`, `pi-coding-agent.d.ts`, `pi-tui.d.ts`. Allow `tsc --noEmit` to pass without real packages installed.

---

## 3. Flow

```
test/unit/<Name>.test.ts
  → imports source via .js extension
  → register-loader.mjs → ts-loader.mjs rewrites .js → .ts
  → shims @earendil-works/pi-tui and @earendil-works/pi-coding-agent inline
  → runs under node --test with --experimental-strip-types
  → no Pi runtime, no child process
```

---

## 4. Risks / Unknowns

- **Wrong runner for new tests**: If the new test lives in `test/unit/` but accidentally uses `createMockPi` or `MockPi`, it will silently work under `npm run test:unit` only if no mock-pi calls are made at runtime — but the runner will still pass. Use the right helpers for the right test dir.
- **Parameter property trap**: Source files with parameter properties (e.g., `constructor(private x: T)`) compile under `--experimental-strip-types` but the values are `undefined` at runtime. This is a silent correctness bug. The integration runner (`--experimental-transform-types`) handles it correctly.
- **ts-loader.mjs is loaded for both runners**: Both unit and integration test commands use `--import ./test/support/register-loader.mjs`. The loader applies to both, so unit test files can also import integration-only helpers — but those helpers may fail in the unit runner context.

---

## 5. Worker Handoff

**First file to open**: `test/unit/completion-guard.test.ts` — cleanest, self-contained unit test using only `node:test` + `assert/strict`.

**Closest reference for a new test**: `test/unit/agent-selection.test.ts` — shows minimal structure (imports, factory helper, `describe`/`it` blocks).

**To add a new unit test**:
- File: `test/unit/<SourceModuleName>.test.ts`
- Imports: `node:test` (`test`, `describe`, `it`) + `node:assert/strict` + source via `.js` extension
- Run locally: `node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/<file>.test.ts`
- Run with suite: `npm run test:unit`
- Verify: `npm run typecheck`

**Do not** use `--experimental-transform-types`, `createMockPi`, `createEventBus`, or `makeMinimalCtx` in unit tests — those belong in `test/integration/`.
