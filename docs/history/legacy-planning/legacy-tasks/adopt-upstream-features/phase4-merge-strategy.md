# Phase 4 Merge Strategy

**Date:** 2026-05-28
**Analyst:** worker

---

## Summary of all three shared files

| File | Upstream | Our Fork | Divergence type |
|------|----------|----------|-----------------|
| `types.ts` | +118 lines | baseline | Mixed: additive + some subtractive |
| `pi-args.ts` | +78 lines | baseline | Mixed: additive + one structural |
| `subagent-executor.ts` | +520 lines | baseline | Mixed: massive additive + significant subtractive |

---

## `src/shared/types.ts` — NEEDS REVIEW (mixed)

### ADDITIVE (safe — add verbatim):
- `PublicNestedStepSummary` type
- `PublicNestedRunSummary` type
- `children?: PublicNestedRunSummary[]` in `SubagentResultIntercomChild`
- `NestedRunState`, `NestedOwnerState` types
- `NestedRunAddress` interface
- `NestedStepSummary` interface
- `NestedRunSummary` interface
- `NestedRouteInfo` interface
- `AsyncStartedEvent.nestedRoute?: NestedRouteInfo`
- `AsyncStatus.steps[].children?: NestedRunSummary[]`
- `AsyncJobState.nestedRoute?: NestedRouteInfo` + `nestedChildren?: NestedRunSummary[]`
- `ForegroundResumeChild.nestedRoute?` + `nestedChildren?`
- `RunSyncOptions.nestedRoute?: NestedRouteInfo`

### SUBTRACTIVE (HUMAN REVIEW NEEDED — we have these, upstream removed them):
- **`ActivityState`:** Our fork has `"active_long_running" | "needs_attention" | "timed_out_escalating" | "timed_out"` — upstream dropped the last two. **Which do we want?**
- **`ControlEventType`:** Our fork has extra `"timeout_killed"` — upstream dropped it. **Which do we want?**
- **`ControlConfig`:** Our fork has `stepInactivityTimeoutMs`, `runWallClockTimeoutMs`, `timeoutAction`, `escalationGraceMs` — upstream removed all four. **Keep or drop?**
- **`ResolvedControlConfig`:** Same four fields removed upstream. **Keep or drop?**
- **`ControlEvent.reason?`:** Our fork has `step_inactivity_timeout` and `run_wall_clock_timeout` — upstream dropped both. **Keep or drop?**
- **`SubagentParamsLike.reads?`:** Our fork has it, upstream removed it. **Keep or drop?**
- **`SubagentState.foregroundRuns`:** Our fork has it as required (`Map<string, ForegroundResumeRun>`), upstream made it optional (`Map<string, ForegroundResumeRun> | undefined`). **Which?**
- **`SubagentState.pendingForegroundControlNotices`:** Ours required, upstream optional. **Which?**
- **`RunSyncOptions.skipContextFiles?`:** Ours has it, upstream removed it. **Keep or drop?**
- **`ExtensionConfig.inlineReadMaxBytes?`:** Ours has it, upstream removed it. **Keep or drop?**
- **`inlineReads` param in chain execution:** Our fork passes `inlineReads: params.context === "fresh"` to `executeChain`/`executeForeground`; upstream removed this. **Keep or drop?**

---

## `src/runs/shared/pi-args.ts` — NEEDS REVIEW (one structural change)

### ADDITIVE (safe — add verbatim):
- Import `encodeNestedPathEnv`, `parseNestedPathEnv`, `NestedPathEntry` from `./nested-path.ts`
- `FANOUT_CHILD_EXTENSION_PATH` constant
- All `SUBAGENT_PARENT_*` env var constants (9 new)
- `parentEventSink?`, `parentControlInbox?`, `parentRootRunId?`, `parentRunId?`, `parentChildIndex?`, `parentDepth?`, `parentPath?`, `parentCapabilityToken?` in `BuildPiArgsInput`
- All the env var setting logic for parent route (large block, fanout-authorized)
- `parseParentPathEnv` export

### SUBTRACTIVE (HUMAN REVIEW NEEDED):
- **`disallowedTools?` field in `BuildPiArgsInput`:** Our fork has it, upstream removed it. **Keep or drop?**
- **`disallowedTools` handling in function:** Our fork uses it for deny-listing tools; upstream replaced this whole pattern with fanout authorization (`declaredBuiltinTools.includes("subagent")`). The new approach is structurally different. **We need both?** Or replace entirely with upstream's fanout approach?

---

## `src/runs/foreground/subagent-executor.ts` — NEEDS REVIEW (massive)

This is the highest-risk merge. Upstream has +520/−197 lines of changes.

### ADDITIVE (safe — add verbatim):
- New imports: `nested-events.ts` functions, `run-id-resolver.ts`, `nested-render.ts`
- `NestedRouteInfo`, `NestedRunSummary` type imports
- `MUTATING_MANAGEMENT_ACTIONS` constant
- `allowMutatingManagementActions?: boolean` in `ExecutorDeps`
- `nestedRoute?` field in `ExecutionContextData`
- `nestedResolutionScopeForExecutor()` function
- `updateForegroundNestedProjection()` call in `foregroundStatusResult`
- `formatNestedRunStatusLines()` call in status output
- `state.foregroundRuns ??= new Map()` initialization (optional map)
- `NestedResumeSourceTarget` type + union with `ResumeSourceTarget`
- All `nestedRun*` helper functions: `nestedRunSessionFile`, `nestedRunAgent`, `pathWithin`, `validateNestedSessionFile`, `resolveNestedResumeTarget`
- `waitForNestedControlResult`, `sendNestedControlRequest`, `directNestedAsyncInterrupt`, `interruptNestedRun`, `resumeLiveNestedRun` functions
- `attachNestedChildrenToResultChildren` call in `emitForegroundResultIntercom`
- `nestedRoute` in all `runAsyncPath` / `runChainPath` / `runParallelPath` / `runSinglePath` calls
- `writeNestedForegroundEvent()` function (large, writes nested events to parent)
- All `writeNestedForegroundEvent("subagent.nested.started")` / `("subagent.nested.completed")` calls
- `allowMutatingManagementActions` gate for management actions from fanout mode
- `inheritedNestedRoute` + `createNestedRoute` setup in `createSubagentExecutor`

### SUBTRACTIVE (HUMAN REVIEW NEEDED):
- **`reads?` in `SubagentParamsLike`:** Our fork has it, upstream removed it. Affects `validateExecutionInput` (chain validation). **Keep or drop?**
- **Inline reads on fresh context (`params.context === "fresh" && params.reads !== false`):** Our fork has a large block in `runSinglePath` and `runParallelPath` that injects inline reads for fresh-context children. Upstream removed both blocks entirely. **Keep or drop?**
- **`appendTokenFooter` import + all usages:** Our fork calls `appendTokenFooter()` in `runChainPath`, `runParallelPath`, `runSinglePath` for error and success paths. Upstream removed all of these. **Keep or drop?**
- **`emitRecoveryEvent` import + all usages:** Our fork has recovery telemetry in all three paths. Upstream removed all of it. **Keep or drop?**
- **`clearInlineReadCache` import + usage:** Our fork imports and calls `clearInlineReadCache()` in `createSubagentExecutor`. Upstream removed it. **Keep or drop?**
- **`validateExecutionInput` chain parallel check:** Our fork rejects steps with both `agent` and `parallel`; upstream removed this check. **Keep or drop?**
- **`expandItemCounts` generalized function:** Our fork has a generic `expandItemCounts<T>()` used by both top-level tasks and chain parallel. Upstream specialized it into `expandTopLevelTaskCounts()` (tasks only) and refactored chain parallel to inline. **Which approach?**
- **`ControlConfig` timeout fields:** These flow through to `runAsyncPath`/`runChainPath`. If we keep the fields in `types.ts`, we must keep passing them. If we drop them from `types.ts`, we must drop the passing here too.
- **Error output for single-path failure:** Our fork has a detailed recovered-output message on `exitCode !== 0`; upstream simplified to just `r.error || "Failed"`. **Which?**
- **`skipContextFiles` in execution calls:** Our fork passes `skipContextFiles: params.context === "fresh"` to all execution calls; upstream removed these params. **Keep or drop?**
- **`inlineReads: params.context === "fresh"` in chain/parallel execution calls:** Same as above. **Keep or drop?**

---

## Recommendation

For all subtractive changes in all three files: **pause and get human decision on each group before applying upstream's removals.** Many of our fork's features (recovery telemetry, inline reads, token footer, disallowedTools) may be genuinely valuable and worth preserving.

**Proceed with purely additive changes immediately** (new Nested* types, new functions, new imports). Hold on subtractive changes until the human confirms which version they want.
