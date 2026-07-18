# Wave 0: Quick Wins — Worker Output

## Summary
All 5 items implemented successfully. Zero behavior change. All tests pass (596 ✔, 0 ✗).

## Changes Made

### Item 1: Delete `loadRunsForAgent()` from `run-history.ts`
- **File:** `src/runs/shared/run-history.ts`
- Removed lines 35-56 (entire `loadRunsForAgent` function)
- File now contains only `RunEntry` interface and `recordRun` function
- `grep -r "loadRunsForAgent" src/` → zero hits ✅

### Item 2: Remove unreachable "Invalid params" fallback from `subagent-executor.ts`
- **File:** `src/runs/foreground/subagent-executor.ts`
- Deleted lines 2339-2343 (the `return withForkContext({...})` block)
- All 4 branches above already return; this code was provably unreachable
- `grep -n "Invalid params" subagent-executor.ts` → zero hits ✅

### Item 3: Unify count-expansion inner kernel into `expandItemCounts` helper
- **File:** `src/runs/foreground/subagent-executor.ts`
- Deleted `expandTopLevelTaskCounts` (old L724-738, 15 lines)
- Refactored `expandChainParallelCounts` to use `expandItemCounts` for inner loop (preserved outer loop + `isParallelStep` guard)
- Added `expandItemCounts<T>(items, pathPrefix)` — inner kernel that validates count, expands items
- Replaced call site: `expandTopLevelTaskCounts(params.tasks)` → `expandItemCounts(params.tasks, i => 'tasks[${i}]')`
- `expandChainParallelCounts` internally calls `expandItemCounts(step.parallel, j => 'chain[${stepIndex}].parallel[${j}]')`
- Error messages preserved exactly: `"tasks[0].count must be an integer >= 1"`, `"chain[0].parallel[0].count must be an integer >= 1"`
- Net: -7 lines (deleted 23, added 16)
- `grep -r "expandTopLevelTaskCounts" src/` → zero hits ✅

### Item 4: Unexport `splitKnownThinkingSuffix` in `model-info.ts`
- **File:** `src/shared/model-info.ts`
- Removed `export` keyword from `splitKnownThinkingSuffix` function (line 30)
- Function remains unchanged internally; only visibility changed
- `grep -r "splitKnownThinkingSuffix" src/ | grep -v model-info.ts` → zero hits ✅

### Item 5: Remove unused re-exports from `settings.ts`
- **File:** `src/shared/settings.ts`
- Deleted 2 re-export lines (old L629-630):
  - `export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";`
  - `export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";`
- All 3 consumers already import directly from `parallel-utils.ts`
- `grep -r "from.*settings.*aggregateParallelOutputs" src/` → zero hits ✅

## Verification Results

| Check | Result |
|-------|--------|
| `npm run typecheck` | Passes (329 pre-existing shim errors, 0 new) |
| `npm test` | 596 ✔, 0 ✗ |
| `grep -r "loadRunsForAgent" src/` | Zero hits ✅ |
| `grep -r "from.*settings.*aggregateParallelOutputs" src/` | Zero hits ✅ |
| `splitKnownThinkingSuffix` not exported | Confirmed ✅ |
| Unreachable fallback removed | Confirmed ✅ |
| `expandTopLevelTaskCounts` removed | Confirmed ✅ |

## Net LOC Impact
- Deleted: ~42 lines (loadRunsForAgent ~22, unreachable fallback ~5, expandTopLevelTaskCounts ~15, re-exports ~2, export keyword ~1, but expandItemCounts adds back ~13 and expandChainParallelCounts refactored adds ~3)
- Net: **~-7 lines** (conservative; main win is dead code elimination and conceptual reduction of 2 functions → 1 shared kernel)

## Risks Encountered
None. All 5 items were straightforward. No anchor staleness issues (re-read files between edits as instructed).
