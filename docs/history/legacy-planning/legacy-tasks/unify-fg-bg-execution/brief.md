# Unify Foreground/Background Execution

**Goal:** Extract shared child-runner primitives from duplicated foreground/background execution logic, collapse both runners onto the shared module, then absorb `executeAsyncSingle` into `executeAsyncChain`.

## In-scope files

- **New:** `src/runs/shared/exit-drain.ts` — drain timer constants + factory (`FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`, `createExitDrainHandlers`)
- **New:** `src/runs/shared/usage.ts` — `emptyUsage()`, `sumUsage()`, `usageFromAttempts()`
- **New:** `src/runs/shared/output-buffer.ts` — `createRecentOutputBuffer(maxLines)` with `append()` + `snapshot()`
- **New:** `src/runs/shared/stdio-parser.ts` — `createLineProcessor(onJson, onRaw)` for JSON stdout line parsing
- **Modify:** `src/runs/foreground/execution.ts` (~995 LOC) — consume shared modules, inline duplication removed
- **Modify:** `src/runs/background/subagent-runner.ts` (~1892 LOC) — consume shared modules, inline duplication removed
- **Modify:** `src/runs/background/async-execution.ts` — absorb `executeAsyncSingle` into `executeAsyncChain`

## Out-of-scope

- ChainClarifyComponent split (separate task)
- TUI rendering consolidation
- Schema unification
- `strict: true` in tsconfig
- `AgentProgress` ↔ `RunnerStatusStep` type unification (too risky for this pass)
- Activity state timer loop (fundamentally different models: setInterval vs file polling)
- Control event emission (callback vs JSONL)
- Worktree setup (background-only)
- Status.json writing (background-only)

## Acceptance criteria

- [ ] `npm run typecheck` passes clean
- [ ] `npm test` passes with same 490 pass count
- [ ] `npm run test:all` passes (integration tests cover both runners)
- [ ] No `emptyUsage` definition outside `runs/shared/usage.ts`
- [ ] No `FINAL_STOP_GRACE_MS` / `HARD_KILL_MS` outside `runs/shared/exit-drain.ts`
- [ ] No inline JSON line parsing outside `runs/shared/stdio-parser.ts`
- [ ] No `appendRecentOutput` / `appendRecentStepOutput` outside `runs/shared/output-buffer.ts`
- [ ] `executeAsyncSingle` no longer exists — single-agent path uses `executeAsyncChain` with one-step array
- [ ] Foreground runner still uses callback-based `onControlEvent` / `onUpdate` (no file I/O)
- [ ] Background runner still writes `status.json` / `events.jsonl` (no callback injection)
- [ ] ~300-600 LOC reduction across execution.ts + subagent-runner.ts
- [ ] Async event emission shape preserved: `SUBAGENT_ASYNC_STARTED_EVENT` payload identical for single vs chain

## Constraints

- Foreground I/O model (callback-based, in-process) must not change
- Background I/O model (file-based, detached process) must not change
- `AgentProgress` and `RunnerStatusStep` types stay separate — shared modules operate on primitive shapes, not these types directly
- Completion guard, model fallback, mutating-failure detection remain in their existing shared modules (already extracted)
- No new runtime dependencies
- New shared modules must be pure functions with no side effects (testable in unit tests)
- Preserve all error message formats, exit codes, and control event payloads

## Gotchas

- `subagent-runner.ts` `runPiStreaming()` accumulates raw non-JSON lines to `rawStdoutLines[]` and writes them to output file — foreground doesn't. The `stdio-parser` must accept an `onRaw` callback that background uses but foreground ignores.
- Drain timer logic differs subtly: foreground clears timers on child exit; background has additional SIGTERM grace period logic. The shared factory must return control objects, not own the full lifecycle.
- `sumUsage` exists only in foreground; background inlines accumulation. The shared `usage.ts` should provide both `sumUsage` (mutating accumulator) and `accumulateUsage` (non-mutating reducer).
- `executeAsyncSingle` emits `SUBAGENT_ASYNC_STARTED_EVENT` with `mode: "single"` while `executeAsyncChain` uses `mode: "chain"` — the merged path must preserve the `mode` field based on whether it was originally a single or chain invocation.
- No unit tests exist for `runPiStreaming()` or `runSingleAttempt()` directly — only integration tests. New shared modules should have unit tests.
- `async-execution.ts` uses jiti resolution (`resolveJitiCliPath`) — keep this in `async-execution.ts`, don't move to shared modules.

## Test-first: true

## Dependencies

- Wave 0 should land first (removes dead code from subagent-executor.ts, simplifying this task's starting state)
