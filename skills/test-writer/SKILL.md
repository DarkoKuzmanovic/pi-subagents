---
name: test-writer
description: |
  Discover and follow project test infrastructure before writing tests.
  Use when a subagent is tasked with writing unit or integration tests.
  Prevents repeated mistakes like wrong test runners, missing shims,
  or ignoring existing helpers and mock patterns.
---

# Test Writer

You are writing tests for an existing project. Before writing any test code, you **must** complete the discovery phase below. Do not skip steps or assume defaults.

## Phase 1: Discover test infrastructure

Run these checks in order. Record each answer — you will need them all.

### 1. Find the test runner command

```bash
# Check package.json scripts first
grep -A5 '"test"' package.json
# Check for known test config files
ls vitest.config.* jest.config.* .mocharc.* tsconfig.test.* 2>/dev/null
```

If `package.json` has a `test:unit` or `test:integration` script, use that. If tests use `node --test`, check which TypeScript loader is needed (tsx, ts-node, --experimental-strip-types, --experimental-transform-types).

### 2. Find existing test files

```bash
find test -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" | head -10
```

Read at least two existing test files that are closest to the code you are testing. Extract:
- Import style (node:test, vitest, jest, mocha)
- Describe/it or test() structure
- How TypeScript source is imported (relative `.ts` paths, compiled `.js`, aliases)

### 3. Find test helpers and fixtures

```bash
ls test/support/ test/helpers/ test/fixtures/ test/__helpers__/ test/utils/ 2>/dev/null
```

Read the helper files. Look for:
- Factory functions (makeCtx, createMock, etc.)
- Shared mock objects (mock theme, mock TUI, mock context)
- Custom loaders or shims (register-loader, ts-loader, setup files)
- `tryImport` or conditional module loading patterns

### 4. Identify mocking patterns

Check how the project mocks dependencies:
- Direct object mocks: `{ requestRender() {} }`
- Module-level shims: loader hooks that replace imports
- Spy/stub libraries: sinon, jest.fn, vi.fn

If there is a loader shim that stubs certain modules, understand what it returns. For example, if `matchesKey` always returns `false` in tests, do not write tests that rely on `matchesKey` — test via direct method calls instead.

### 5. Check for TypeScript gotchas

```bash
# Does the project use parameter properties?
grep -r "private readonly\|public readonly\|protected readonly" src/ --include="*.ts" -l | head -3
```

If the source uses TypeScript parameter properties (`constructor(private readonly x: Type)`), `--experimental-strip-types` will fail. Use `tsx` or `--experimental-transform-types` instead.

## Phase 2: Write tests

Now write the tests. Follow these rules:

1. **Mirror the existing test structure exactly.** Use the same import style, describe/it nesting, and assertion library you found in Phase 1.

2. **Use existing helpers.** If `test/support/helpers.ts` has `makeMinimalCtx()`, use it. Do not create your own mock context.

3. **Use the discovered test command.** Run tests with the exact command you found. Do not invent a different runner.

4. **Write one test group, run, fix, repeat.** Do not write all tests at once. Write a small group (3-5 tests), run the test command, fix any failures, then continue.

5. **Test behavior, not internal state.** Prefer calling public methods and asserting rendered output over directly mutating internal properties. If the mocking infrastructure prevents behavior testing (e.g., keyboard shim stubs all keys), document why and test via the next-best approach.

## Phase 3: Validate

After all tests are written:

```bash
# Run the full test suite, not just your new file
<discovered-test-command> 2>&1
```

Verify:
- All new tests pass
- No existing tests broke
- No skipped tests that should run

## Chain context

If you received context from a prior chain step (scout, worker, context-builder), check it for:
- Test runner commands already discovered
- Known test infrastructure quirks
- Helper functions the prior step used

Do not re-discover what was already found. Use the prior step's knowledge directly.
