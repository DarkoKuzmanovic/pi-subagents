# Oracle: Post-Implementation Review — Wave 1+2

**Date:** 2026-05-26  
**Status:** All changes verified against actual source. No blocking issues. Two dead-export issues worth cleaning up. No behavioral regressions.

---

## Test baseline
- 525 pass, 4 fail (4 pre-existing infra failures, unchanged from before Wave 1+2)
- `ChildEvent` type error at `subagent-runner.ts:246` is **pre-existing** (was at line 269 before refactoring, confirmed via `git stash`)

---

## ✅ VERIFIED CORRECT

### executeAsyncSingle thin wrapper (Step 8)
- All 16 fields of `AsyncSingleParams` map correctly to `executeAsyncChain` params — full field mapping audit passed.
- Output pre-normalization is idempotent: callers already call `normalizeSingleOutputOverride` before passing `output`; the wrapper normalizes again but produces the same result.
- `output: false` correctly suppresses chain's fallback to `agentConfig.output` via `resolveStepBehavior`.
- `resultMode: "single"` emitted in `SUBAGENT_ASYNC_STARTED_EVENT.mode` — matches original single-path behavior.
- `reads: false`, `progress: false` — correctly prevents chain from injecting read/progress instructions that the original single path did not add.
- `chainSkills: []` — correct; original single path had no chain-level skills.
- `sessionFilesByFlatIndex: params.sessionFile ? [params.sessionFile] : []` — correct single-index wrapping.

### Output path resolution
- `step.cwd` is not set → `resolveChildCwd(runnerCwd, undefined) = runnerCwd` → `instructionCwd = runnerCwd` → `resolveSingleOutputPath(behavior.output, ctx.cwd, runnerCwd)` — exact same resolution as the old single path. ✓

### Shared modules (usage.ts, exit-drain.ts, output-buffer.ts, stdio-parser.ts)
- `sumUsage` is correctly used in `execution.ts:889` after multi-attempt loops.
- `emptyUsage()` initializes all 6 Usage fields to 0 — safe for subsequent `+=` accumulation.
- `createRecentOutputBuffer`: blank-line filtering is consistent with original behavior; `snapshot()` returns `[...buffer]` (shallow copy). Aliasing protection verified.
- `createLineProcessor`: `onJson`/`onRaw` dispatch matches original inline behavior. Background runner passes `onRaw` callback; foreground leaves it `undefined` (silently drops non-JSON).
- JSONL write order correct: execution.ts calls `jsonlWriter.writeLine(line)` BEFORE `lineProcessor.processLine(line)`. Pre-parse write preserved.

### Type safety
- `SequentialStep.output?: string | false` ← `(string | false | undefined) ?? false` = `string | false`. Type-safe. ✓
- `SequentialStep.progress?: boolean` ← `false`. ✓
- `SequentialStep.reads?: string[] | false` ← `false`. ✓
- `SequentialStep.skill?: string | string[] | false` ← `string[] | undefined`. ✓

---

## 🔴 BLOCKING

None.

---

## 🟠 HIGH

None.

---

## 🟡 MEDIUM

### M1 — Dead factory exports in exit-drain.ts
**File:** `src/runs/shared/exit-drain.ts`  
**Lines:** 11–43 (`createDrainTimers`, `clearDrainTimers`, `startFinalDrain`)

Neither `execution.ts` nor `subagent-runner.ts` imports or calls these functions. Both consumers define equivalent local timer-management code inlined in their closures. The factory functions exist only in tests.

**Impact:** 33 lines of exported surface that have no production consumers. Future readers may think the factories are the canonical approach when they are not.

**Fix options:**
- **Option A (preferred):** Remove `createDrainTimers`, `clearDrainTimers`, `startFinalDrain` from `exit-drain.ts`. Keep only `FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`, `DrainTimers` interface. Remove their tests.
- **Option B (defer):** Add a `// For future use` comment so intent is explicit.

---

### M2 — Dead `processTrailingBuffer` interface method
**File:** `src/runs/shared/stdio-parser.ts:5,29-33`

`processTrailingBuffer` is declared in `LineProcessor` and implemented in `createLineProcessor`, but never called in production code. Both consumers handle trailing buffers by calling their local `processLine(buf)` wrapper directly:
- `execution.ts:622`: `if (buf.trim()) processLine(buf);`
- `subagent-runner.ts:372`: `if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);`

**Impact:** Dead interface method tested in isolation but not wired into any real path.

**Fix:** Remove `processTrailingBuffer` from the `LineProcessor` interface and implementation. Delete its tests in `stdio-parser.test.ts`. Consumers already handle the trailing-buffer case correctly.

---

## 🔵 LOW

### L1 — `appendRecentStepOutput` creates a new buffer per call
**File:** `src/runs/background/subagent-runner.ts:121-127`

```typescript
function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
    step.recentOutput ??= [];
    const buf = createRecentOutputBuffer(50);
    buf.append(step.recentOutput);  // pre-seed from existing
    buf.append(lines);               // add new lines
    step.recentOutput = buf.snapshot();
}
```

Creates a new `RecentOutputBuffer` on every call, pre-seeds it with existing output (copying array twice), then snapshots. This is functionally correct but allocates a new closure-captured array on every event.

**Alternative:**
```typescript
function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
    const combined = [...(step.recentOutput ?? []), ...lines.filter(l => l.trim())];
    step.recentOutput = combined.length > 50 ? combined.slice(-50) : combined;
}
```

**Risk:** Low. Not a hot path; the per-call allocation is negligible.

---

### L2 — Redundant blank-line guard before `lineProcessor.processLine`
**Files:**  
- `src/runs/foreground/execution.ts:577`: `if (!line.trim()) return;`  
- `src/runs/background/subagent-runner.ts:289`: `if (!line.trim()) return;`

Both outer wrappers (`processLine`, `processStdoutLine`) guard against empty lines before calling `lineProcessor.processLine()`, which has the same guard internally (`stdio-parser.ts:21`). The outer guard is redundant.

**Fix:** Remove the outer `if (!line.trim()) return;` guards. The shared parser already handles them.

**Risk:** None. Both guards do identical checks.

---

### L3 — Weak timer callback test
**File:** `test/unit/exit-drain.test.ts:80-93`

Test named "timers fire callbacks" does not verify callbacks fire. It arms the timers, immediately clears them with `clearDrainTimers`, and calls `done()` synchronously. The callbacks will never be called.

**Fix:** Either rename to "arms both timer handles" (matching what's actually tested), or rewrite to use short-delay timeouts (say 10ms) and verify callback execution asynchronously via `done`. If M1 above is applied and factory functions are removed, this test disappears anyway.

---

### L4 — `outputMode: outputMode ?? "inline"` is redundant in wrapper
**File:** `src/runs/background/async-execution.ts:507`

The wrapper always sets `step.outputMode = outputMode ?? "inline"`. But `resolveStepBehavior` (settings.ts:219) already defaults `stepOverrides.outputMode ?? "inline"` — so even if `step.outputMode = undefined`, the behavior would be "inline". The `?? "inline"` in the wrapper pre-computes what the resolver would do.

**Note:** All callers in `subagent-executor.ts` already default to `"inline"` before calling the wrapper. The revive caller (line 478) does not pass `outputMode`, so `params.outputMode = undefined` → wrapper sets `"inline"` → no functional difference.

**Fix:** Not required. Change `outputMode: outputMode ?? "inline"` to `outputMode` (let `undefined` fall through to resolver default) for cleaner intent expression. Low priority.

---

## Summary table

| Severity | Count | Items |
|----------|-------|-------|
| BLOCKING | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 2 | M1 dead factory exports, M2 dead interface method |
| LOW | 4 | L1 buffer allocation, L2 redundant guard, L3 weak test, L4 redundant default |

**Overall verdict:** Implementation is functionally correct. The two MEDIUM items are cleanup candidates but do not affect correctness or test coverage of the actual production paths. The 525 passing tests adequately cover the shared modules.

Recommended follow-up: Apply M1 + M2 in a single small commit (dead export removal, ~33 LOC removed from production, corresponding test deletion). The LOW items are optional polish.
