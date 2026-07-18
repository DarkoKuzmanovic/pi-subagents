# Wave 0: Dead Code & Micro-Simplifications

**Goal:** Remove dead code, unreachable branches, unused exports, and unify duplicated count-expansion helpers — zero behavior change.

## In-scope files

- `src/runs/shared/run-history.ts` — delete `loadRunsForAgent()` (dead export, zero callers)
- `src/runs/foreground/subagent-executor.ts` — remove unreachable "Invalid params" fallback (~L2339); extract shared `expandCounts()` from `expandTopLevelTaskCounts` + `expandChainParallelCounts`
- `src/shared/model-info.ts` — unexport `splitKnownThinkingSuffix` (internal-only helper)
- `src/shared/settings.ts` — remove unused re-exports of `ParallelTaskResult` + `aggregateParallelOutputs` from `parallel-utils.ts` (lines 629-630)

## Out-of-scope

- Any refactoring beyond these 4 items
- ChainClarifyComponent, TUI, schemas, tsconfig, runner consolidation
- `recordRun()` and `RunEntry` interface (still used by 3 callers)

## Acceptance criteria

- [ ] `npm run typecheck` passes clean
- [ ] `npm test` passes with same 490 pass count
- [ ] `loadRunsForAgent` no longer exists in codebase
- [ ] Unreachable fallback at ~L2339 removed
- [ ] `splitKnownThinkingSuffix` has no `export` keyword
- [ ] Settings re-exports at L629-630 removed
- [ ] Single `expandCounts` helper replaces both expansion functions
- [ ] `grep -r loadRunsForAgent` returns zero hits
- [ ] `grep -r 'from.*settings.*aggregateParallelOutputs\|from.*settings.*ParallelTaskResult'` returns zero hits

## Constraints

- No behavior change — all 490 tests must pass identically
- Error message format for invalid `count` must be preserved exactly
- Count expansion must produce identical output arrays

## Gotchas

- `expandChainParallelCounts` has extra nesting (preserves non-parallel steps, iterates `step.parallel`) — the shared helper must handle both shapes via callbacks, not collapse into one loop
- `appendRecentStepOutput` in subagent-runner.ts uses `??=` for lazy init — don't touch this, it's not in scope
- Re-export removal: `chain-execution.ts` already imports directly from `parallel-utils.ts`, so no downstream changes needed

## Test-first: true
