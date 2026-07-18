# Oracle Gate: Phases 1–4 Review

## What was done

All four phases from the adopt-upstream-features plan have been implemented against upstream/main (v0.25.0). The review should verify correctness, safety, and completeness.

---

## Phase 1 — Prompt files (additive copies)

Three files copied verbatim from upstream/main:

- `prompts/review-loop.md` — parent-controlled worker→reviewer→worker loop with stop-on-clean or iteration cap
- `prompts/gather-context-and-clarify.md` — subagent context gathering then clarifying questions before planning
- `prompts/parallel-context-build.md` — parallel fresh-context `recon` agents for planning handoff

**Concern:** These are purely additive copies. No model adaptation was done. Verify they auto-register as slash commands on restart (Pi reads `prompts/` from `package.json` contributions).

---

## Phase 2 — Nested* types (additive)

Added to `src/shared/types.ts`:
- `NestedRunSummary`, `NestedRouteInfo`, `NestedRunMatch`, `NestedRunResolutionScope`
- `NestedRunState`, `NestedOwnerState`, `NestedRunAddress`, `NestedStepSummary`
- `PublicNestedStepSummary`, `PublicNestedRunSummary`
- `NestedRunSummary[]` fields on `SubagentResultIntercomChild`, `AsyncStatus.steps[]`, `AsyncJobState`, `ForegroundResumeChild`, `ForegroundResumeRun`, `RunSyncOptions`
- `NestedRouteInfo` field on `AsyncStartedEvent`

Added to `src/runs/shared/pi-args.ts`:
- `FANOUT_CHILD_EXTENSION_PATH` constant
- `PI_SUBAGENT_PARENT_*` env var constants (9 new)
- `parentEventSink?`, `parentControlInbox?`, `parentRootRunId?`, `parentRunId?`, `parentChildIndex?`, `parentDepth?`, `parentPath?`, `parentCapabilityToken?` in `BuildPiArgsInput`
- `parseParentPathEnv` export

**Concern:** All purely additive. No removals.

---

## Phase 3 — Async child session tracking (additive with fork-preservation constraint)

The human decision was: **KEEP ALL OUR FORK FEATURES EVERYWHERE**. This means for shared files (types.ts, pi-args.ts, subagent-executor.ts): apply only upstream's additive changes; skip all subtractive changes.

### Changes to `src/runs/background/stale-run-reconciler.ts`:
- Added imports: `nestedSummaryFromAsyncStatus`, `projectNestedEvents`, `resolveNestedAsyncDir`, `writeNestedEvent`, `type NestedRoute` from `nested-events.ts`; `type AsyncStatus`, `type NestedRunSummary` from `types.ts`
- Added `terminal()` helper (determines if an async state is terminal)
- Added `nestedRuns()` generator — recursively yields all nested runs from `NestedRunSummary[]` including children and step children
- Added `reconcileNestedAsyncDescendants(route, options)` — for each running/queued nested run, reconciles it and writes `subagent.nested.completed` or `subagent.nested.updated` events back to the nested event log

### Changes to `src/runs/background/async-job-tracker.ts`:
- Added imports: `reconcileNestedAsyncDescendants` from `stale-run-reconciler`; `hasLiveNestedDescendants`, `updateAsyncJobNestedProjection` from `nested-events`
- **`handleStarted`**: Added `nestedRoute: info.nestedRoute` to the job state object so jobs are born with their nested route
- **`handleComplete`**: Wrapped `updateAsyncJobNestedProjection(job)` in try/catch; changed `scheduleCleanup` guard from unconditional to `if (!hasLiveNestedDescendants(job?.nestedChildren))` — jobs with live nested children survive until all descendants are terminal
- **`ensurePoller` poll cycle**: Added `reconcileNestedDescendants()` block that calls `reconcileNestedAsyncDescendants` then `updateAsyncJobNestedProjection` (both wrapped in try/catch with `nestedRefreshFailed` flag); added `hasLiveNestedDescendants` guard on cleanup scheduling in the terminal-state block

**Key question:** Does the poll cycle call `emitNewControlEvents` before or after `reconcileNestedDescendants`? Order matters — verify the ordering is correct (upstream calls reconcile then emit, our fork should match).

**Key question:** The `nestedRefreshFailed` flag in `handleComplete` is declared but never used to gate anything after the try/catch — verify this is correct.

---

## Phase 4 — Fan-out merge (most complex, additive with fork-preservation)

### New files added:
- `src/extension/fanout-child.ts` (170 lines) — fanout-authorized child entrypoint
- `src/runs/shared/nested-events.ts` (819 lines) — parent-child event relay, nested run registry, `attachNestedChildrenToResultChildren`, `updateAsyncJobNestedProjection`, `updateForegroundNestedProjection`, `hasLiveNestedDescendants`, `nestedSummaryFromAsyncStatus`, etc.
- `src/runs/shared/nested-path.ts` (52 lines) — nested run path encoding/parsing
- `src/runs/shared/nested-render.ts` (115 lines) — TUI rendering for nested run status lines
- `src/runs/background/run-id-resolver.ts` (83 lines) — resolves subagent run IDs by pattern

### New test files:
- `test/unit/nested-events.test.ts`
- `test/unit/widget-nested-render.test.ts`
- `test/unit/run-id-resolver.test.ts`

### `src/intercom/result-intercom.ts` changes (+115 lines):
- Added `NestedRunSummary` type import
- Added `GroupedResultIntercomMessageInput.nestedChildren?: NestedRunSummary[]`
- Added `buildSubagentResultIntercomPayload` uses `attachNestedChildrenToResultChildren`
- Added `attachNestedChildrenToResultChildren`, `compactNestedResultChildren`, `nestedRunLabel` functions
- Added `NestedResultChild` type

### `src/runs/shared/pi-args.ts` changes (+28 lines):
- Added `FANOUT_CHILD_EXTENSION_PATH` constant
- Added `SUBAGENT_PARENT_*` env var constants (9 new)
- Added `parentEventSink?`, `parentControlInbox?`, `parentRootRunId?`, `parentRunId?`, `parentChildIndex?`, `parentDepth?`, `parentPath?`, `parentCapabilityToken?` in `BuildPiArgsInput`
- Added `parseParentPathEnv` export
- **Bug fixed:** Removed duplicate `export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD"` declaration (was declared twice)

### `src/runs/foreground/subagent-executor.ts` changes (+356/-164):
**Method:** git three-way merge (`git merge-file`) of HEAD × upstream/main × our-fork's partially-edited working copy. Result: 520 net additions, zero conflict markers.

**What's preserved from our fork (NOT removed):**
- `appendTokenFooter` import and all usages
- `emitRecoveryEvent` import and all usages  
- `clearInlineReadCache` import and usage
- `inlineReads` fresh-context blocks in `runSinglePath` and `runParallelPath`
- `skipContextFiles` param in all execution calls
- `validateExecutionInput` chain parallel check
- `expandItemCounts` generalized function (not specialized to top-level only)
- `SubagentParamsLike.reads?` field
- `ControlConfig` timeout fields (`stepInactivityTimeoutMs`, `runWallClockTimeoutMs`, `timeoutAction`, `escalationGraceMs`)
- `disallowedTools` deny-list pattern

**What's added from upstream:**
- `NestedRouteInfo`, `NestedRunSummary` type imports
- `MUTATING_MANAGEMENT_ACTIONS` constant
- `allowMutatingManagementActions?: boolean` in `ExecutorDeps`
- `nestedRoute` field in `ExecutionContextData`
- `nestedResolutionScopeForExecutor()` function
- All `nestedRun*` helpers (`nestedRunSessionFile`, `nestedRunAgent`, `pathWithin`, `validateNestedSessionFile`, `resolveNestedResumeTarget`)
- `waitForNestedControlResult`, `sendNestedControlRequest`, `directNestedAsyncInterrupt`, `interruptNestedRun`, `resumeLiveNestedRun` functions
- `attachNestedChildrenToResultChildren` call in `emitForegroundResultIntercom`
- `nestedRoute` in all `runAsyncPath`/`runChainPath`/`runParallelPath`/`runSinglePath` calls
- `writeNestedForegroundEvent` function + all event calls
- `allowMutatingManagementActions` gate
- `inheritedNestedRoute` + `createNestedRoute` setup
- `state.foregroundRuns ??= new Map()` initialization (optional map)
- `NestedResumeSourceTarget` type + union with `ResumeSourceTarget`

### `src/shared/types.ts` changes (+128 lines):
- Added `PublicNestedStepSummary`, `PublicNestedRunSummary`, `NestedRunState`, `NestedOwnerState`, `NestedRunAddress`, `NestedStepSummary`, `NestedRunSummary`, `NestedRouteInfo`, `NestedRunMatch`, `NestedRunResolutionScope`
- Added `children?: PublicNestedRunSummary[]` in `SubagentResultIntercomChild`
- Added `nestedRoute?: NestedRouteInfo` in `AsyncStartedEvent`, `AsyncJobState`, `ForegroundResumeChild`, `RunSyncOptions`
- Added `nestedChildren?: NestedRunSummary[]` in `AsyncJobState`, `ForegroundResumeChild`, `ForegroundResumeRun`, `SubagentResultIntercomPayload`

### `src/runs/background/async-execution.ts` changes (+28 lines):
- Added runner stderr logging to `<asyncDir>/runner-stderr.log` instead of discarding it (fixes silent crash diagnosis)
- Token accounting wrapped in try/catch with non-fatal error logging
- `asyncDir` passed to `spawnRunner` for log file path

### `src/runs/background/async-resume.ts` changes (+55 lines):
- `resumeByChildRunId` now resolves child index from `result.results[].runId`
- Added comment: "Phase 4 will extend this to also search `nestedChildren`"

### `src/runs/background/subagent-runner.ts` changes (+67 lines):
- Token accounting moved to best-effort (try/catch)
- Step terminal status committed BEFORE token accounting to prevent "completed but marked failed" on reconciler

---

## What to verify

1. **Phase 1:** Slash commands auto-register (can only verify after restart)
2. **Phase 2:** No name collisions between new Nested* types and existing types
3. **Phase 3:** 
   - Poll cycle ordering: `reconcileNestedDescendants` then `emitNewControlEvents` — correct?
   - `nestedRefreshFailed` in `handleComplete` — is it dead code or should it gate something?
4. **Phase 4:**
   - Git three-way merge didn't lose any of our fork's subtractive features (appendTokenFooter, emitRecoveryEvent, inlineReads, skipContextFiles, ControlConfig timeouts, disallowedTools)
   - Duplicate `SUBAGENT_CHILD_ENV` is truly gone
   - All new fanout files are type-correct (TypeScript compiles clean ✓)
5. **All phases:** No new test failures beyond baseline (~49 pre-existing environmental failures: TypeScript parser issues in test files, missing @earendil-works/pi-tui package)
