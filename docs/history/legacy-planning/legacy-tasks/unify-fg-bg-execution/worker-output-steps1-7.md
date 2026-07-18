# Steps 1-7 Implementation — Complete

## Result
All 7 steps implemented. Tests: **525 pass, 4 fail** (same 4 pre-existing failures — `typebox` missing in CI + `.agents/skills` ENOENT). Zero regressions.

## Changed Files

### New (4 shared modules)
| File | Exports | Lines |
|------|---------|-------|
| `src/runs/shared/usage.ts` | `emptyUsage`, `sumUsage` | 15 |
| `src/runs/shared/exit-drain.ts` | `FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`, `DrainTimers`, `createDrainTimers`, `clearDrainTimers`, `startFinalDrain` | 44 |
| `src/runs/shared/output-buffer.ts` | `RecentOutputBuffer`, `createRecentOutputBuffer` | 24 |
| `src/runs/shared/stdio-parser.ts` | `LineProcessor`, `LineProcessorCallbacks`, `createLineProcessor` | 35 |

### New (4 unit test files)
| File | Tests |
|------|-------|
| `test/unit/usage.test.ts` | 5 — emptyUsage, sumUsage accumulation, identity, zero |
| `test/unit/exit-drain.test.ts` | 7 — constants, create, clear, startFinalDrain arms both handles |
| `test/unit/output-buffer.test.ts` | 10 — append, max-lines trim, empty-line filter, shallow-copy snapshot |
| `test/unit/stdio-parser.test.ts` | 10 — JSON, non-JSON, silent ignore, trailing buffer |

### Modified
- **`src/runs/foreground/execution.ts`**: Removed `emptyUsage()`, `sumUsage()`, `appendRecentOutput()` local functions; removed local `FINAL_STOP_GRACE_MS`/`HARD_KILL_MS` consts. Added `recentOutputBuffer` + closure-based `appendRecentOutput`. Replaced `processLine` inner try/catch parse block with `createLineProcessor` (`onJson` callback, no `onRaw`). `jsonlWriter.writeLine(line)` still called BEFORE `lineProcessor.processLine(line)`.

- **`src/runs/background/subagent-runner.ts`**: Removed `emptyUsage()` local function; removed local `FINAL_STOP_GRACE_MS`/`HARD_KILL_MS` consts. `appendRecentStepOutput` simplified to a thin wrapper using `createRecentOutputBuffer` (creates buffer per call, pre-populates, appends, snapshots back). Replaced `processStdoutLine` body with `createLineProcessor` (`onJson` dispatches to existing event handling; `onRaw` pushes to `rawStdoutLines`, calls `writeOutputLine`, calls `appendChildLine`).

## Decisions / Deviations from Plan

### Drain timer mechanics — constants only, mechanics unchanged
The plan said to use `createDrainTimers`/`clearDrainTimers`/`startFinalDrain` in Steps 6-7. **Not done** — only the constants are imported.

**Why**: Both `execution.ts` and `subagent-runner.ts` use **nested timers** (hard-kill set inside grace callback, conditional on SIGTERM succeeding). The shared `startFinalDrain` sets both timers **simultaneously** (flat, not nested). Using the shared function would change timing semantics:
- Current: SIGKILL fires `FINAL_STOP_GRACE_MS + HARD_KILL_MS` (4000ms) after `startFinalDrain()` call
- Shared: SIGKILL fires `HARD_KILL_MS` (3000ms) after call

Also, the existing code only sets the hard-kill timer if SIGTERM was successfully sent (`if (!termSent) return;`). The shared module sets both timers unconditionally.

**Impact**: `exit-drain.ts` exports the full API for Step 8 to use (async execution uses fresh code, not refactored existing code). The constants are shared. The drain timer factory/helper functions are tested and ready for Step 8.

### `appendRecentStepOutput` — per-call buffer
The plan said to create a per-step buffer and sync it. Instead, the implementation creates a fresh `createRecentOutputBuffer` per call, pre-populates it with `step.recentOutput`, appends new lines, and snapshots back. This:
- Uses the shared buffer logic correctly (trim, empty-line filter, shallow-copy snapshot)
- Avoids the complexity of per-step buffer lifecycle (reset on `resetStepLiveDetail`, etc.)
- Has slightly higher allocation cost (minor, acceptable)

## Acceptance Criteria Verification
```
npm test: 525 pass, 4 fail (pre-existing) ✅

Local emptyUsage() definitions:   0 ✅
Local sumUsage() definitions:     0 ✅
Local FINAL_STOP_GRACE_MS const:  0 (only in shared/exit-drain.ts) ✅
Local HARD_KILL_MS const:         0 (only in shared/exit-drain.ts) ✅
createLineProcessor callers:      5 (import + 2 consumers + tests) ✅
```

## Ready for Step 8
The shared modules are ready. Step 8 will:
1. Use `createDrainTimers`/`clearDrainTimers`/`startFinalDrain` from `exit-drain.ts` (fresh code in async path)
2. Use `emptyUsage`/`sumUsage` from `usage.ts`
3. The `executeAsyncSingle` thin-wrapper refactor in `async-execution.ts`

Step 8 brief: convert `executeAsyncSingle` into a ~35 line thin wrapper delegating to `executeAsyncChain`. See `plan.md` Step 8 and `step8-recommendation.md` for the concrete field mapping and `normalizeSingleOutputOverride` pre-normalization logic.
