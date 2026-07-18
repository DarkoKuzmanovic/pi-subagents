# Wave 1+2: Unify FG/BG Execution — Complete

## Summary
All 9 steps implemented. 525 tests pass, 4 pre-existing failures. Zero regressions.

## Steps Completed

### Steps 1-4: New shared modules
| File | Exports | Lines |
|------|---------|-------|
| `src/runs/shared/usage.ts` | `emptyUsage`, `sumUsage` | 15 |
| `src/runs/shared/exit-drain.ts` | `FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`, `DrainTimers`, `createDrainTimers`, `clearDrainTimers`, `startFinalDrain` | 44 |
| `src/runs/shared/output-buffer.ts` | `RecentOutputBuffer`, `createRecentOutputBuffer` | 24 |
| `src/runs/shared/stdio-parser.ts` | `LineProcessor`, `LineProcessorCallbacks`, `createLineProcessor` | 35 |

### Step 5: Unit tests (32 new tests)
- `test/unit/usage.test.ts` — 5 tests
- `test/unit/exit-drain.test.ts` — 7 tests
- `test/unit/output-buffer.test.ts` — 10 tests
- `test/unit/stdio-parser.test.ts` — 10 tests

### Steps 6-7: Consumer refactors
- `execution.ts`: Removed local `emptyUsage`, `sumUsage`, `appendRecentOutput`, drain timer constants. Uses shared imports + `createLineProcessor` + `createRecentOutputBuffer`.
- `subagent-runner.ts`: Removed local `emptyUsage`, drain timer constants. Uses shared imports + `createLineProcessor` + `createRecentOutputBuffer`.

### Step 8: `executeAsyncSingle` → thin wrapper
- Deleted ~125 lines of duplicate spawn/event/runner code
- Replaced with ~35-line thin wrapper delegating to `executeAsyncChain`
- `AsyncChainParams.resultMode` widened to `SubagentRunMode`
- Zero caller changes (20 test calls + 3 production calls unchanged)

## Design Decisions
- **Drain timer mechanics**: Only constants shared for Steps 6-7 (existing code uses nested timers with conditional SIGKILL). Factory functions available for Step 8 / future code.
- **`appendRecentStepOutput`**: Per-call buffer (pre-populate → append → snapshot) to avoid per-step lifecycle complexity.
- **`accumulateUsage`**: Dropped per oracle review — neither consumer can use it due to divergent event schemas.

## Verification
```
npm test: 525 pass, 4 fail (pre-existing) ✅
Local emptyUsage/sumUsage defs: 0 ✅
Local FINAL_STOP_GRACE_MS/HARD_KILL_MS defs: 0 ✅
executeAsyncSingle count: 1 (wrapper only) ✅
```

## Net LOC Impact
- New shared modules: +118 lines
- New unit tests: ~150 lines
- Deleted from consumers: ~200 lines
- Step 8 deletion: ~125 lines → +35 lines wrapper = -90 net
- **Overall: ~-22 lines of production code, +150 lines of tests**
