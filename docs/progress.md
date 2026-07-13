# Progress: Unify FG/BG Execution

> **Historical snapshot:** this 2026-06 unification reconnaissance is retained for context. Its extraction plan is not active; consult `PLAN.md` and current source/tests for status.

## Phase 1: Reconnaissance (Complete)

**Output:** `.pi/tasks/unify-fg-bg-execution/recon/scout.md`

### Key Findings

**Already Shared (✅):**
- `completion-guard.ts` — completion mutation detection
- `long-running-guard.ts` — mutating tool detection, failure tracking, timeout triggers
- `model-fallback.ts` — candidate building, retryable error detection
- `subagent-control.ts` — control event building
- `pi-args.ts`, `pi-spawn.ts` — spawn configuration
- `single-output.ts` — output file handling
- `parallel-utils.ts` — chain step utilities

**Duplicated (⚠️):**
1. **`emptyUsage()`** — Identical in both runners (execution.ts:71, subagent-runner.ts:117)
2. **`sumUsage()`** — Foreground only, background uses inline accumulation
3. **Drain timer constants** — `FINAL_STOP_GRACE_MS=1000`, `HARD_KILL_MS=3000` duplicated
4. **Drain timer logic** — `finalDrainTimer`, `startFinalDrain()`, `clearFinalDrainTimers()` near-identical
5. **JSON line parsing** — `processLine()` vs `processStdoutLine()` with same structure
6. **Tool-event state tracking** — ~90 LOC duplicated for tool_execution_start/end, message_end
7. **`appendRecentOutput()`** — Slight variant (`appendRecentStepOutput()` in background)

**Hidden Coupling:**
- Stdio buffer handling (`buf += chunk`, split on `\n`)
- Activity state update (setInterval vs file mtime polling)
- Control event emission (callback vs JSONL)
- Interruption handling (AbortSignal vs SIGUSR2)
- Progress snapshot types (`AgentProgress` vs `RunnerStatusStep`)

### Test Coverage

**Foreground (`execution.ts`):**
- `test/integration/single-execution.test.ts` (~1098 LOC)
- `test/integration/parallel-execution.test.ts`
- `test/integration/error-handling.test.ts`
- `test/integration/foreground-result-size.test.ts`

**Background (`subagent-runner.ts`):**
- `test/integration/chain-execution.test.ts` (~772 LOC)
- `test/integration/async-execution.test.ts` (~1400+ LOC)
- `test/integration/async-job-tracker.test.ts`
- `test/integration/async-status.test.ts`

**Shared modules:**
- `test/unit/completion-guard.test.ts` (~108 LOC)
- `test/unit/model-fallback.test.ts` (~77 LOC)

### Extraction Priority

**High (already shared):** No action needed — these are the template for extraction.

**Medium (extract next):**
1. `src/runs/shared/exit-drain.ts` — drain timer constants + factory
2. `src/runs/shared/stdio-parser.ts` — JSON line processor factory
3. `src/runs/shared/usage.ts` — `emptyUsage()`, `sumUsage()`
4. `src/runs/shared/output-buffer.ts` — `appendRecentOutput()` variant

**Low (execution-model specific):** Activity timer loop, control emission, interruption handling, worktree setup.

## Next Phase: Extract Shared Primitives

1. Create `exit-drain.ts` with constants + `createExitDrainHandlers()` factory
2. Create `stdio-parser.ts` with `createLineProcessor()` factory
3. Create `usage.ts` with `emptyUsage()`, `sumUsage()`, `usageFromAttempts()`
4. Create `output-buffer.ts` with `createRecentOutputBuffer()`
5. Update both runners to import from shared modules
6. Verify all tests pass

## Risks

- Type divergence between `AgentProgress` and `RunnerStatusStep`
- Control event delivery semantics differ (sync callback vs JSONL)
- No unit tests for core streaming logic — only integration tests
