# Scout Recon: Dead Code & Duplication Cleanup

## Files Retrieved

1. `src/runs/shared/run-history.ts` (lines 1-56) - Contains `loadRunsForAgent` export with **zero callers** outside its own file
2. `src/runs/foreground/subagent-executor.ts` (lines 724-763, 2320-2344) - Duplicated count expansion logic + unreachable fallback
3. `src/shared/model-info.ts` (lines 1-69) - `splitKnownThinkingSuffix` exported but only used internally by `findModelInfo`
4. `src/shared/settings.ts` (lines 629-630) - Re-exports from parallel-utils.ts with no external consumers
5. `src/runs/shared/parallel-utils.ts` (lines 1-106) - Source of re-exported types/functions

## Key Code

### Dead Export: `loadRunsForAgent`
**File:** `src/runs/shared/run-history.ts:35:df3`
```typescript
export function loadRunsForAgent(agent: string): RunEntry[] {
  // ... loads and filters run history
}
```
**Status:** **DEAD** - grep confirms zero callers outside this file. Only `recordRun` is used (3 callers in chain-execution.ts and subagent-executor.ts).

### Unreachable Fallback
**File:** `src/runs/foreground/subagent-executor.ts:2339:00e`
```typescript
return withForkContext({
  content: [{ type: "text", text: "Invalid params" }],
  isError: true,
  details: { mode: "single" as const, results: [] },
}, effectiveParams.context);
```
**Status:** **UNREACHABLE** - Control flow at lines 2322-2326 covers all cases:
- `runAsyncPath` (returns early if async)
- `runChainPath` (if `hasChain && effectiveParams.chain`)
- `runParallelPath` (if `hasTasks && effectiveParams.tasks`)
- `runSinglePath` (if `hasSingle`)

The fallback at 2339 can never execute because one of the four branches always returns.

### Duplicated Count Expansion Helpers
**File:** `src/runs/foreground/subagent-executor.ts:724-763`

**Function 1:** `expandTopLevelTaskCounts` (lines 724-738)
```typescript
function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
  const expanded: TaskParam[] = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const task = tasks[taskIndex]!;
    const rawCount = (task as TaskParam & { count?: unknown }).count;
    if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
      return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
    }
    const { count, ...concreteTask } = task;
    for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
      expanded.push({ ...concreteTask });
    }
  }
  return { tasks: expanded };
}
```

**Function 2:** `expandChainParallelCounts` (lines 740-763)
```typescript
function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
  const expandedChain: ChainStep[] = [];
  for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
    const step = chain[stepIndex]!;
    if (!isParallelStep(step)) {
      expandedChain.push(step);
      continue;
    }
    const expandedParallel = [];
    for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
      const task = step.parallel[taskIndex]!;
      const rawCount = (task as typeof task & { count?: unknown }).count;
      if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
        return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
      }
      const { count, ...concreteTask } = task;
      for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
        expandedParallel.push({ ...concreteTask });
      }
    }
    expandedChain.push({ ...step, parallel: expandedParallel });
  }
  return { chain: expandedChain };
}
```

**Status:** **DUPLICATED LOGIC** - Both functions:
- Extract `count` property from tasks
- Validate `count` is integer >= 1
- Expand tasks by repeating them `count` times
- Strip the `count` property from expanded tasks

Difference: `expandChainParallelCounts` handles nested `step.parallel` arrays and preserves non-parallel steps.

### Internal-Only Export: `splitKnownThinkingSuffix`
**File:** `src/shared/model-info.ts:30:efd`
```typescript
export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string }
```
**Status:** **INTERNAL ONLY** - Only called by `findModelInfo` (line 43) in the same file. No external callers found via grep.

### Re-export Indirection
**File:** `src/shared/settings.ts:629-630`
```typescript
export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
```
**Status:** **UNUSED RE-EXPORT** - grep confirms:
- `aggregateParallelOutputs` is imported directly from `parallel-utils.ts` by 4 files (subagent-executor.ts, chain-execution.ts, async-execution.ts, subagent-runner.ts)
- Zero files import it from `settings.ts`
- `ParallelTaskResult` type has zero external importers from `settings.ts`

## Architecture

### Run History Module (`run-history.ts`)
- **Purpose:** JSONL-based run history tracking
- **Exports:** `RunEntry` interface, `recordRun`, `loadRunsForAgent`
- **Usage:** `recordRun` called after task completion (3 call sites)
- **Dead code:** `loadRunsForAgent` has no callers - appears to be leftover from a feature that was never implemented or was removed

### Subagent Executor (`subagent-executor.ts`)
- **Purpose:** Main execution engine for single/parallel/chain subagent runs
- **Size:** 2348 lines (largest file in project)
- **Control flow:** Lines 2322-2326 form exhaustive if-else chain with early returns
- **Duplication risk:** Count expansion logic split into two near-identical functions

### Model Info (`model-info.ts`)
- **Purpose:** Model resolution and thinking level handling
- **Exports:** 8 items (2 types, 1 const, 5 functions)
- **Internal coupling:** `splitKnownThinkingSuffix` is a helper for `findModelInfo`

### Settings Re-exports (`settings.ts`)
- **Purpose:** Chain behavior resolution + directory management
- **Re-export pattern:** Lines 629-630 re-export from `parallel-utils.ts`
- **Violation:** No consumers use the re-export path - all import directly from source

## Test Infrastructure

**Test runner:** Node.js built-in test runner (`node --test`)
```bash
npm test                    # unit tests only
npm run test:all            # unit + integration
npm run typecheck           # tsc --noEmit
```

**Test files:** `test/unit/` and `test/integration/`
- Unit tests use `--experimental-strip-types`
- Integration tests use `--experimental-transform-types`
- Custom loader: `test/support/register-loader.mjs`

**Closest reference tests:**
- `test/unit/subagent-executor.test.ts` - executor logic
- `test/unit/model-info.test.ts` - model resolution
- `test/unit/settings.test.ts` - chain behavior

## Hidden Coupling & Risks

1. **Count expansion coupling:** Both `expandTopLevelTaskCounts` and `expandChainParallelCounts` validate `count` the same way. If validation rules change, both must be updated.

2. **Re-export drift:** `settings.ts` re-exports could diverge from `parallel-utils.ts` if someone adds exports to one but not the other.

3. **Dead code maintenance:** `loadRunsForAgent` could be accidentally used by future code that assumes it's tested/validated.

4. **Unreachable code false confidence:** The "Invalid params" fallback suggests error handling exists, but it never executes. Real errors are caught by the try/catch at line 2327.

## Neighboring Patterns to Match

### When removing dead exports:
- Check for TypeScript compilation errors (removing export may break type imports)
- Verify no external projects depend on this (not applicable for internal extension code)
- Keep `RunEntry` interface if still used by `recordRun` signature

### When unifying duplicated functions:
- Extract shared validation logic: `validateCount(value: unknown, path: string): Error | null`
- Extract shared expansion logic: `expandByCount<T>(items: T[], getCount: (T) => number): T[]`
- Preserve error message format (includes array indices)

### When removing re-exports:
- Confirm zero external importers first (done - grep confirms)
- Remove from settings.ts lines 629-630
- No changes needed to importers (they already use direct path)

### When making internal functions private:
- `splitKnownThinkingSuffix` can be un-exported (remove `export` keyword)
- No external callers exist
- Improves API surface clarity

## Start Here

**First file to open:** `src/runs/foreground/subagent-executor.ts`

**Why:** This file has the highest impact changes:
1. Remove unreachable fallback (lines 2339-2343) - simple deletion
2. Unify count expansion logic - requires extracting shared helper

**Second file:** `src/runs/shared/run-history.ts`

**Why:** Simple dead code removal:
1. Delete `loadRunsForAgent` function (lines 35-55)
2. Keep `RunEntry` and `recordRun` (still used)

**Third file:** `src/shared/settings.ts`

**Why:** Clean re-export indirection:
1. Remove lines 629-630
2. No downstream changes needed

**Fourth file:** `src/shared/model-info.ts`

**Why:** Internal-only export cleanup:
1. Remove `export` from `splitKnownThinkingSuffix` (line 30)

---

**Estimated effort:** 30-45 minutes
**Risk level:** Low (all changes are removals/unifications, no behavior changes)
**Verification:** Run `npm run typecheck` + `npm test` after changes
