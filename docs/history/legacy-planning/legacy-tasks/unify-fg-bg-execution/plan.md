# Implementation Plan: Unify Foreground/Background Execution

**Oracle-reviewed with fixes applied.** See oracle-review.md for original findings.

## Goal
Extract shared child-runner primitives from duplicated foreground/background execution logic, collapse both runners onto the shared module, then convert `executeAsyncSingle` into a thin wrapper delegating to `executeAsyncChain`.

## Steps

### Step 1: Create `src/runs/shared/usage.ts`
**New file.** Extract usage accumulation primitives.

```typescript
import type { Usage } from "../../shared/types.js";

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Mutating accumulator — adds source fields into target */
export function sumUsage(target: Usage, source: Usage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.turns += source.turns;
}

```

**Note:** `accumulateUsage` was considered but dropped per oracle review — neither foreground nor background can use it. Foreground uses `||` coercion with different field names; background has `inputTokens` fallback and nested `cost.total`. Only `emptyUsage` and `sumUsage` are genuinely shared.

### Step 2: Create `src/runs/shared/exit-drain.ts`
**New file.** Extract drain timer constants and factory.

```typescript
export const FINAL_STOP_GRACE_MS = 1000;
export const HARD_KILL_MS = 3000;

export interface DrainTimers {
  finalDrainTimer: ReturnType<typeof setTimeout> | null;
  finalHardKillTimer: ReturnType<typeof setTimeout> | null;
}

export function createDrainTimers(): DrainTimers {
  return { finalDrainTimer: null, finalHardKillTimer: null };
}

export function clearDrainTimers(timers: DrainTimers): void {
  if (timers.finalDrainTimer) { clearTimeout(timers.finalDrainTimer); timers.finalDrainTimer = null; }
  if (timers.finalHardKillTimer) { clearTimeout(timers.finalHardKillTimer); timers.finalHardKillTimer = null; }
}

export function startFinalDrain(
  timers: DrainTimers,
  onGrace: () => void,
  onHardKill: () => void,
): void {
  timers.finalDrainTimer = setTimeout(onGrace, FINAL_STOP_GRACE_MS);
  timers.finalHardKillTimer = setTimeout(onHardKill, HARD_KILL_MS);
}
```

### Step 3: Create `src/runs/shared/output-buffer.ts`
**New file.** Extract recent-output ring buffer.

```typescript
export interface RecentOutputBuffer {
  append(lines: string[]): void;
  snapshot(): string[];
}

export function createRecentOutputBuffer(maxLines: number = 50): RecentOutputBuffer {
  let buffer: string[] = [];
  return {
    append(lines: string[]): void {
      const nonEmpty = lines.filter(l => l.trim());
      if (nonEmpty.length === 0) return;
      buffer.push(...nonEmpty);
      if (buffer.length > maxLines) {
        buffer.splice(0, buffer.length - maxLines);
      }
    },
    snapshot(): string[] {
      return [...buffer];  // Shallow copy — prevents aliasing if consumer mutates the result
    },
  };
}
```

### Step 4: Create `src/runs/shared/stdio-parser.ts`
**New file.** Extract JSON stdout line parsing.

```typescript
export interface LineProcessor {
  processLine(line: string): void;
  processTrailingBuffer(remaining: string): void;
}

export interface LineProcessorCallbacks {
  onJson: (parsed: Record<string, unknown>) => void;
  onRaw?: (line: string) => void;  // Optional — foreground ignores non-JSON, background writes to file
}

export function createLineProcessor(callbacks: LineProcessorCallbacks): LineProcessor {
  return {
    processLine(line: string): void {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        callbacks.onJson(parsed);
      } catch {
        callbacks.onRaw?.(line);
      }
    },
    processTrailingBuffer(remaining: string): void {
      if (remaining.trim()) {
        this.processLine(remaining);
      }
    },
  };
}
```

### Step 5: Write unit tests for all 4 new modules
**New files:**
- `test/unit/usage.test.ts` — test `emptyUsage()`, `sumUsage()` with edge cases (zero usage, partial fields, accumulation overflow)
- `test/unit/exit-drain.test.ts` — test `createDrainTimers`, `clearDrainTimers`, `startFinalDrain` with fake timers
- `test/unit/output-buffer.test.ts` — test `createRecentOutputBuffer` with append, max-lines cap, empty-line filtering
- `test/unit/stdio-parser.test.ts` — test `createLineProcessor` with JSON lines, non-JSON lines, trailing buffer

Use `node:test` + `node:assert/strict`. No parameter properties (unit tests use `--experimental-strip-types`).

### Step 6: Refactor `src/runs/foreground/execution.ts` to consume shared modules
**Modify.** Replace inline implementations with imports from shared modules.

- Remove local `emptyUsage()` (L71-73) → import from `runs/shared/usage.ts`
- Remove local `sumUsage()` (L75-82) → import from `runs/shared/usage.ts`
- Remove local `appendRecentOutput()` (L84-90) → use `createRecentOutputBuffer` from `runs/shared/output-buffer.ts`
- Remove local `FINAL_STOP_GRACE_MS` / `HARD_KILL_MS` (L245-246) → import from `runs/shared/exit-drain.ts`
- Replace drain timer logic with `createDrainTimers` / `startFinalDrain` / `clearDrainTimers` from `runs/shared/exit-drain.ts`
- Replace inline JSON line parsing with `createLineProcessor` from `runs/shared/stdio-parser.ts`
  - `onJson`: dispatch to existing event handling logic
  - `onRaw`: undefined (foreground ignores non-JSON lines)
- **CRITICAL:** Call `jsonlWriter.writeLine(line)` BEFORE `lineProcessor.processLine(line)`. The stdio-parser dispatches post-parse only; the pre-parse JSONL write stays in the consumer.

**Key invariant:** Foreground's `AgentProgress` type stays separate. The buffer adapter calls `progress.recentOutput = buffer.snapshot()` where needed.

### Step 7: Refactor `src/runs/background/subagent-runner.ts` to consume shared modules
**Modify.** Replace inline implementations with imports from shared modules.

- Remove local `emptyUsage()` (L117-119) → import from `runs/shared/usage.ts`
- Remove local `appendRecentStepOutput()` (L133-141) → use `createRecentOutputBuffer` from `runs/shared/output-buffer.ts`
  - Adapter: wrap `step.recentOutput` to sync with buffer: `step.recentOutput = buffer.snapshot()`
- Remove local `FINAL_STOP_GRACE_MS` / `HARD_KILL_MS` (L321-322) → import from `runs/shared/exit-drain.ts`
- Replace drain timer logic with `createDrainTimers` / `startFinalDrain` / `clearDrainTimers` from `runs/shared/exit-drain.ts`
- Replace inline JSON line parsing in `runPiStreaming()` (L257-267) with `createLineProcessor` from `runs/shared/stdio-parser.ts`
  - `onJson`: dispatch to existing `ChildEvent` handling
  - `onRaw`: push to `rawStdoutLines[]`, call `writeOutputLine(line)`, call `appendChildLine("subagent.child.stdout", line)`

**Key invariant:** Background's `RunnerStatusStep` type stays separate. Buffer adapter uses `step.recentOutput ??= []` for lazy init, then syncs from buffer.

### Step 8: Convert `executeAsyncSingle` into a thin wrapper delegating to `executeAsyncChain`
**Modify:** `src/runs/background/async-execution.ts`

Per oracle review (see step8-recommendation.md for full divergence trace), the output-resolution paths converge when the wrapper pre-normalizes output and sets explicit overrides. Key insight: `undefined` → `false` (suppresses chain's fallback to `agentConfig.output`), and `reads: false, progress: false` suppress chain instruction injection.

- Delete the duplicate spawn/event/runner code from the old `executeAsyncSingle` body (L496-620, ~125 lines)
- Replace with thin wrapper (~35 lines):
- Widen `AsyncChainParams.resultMode` from `Exclude<SubagentRunMode, "single">` to `SubagentRunMode` (L110)
- Zero changes to any callers (20 test calls + 3 production calls)

**Concrete thin wrapper:**
```typescript
export function executeAsyncSingle(
    id: string,
    params: AsyncSingleParams,
): AsyncExecutionResult {
    const { agent, agentConfig, skills, output, outputMode, modelOverride } = params;
    
    // Pre-normalize output — chain path uses resolveStepBehavior which has different
    // default-fallback logic. Explicit false suppresses chain's fallback to agentConfig.output.
    const normalizedOutput = normalizeSingleOutputOverride(output, agentConfig.output);
    
    const step: SequentialStep = {
        agent,
        task: params.task,
        output: normalizedOutput ?? false,   // undefined → false (suppress chain default)
        outputMode: outputMode ?? "inline",
        reads: false,                        // single path has no read instructions
        progress: false,                     // single path has no progress instructions
        skill: skills,
        model: modelOverride,
    };
    
    return executeAsyncChain(id, {
        chain: [step],
        task: params.task,
        resultMode: "single",
        agents: [agentConfig],
        ctx: params.ctx,
        cwd: params.cwd,
        maxOutput: params.maxOutput,
        artifactsDir: params.artifactsDir,
        artifactConfig: params.artifactConfig,
        shareEnabled: params.shareEnabled,
        sessionRoot: params.sessionRoot,
        chainSkills: [],
        sessionFilesByFlatIndex: params.sessionFile ? [params.sessionFile] : [],
        maxSubagentDepth: params.maxSubagentDepth,
        worktreeSetupHook: params.worktreeSetupHook,
        worktreeSetupHookTimeoutMs: params.worktreeSetupHookTimeoutMs,
        controlConfig: params.controlConfig,
        controlIntercomTarget: params.controlIntercomTarget,
        childIntercomTarget: params.childIntercomTarget,
        availableModels: params.availableModels,
    });
}
```

**Note:** Exact field list needs verification against actual `AsyncSingleParams`/`AsyncChainParams` at implementation time. The oracle traced all 4 output states and confirmed convergence. See `step8-recommendation.md` for the full divergence analysis.

### Step 9: Verify
```bash
npm test              # Must pass with 490 pass, 4 fail (pre-existing)
npm run test:all      # Integration tests must pass (same 4 pre-existing failures)
grep -r "emptyUsage" src/ | grep -v "shared/usage.ts" | grep -v "test/"     # Zero hits
grep -r "FINAL_STOP_GRACE_MS" src/ | grep -v "shared/exit-drain.ts" | grep -v "test/"  # Zero hits
grep -r "appendRecentOutput\|appendRecentStepOutput" src/ | grep -v "shared/output-buffer.ts" | grep -v "test/"  # Zero hits
grep -c "executeAsyncSingle" src/runs/background/async-execution.ts  # Should be ~2 (export + function signature only — body collapsed)
```

## Dependencies
- Steps 1-4 (new modules) → no dependencies, can be parallel
- Step 5 (tests) → depends on Steps 1-4
- Step 6 (foreground refactor) → depends on Steps 1-4
- Step 7 (background refactor) → depends on Steps 1-4
- Step 8 (async merge) → depends on Steps 6+7 (runners must be stable)
- Step 9 (verify) → depends on all

## Risks

1. **Drain timer subtlety:** Background has additional SIGTERM grace period that foreground doesn't. The shared factory returns control objects (timers + clear/start functions) — consumers own the lifecycle. If the factory tries to own the lifecycle, it will break one of the two models.

2. **Buffer adapter consistency:** Foreground pushes to `progress.recentOutput` directly; background uses `step.recentOutput ??= []` for lazy init. The adapter pattern must preserve both semantics — `createRecentOutputBuffer` returns a neutral buffer, each consumer syncs it to its own state type.

3. **JSON line parsing divergence:** Background accumulates raw non-JSON lines to `rawStdoutLines[]` + writes to output file. Foreground silently drops them. The `onRaw` callback handles this: background passes its 3-action callback, foreground passes `undefined`.

4. **Async event emission shape:** `SUBAGENT_ASYNC_STARTED_EVENT` payload uses `mode: "single"` vs `mode: "chain"`. The handler (`async-job-tracker.ts` L201-212) already defensively handles both shapes with additive fields. The thin wrapper passes `resultMode: "single"` which propagates correctly. No listener breakage risk.

5. **No direct unit tests for runners:** Only integration tests cover `runPiStreaming()` and `runSingleAttempt()`. The refactoring should be done incrementally with `npm run test:all` verification after each consumer refactor, not just unit tests.

6. **Type isolation:** `AgentProgress` (foreground) and `RunnerStatusStep` (background) must stay separate types. Shared modules operate on primitive shapes (`Usage`, `string[]`, timer handles), not these domain types directly. Adapters in each consumer bridge the gap.

## Rollback
- Each step is a commit boundary
- Revert order: Step 8 → Step 7 → Step 6 → Steps 1-4
- `git restore .` from project root restores everything
- New shared modules can be deleted without affecting anything if consumers haven't been refactored yet
