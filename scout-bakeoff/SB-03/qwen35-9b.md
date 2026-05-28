# Scout Brief SB-03: Test Infrastructure Handoff

## Answer First

**To add a new unit test in this repository:**

1. **Runner:** `node --experimental-strip-types --import ./test/support/register-loader.mjs --test <test-file>.test.ts`
2. **File location:** `test/unit/` (unit tests) or `test/integration/` (integration tests)
3. **Naming convention:** `<name>.test.ts`
4. **Loader:** `./test/support/register-loader.mjs` must be imported
5. **Import style:** ESM with `.js` extensions (TypeScript convention), even though files on disk are `.ts`

**Correct command:**
```bash
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/your-test-file.test.ts
```

**Integration tests use `--experimental-transform-types` instead of `--experimental-strip-types`.**

---

## Evidence

| Source | Line | Evidence |
|--------|------|----------|
| `package.json` | 42 | Unit test: `test:unit = node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts` |
| `package.json` | 43 | Integration test: `test:integration = node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts` |
| `register-loader.mjs` | 1-15 | Loader registers `ts-loader.mjs` which rewrites `.js` imports to `.ts` at resolve time |
| `ts-loader.mjs` | 100-126 | When a `.js` import is requested but not found, the loader checks for corresponding `.ts` file and resolves to it |
| `helpers.ts` | 1 | Uses `.ts` imports (`import * as fs from "node:fs"`) — standard TypeScript ESM pattern |
| `mock-pi.ts` | 1-127 | Test support module using `.ts` file with `.ts` imports |

**Key insight:** Source files use `.js` imports (TypeScript ESM convention per `ts-loader.mjs:2-3`), but actual files on disk are `.ts`. The loader bridges this gap.

---

## Flow or Map

```
┌─────────────────────────────────────────────────────────────────┐
│                    Test Infrastructure Flow                     │
└─────────────────────────────────────────────────────────────────┘

User writes test file:
  test/unit/foo.test.ts  (file extension: .ts)

Test runner command:
  node --experimental-strip-types \
    --import ./test/support/register-loader.mjs \
    --test test/unit/foo.test.ts

Loader resolution path:
  1. --import ./test/support/register-loader.mjs → registers ts-loader
  2. Node resolves import("node:fs") → returns "node:fs" as-is
  3. Node resolves import("./shared/utils.js") → ts-loader rewrites to .ts
  4. Node loads actual .ts file from disk

Test execution:
  node --test executes test file with loaded modules
```

**Loader resolution algorithm** (`ts-loader.mjs:100-126`):
```
For import "./some/path.js":
  1. Try to resolve "./some/path.js"
  2. If not found, try "./some/path.ts"
  3. Return resolved .ts path
```

---

## Risks / Unknowns

| Risk | Severity | Mitigation |
|------|----------|------------|
| Using `--experimental-transform-types` for unit tests | High | Unit tests require `--experimental-strip-types`; integration tests need `--experimental-transform-types` for parameter properties |
| Forgetting to import `register-loader.mjs` | High | Tests will fail with module resolution errors |
| Using `.test.js` extension instead of `.test.ts` | Medium | Loader expects `.js` imports; file must be `.ts` on disk |
| Importing from `@earendil-works/*` without proper shim | Medium | Peer deps are optional; tests may fail if not installed (loader has shims) |
| Parameter properties in unit-testable code | Medium | Unit tests use `--experimental-strip-types` which doesn't support parameter properties; use `--experimental-transform-types` instead |

**Known gap:** If code uses TypeScript parameter properties (`constructor(private x: T)`), unit tests must use `--experimental-transform-types` instead of `--experimental-strip-types`. This is the tradeoff noted in `register-loader.mjs:9-10`.

---

## Worker Handoff

**To implement a new unit test:**

1. Create file: `test/unit/your-module.test.ts`
2. Import `register-loader.mjs` explicitly:
   ```ts
   import "./test/support/register-loader.mjs";
   ```
3. Use standard TypeScript imports (`.ts` imports, `.js` for external libs):
   ```ts
   import { makeMockPi } from "./support/mock-pi.ts";
   ```
4. Run tests:
   ```bash
   npm test  # runs test:unit
   # or explicitly:
   node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/your-module.test.ts
   ```

**To implement an integration test:**

1. Create file: `test/integration/your-module.test.ts`
2. Import `register-loader.mjs` explicitly
3. Run tests:
   ```bash
   npm run test:integration
   ```

**Verify:** Run `node --check <file>.ts` before committing to catch syntax errors.

---
