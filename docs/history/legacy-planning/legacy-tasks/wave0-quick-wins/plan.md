# Implementation Plan

## Goal
Remove dead code, unreachable branches, unused exports, and unify duplicated count-expansion helpers — zero behavior change.

## Tasks

### 1. Delete dead `loadRunsForAgent()` export from `run-history.ts`
- **File:** `src/runs/shared/run-history.ts`
- **Changes:** Remove lines 35-55 (the entire `loadRunsForAgent` function). Keep `RunEntry` interface and `recordRun` function (still used by 3 callers).
- **Acceptance:** `grep -r "loadRunsForAgent"` returns zero hits; `npm run typecheck` passes; `npm test` passes with 490 tests.
- **Anchor reference:** `35:df3` (line to delete)

### 2. Remove unreachable "Invalid params" fallback from `subagent-executor.ts`
- **File:** `src/runs/foreground/subagent-executor.ts`
- **Changes:** Delete lines 2339-2343 (the `return withForkContext({...})` block at ~L2339). Lines 2322-2326 already cover all cases via early returns; this fallback is unreachable.
- **Acceptance:** Code compiles without errors; behavior unchanged (all paths already return via try-catch); `npm run typecheck` passes.
- **Anchor reference:** `2339:00e` (line to delete)

### 3. Unify count-expansion inner kernel into shared `expandItemCounts` helper
- **File:** `src/runs/foreground/subagent-executor.ts`
- **Changes:**
  - Delete `expandTopLevelTaskCounts` at lines 724-738
  - Refactor `expandChainParallelCounts` at lines 740-763 to use the shared kernel
  - Add new shared `expandItemCounts` function (inner kernel only — validates count, expands items):
    ```typescript
    function expandItemCounts<T>(
      items: T[],
      pathPrefix: (index: number) => string,
    ): { expanded?: T[]; error?: string } {
      const expanded: T[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const rawCount = (item as T & { count?: unknown }).count;
        if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
          return { error: `${pathPrefix(i)}.count must be an integer >= 1` };
        }
        const { count, ...concrete } = item as Record<string, unknown>;
        for (let r = 0; r < ((rawCount as number) ?? 1); r++) {
          expanded.push({ ...concrete } as T);
        }
      }
      return { expanded };
    }
    ```
  - Replace `expandTopLevelTaskCounts` call with:
    ```typescript
    const result = expandItemCounts(params.tasks, i => `tasks[${i}]`);
    if (result.error) return { error: result.error };
    params = { ...params, tasks: result.expanded };
    ```
  - Refactor `expandChainParallelCounts` to keep its outer loop + `isParallelStep` guard, but replace inner loop with:
    ```typescript
    const inner = expandItemCounts(step.parallel, j => `chain[${stepIndex}].parallel[${j}]`);
    if (inner.error) return { error: inner.error };
    expandedChain.push({ ...step, parallel: inner.expanded! });
    ```
- **Why not a flat replacement:** Chain steps have a two-level structure (outer: steps with `isParallelStep` guard, inner: parallel tasks with count). The brief's gotcha warned about this. `expandItemCounts` is the shared kernel; each caller wraps it for its shape.
- **Acceptance:** Count expansion behavior identical; error messages preserved exactly; `npm run typecheck` passes; `npm test` passes with 490 tests.
- **Anchor reference:** `724:e30` (first function to delete)

### 4. Make `splitKnownThinkingSuffix` internal-only in `model-info.ts`
- **File:** `src/shared/model-info.ts`
- **Changes:** Remove `export` keyword from `splitKnownThinkingSuffix` function at line 30. Function remains unchanged; only visibility changes.
- **Acceptance:** `grep -r "splitKnownThinkingSuffix"` shows only internal usage in `findModelInfo`; `npm run typecheck` passes (no external breakage).
- **Anchor reference:** `30:efd` (line to modify)

### 5. Remove unused re-exports from `settings.ts`
- **File:** `src/shared/settings.ts`
- **Changes:** Delete lines 629-630:
  ```typescript
  export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
  export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
  ```
- **Acceptance:** `grep -r "from.*settings.*aggregateParallelOutputs\|from.*settings.*ParallelTaskResult"` returns zero hits; `npm run typecheck` passes; `npm test` passes with 490 tests.
- **Anchor reference:** `629:578` (lines to delete)

## Files to Modify
- `src/runs/shared/run-history.ts` — delete `loadRunsForAgent` function (lines 35-55)
- `src/runs/foreground/subagent-executor.ts` — delete unreachable fallback (lines 2339-2343); delete two functions (724-738, 740-763); add `expandCounts` helper
- `src/shared/settings.ts` — delete re-export lines 629-630
- `src/shared/model-info.ts` — remove `export` from `splitKnownThinkingSuffix` (line 30)

## New Files
- None

## Dependencies
- Tasks 1-5 are independent; can execute in any order
- Task 3 (unification) should be done after confirming current behavior via quick grep/trace if desired (not strictly necessary since all 490 tests exist)

## Risks
1. **Anchor staleness:** After deleting large code blocks, line numbers shift. Re-read files before subsequent edits to get fresh `LINE:HASH` anchors.
2. **Type exports:** Removing `loadRunsForAgent` export may break type imports if any file uses `import type { loadRunsForAgent }` (unlikely; grep shows zero callers). Validate with `npm run typecheck`.
3. **Count expansion edge cases:** The shared helper must preserve exact error message format (`tasks[0].count must be an integer >= 1`). Test with `npm test` to ensure 490 tests pass.
4. **Re-export drift:** Removing re-exports from `settings.ts` is safe since grep confirms zero external consumers from that path. Importers already use direct paths.
5. **Unreachable code false confidence:** The "Invalid params" fallback appears in defensive code but is unreachable due to exhaustive if-else chain. Removing it is safe; try-catch at L2327 handles real errors.

## Verification
After all changes:
```bash
npm run typecheck          # Should pass clean
npm test                   # Should pass with 490 tests
grep -r "loadRunsForAgent"                               # Zero hits
grep -r "from.*settings.*aggregateParallelOutputs"       # Zero hits
```

## Supervisor coordination
None required. All changes are removals/unifications with zero behavior change. Tests provide verification.
