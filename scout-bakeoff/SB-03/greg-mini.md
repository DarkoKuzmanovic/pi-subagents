# Code Context

## Files Retrieved

1. `/home/quzma/.pi/agent/extensions/pi-subagents/package.json` (lines 40-43) — test scripts define two runners with different flags
2. `/home/quzma/.pi/agent/extensions/pi-subagents/test/support/register-loader.mjs` (lines 1-15) — loader hooks for both test suites
3. `/home/quzma/.pi/agent/extensions/pi-subagents/test/support/ts-loader.mjs` (lines 1-126) — resolves `.js` → `.ts` imports for ESM source files
4. `/home/quzma/.pi/agent/extensions/pi-subagents/test/support/helpers.ts` (lines 1-188) — factories for mocks, temp dirs, and event simulation
5. `/home/quzma/.pi/agent/extensions/pi-subagents/test/unit/agent-frontmatter.test.ts` (lines 1-498) — example unit test structure

## Key Code

### Test runner commands (`package.json` lines 41-43)

```json
"test:unit": "node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts",
"test:integration": "node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts",
```

**Critical difference:**
- `test:unit` uses `--experimental-strip-types` (strips types at runtime)
- `test:integration` uses `--experimental-transform-types` (transpiles types via babel)

### Loader chain (`register-loader.mjs` lines 1-15)

```javascript
import { register } from "node:module";
register(new URL("./ts-loader.mjs", import.meta.url));
```

The loader in `register-loader.mjs` imports and registers `ts-loader.mjs` for both unit and integration tests.

### Import resolution (`ts-loader.mjs` lines 111-125)

```typescript
if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
  return nextResolve(specifier, context);
}

const jsPath = path.resolve(parentDir, specifier);
const tsPath = jsPath.replace(/\.js$/, ".ts");

if (!fs.existsSync(jsPath) && fs.existsSync(tsPath)) {
  return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
}
```

**Rule:** Source files use `.js` imports (TypeScript ESM convention), but disk files are `.ts`. The loader rewrites `.js` → `.ts` at resolve time.

### Test assertions (`agent-frontmatter.test.ts` lines 1-5)

```typescript
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
```

**Rule:** Use `node:assert/strict` and `node:test` — no vitest/jest.

### Temp directory cleanup (`helpers.ts` lines 10-18)

```typescript
export function createTempDir(prefix = "pi-subagent-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
```

Pattern: Create temp dirs in tests, cleanup in `afterEach` or with `removeTempDir()`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        TEST RUNNER                              │
│  node script + --experimental-flags + --test + loader hook     │
└───────────────────────────┬─────────────────────────────────────┘
                            │
          ┌─────────────────┴─────────────────┐
          │                                   │
    ┌─────▼─────┐                    ┌────────▼────────┐
    │ Unit tests│                    │ Integration tests│
    │ strip-types│                    │ transform-types  │
    │ test/unit/│                    │ test/integration/│
    └───────────┘                    └──────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ ts-loader.mjs       │
                    │ .js → .ts resolve    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Peer dep shims      │
                    │ (pi-coding-agent)   │
                    │ (pi-tui)            │
                    └─────────────────────┘
```

## Test Infrastructure

### Unit tests (`test/unit/`)
- Runner: `npm run test:unit` or `node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts`
- File naming: `*.test.ts` (e.g., `agent-frontmatter.test.ts`)
- Assert: `import assert from "node:assert/strict"`
- No parameter properties in source (requires `--experimental-strip-types`)

### Integration tests (`test/integration/`)
- Runner: `npm run test:integration` or `node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts`
- File naming: `*.test.ts` (e.g., `chain-prompt-hygiene.test.ts`)
- Assert: `import assert from "node:assert/strict"`
- Can use parameter properties (`constructor(private x: T)`)

### Test support (`test/support/`)

| File | Purpose |
|------|---------|
| `helpers.ts` | `createMockPi()`, `createTempDir()`, `tryImport()`, event simulators |
| `mock-pi.ts` | Mock `ExtensionAPI` and `ExtensionContext` |
| `mock-pi-script.mjs` | Mock `pi` child process for integration tests |
| `register-loader.mjs` | Registers `ts-loader.mjs` for both test suites |
| `ts-loader.mjs` | Resolves `.js` → `.ts` imports, shims peer deps |
| `shims/` | Type declaration shims for Pi packages |

### Common patterns
- Cleanup temp dirs in `afterEach()` using `try { ... } catch {}`
- Import peer deps via `tryImport()` helper (swallows `MODULE_NOT_FOUND`)
- Use `node:test` (`describe`, `it`, `afterEach`) and `node:assert/strict`

## Start Here

Open `/home/quzma/.pi/agent/extensions/pi-subagents/test/support/helpers.ts` first. It contains:
- `createTempDir()` — the pattern for test isolation
- `tryImport()` — how to safely import optional peer deps
- `makeMinimalCtx()` / `makeAgent()` — context factories

Then read `package.json` lines 41-43 to confirm which runner applies to your test type.

## Risks / Unknowns

- No explicit test file listed for `test/integration/` in the file listing — need to verify `integration/` has test files matching `*.test.ts`
- Parameter properties are forbidden in unit-testable code per `helpers.ts` comments — must use `--experimental-transform-types` for integration tests that need them
- Peer deps are optional; `tryImport()` handles missing modules gracefully

## Supervisor coordination

None required. This is read-only reconnaissance.
