# Oracle Review — wave0-quick-wins

**Verdict: Plan is sound on 4 of 5 items. Item 3 (expandCounts unification) has concrete design bugs that will cause a build failure if implemented as written. Fix described below.**

---

## Item-by-item verification

### 1. Delete `loadRunsForAgent` — ✅ SOUND
- Verified: only 1 match in entire codebase (the definition at L35, `run-history.ts`). Zero callers.
- Plan's line range (35-55) matches actual code (35:df3 → 55:b18). Correct.

### 2. Remove unreachable fallback — ✅ SOUND
- Verified: `validateExecutionInput` at L2228 enforces `Number(hasChain) + Number(hasTasks) + Number(hasSingle) === 1`. Given exactly one is true, and the definitions guarantee the corresponding `effectiveParams` field is truthy when its flag is true, one of the four try-block branches always fires. L2339 is provably unreachable.
- Plan's line range (2339-2343) matches actual code (2339:00e → 2343:8de). Correct.

### 3. Unify count expansion — ❌ THREE BUGS IN PROPOSED IMPLEMENTATION

**Bug A: Dead parameter.** The proposed signature includes `validateAndExpand: (item: T, path: string) => { expanded: T[]; error?: string }` but the body never calls it. Dead parameter — won't cause a build failure but is confusing noise that a worker will cargo-cult.

**Bug B: Impossible closure reference.** The plan proposes call sites like:
```
expandCounts(params.tasks, (task) => `tasks[${i}]`, ...)
```
`i` is the internal loop variable inside `expandCounts` — the caller has no access to it. This won't compile. Should be `(index: number) => string` passed the index by the helper, not a closure over the caller's scope.

**Bug C: Flat loop can't handle chain nesting.** `expandChainParallelCounts` has a two-level structure:
- Outer loop: iterates chain steps, skips non-parallel steps via `isParallelStep()`
- Inner loop: iterates `step.parallel` items, validates/expands count

The plan's `expandCounts` is a single flat loop. Passing `params.chain` to it would try to expand chain steps themselves by `count`, but chain steps don't have `count` — their inner `parallel` tasks do. **This will produce wrong behavior** (silently no-op on chains) or wrong error messages.

**The brief's own gotcha warned about this:** _"the shared helper must handle both shapes via callbacks, not collapse into one loop."_ The plan ignored it.

**Correct approach:** Extract only the inner kernel (validate count → spread items) as the shared helper. The chain case keeps its outer loop:

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

Call sites:
- `expandTopLevelTaskCounts(tasks)` → `expandItemCounts(tasks, i => \`tasks[\${i}]\`)`
- `expandChainParallelCounts` keeps its outer loop + `isParallelStep` guard, inner loop becomes → `expandItemCounts(step.parallel, j => \`chain[\${stepIndex}].parallel[\${j}]\`)`
- Return types: `expandTopLevelTaskCounts` returns `{ tasks }`, `expandChainParallelCounts` returns `{ chain }` — these wrappers around `expandItemCounts` handle the property name mapping.

This preserves exact error message formats and the chain's skip-non-parallel behavior.

### 4. Unexport `splitKnownThinkingSuffix` — ✅ SOUND
- Verified: only 2 grep hits in `model-info.ts` — the definition (L30) and one internal call (L43). Zero external imports.
- Removing `export` is safe. Plan's anchor (30:efd) matches.

### 5. Remove settings.ts re-exports — ✅ SOUND
- Verified: `grep -r "from.*settings.*aggregateParallelOutputs"` returns 0 hits. All 3 callers (`chain-execution.ts`, `subagent-executor.ts`, `subagent-runner.ts`) import directly from `parallel-utils.ts`.
- Plan's anchors (629:578, 630:c09) match actual lines.

---

## Acceptance criteria coverage

| Criterion | Plan covers? |
|-----------|-------------|
| `npm run typecheck` passes | ✅ Each step verifies |
| `npm test` passes with 490 count | ✅ Each step verifies |
| `loadRunsForAgent` gone | ✅ Step 1 |
| Unreachable fallback removed | ✅ Step 2 |
| `splitKnownThinkingSuffix` unexported | ✅ Step 4 |
| Settings re-exports removed | ✅ Step 5 |
| Single `expandCounts` replaces both | ❌ Step 3 as written won't work for chains |
| grep checks return zero | ✅ Steps 1 + 5 |

## Out-of-scope check

Plan stays within bounds. No scope creep. No touches to ChainClarifyComponent, TUI, schemas, tsconfig, or runners.

## Risks the plan correctly identified

- Anchor staleness after deletions — correct, plan warns about re-reading
- Type export breakage — verified false via grep, correct assessment
- Count expansion error messages — **this is where the plan's own implementation fails**

## Overall assessment

**Proceed with the plan, but revise Step 3** before handing to a worker. The worker should implement `expandItemCounts` as a shared inner-kernel helper, not a flat replacement for both functions. The chain wrapper (`expandChainParallelCounts`) becomes a thin function that calls `expandItemCounts` for each parallel step's task array. Steps 1, 2, 4, 5 can be implemented exactly as planned.
