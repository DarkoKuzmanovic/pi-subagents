# Scout Recon: Unified Child-Runner Primitives

## Files Retrieved

### Core Execution Files
1. **`src/runs/foreground/execution.ts`** (lines 1-995, ~995 LOC)
   - Synchronous callback-based runner (`runSync`, `runSingleAttempt`)
   - Spawns `pi` CLI child process with stdio streaming
   - Handles model fallback loop, control events, completion guard

2. **`src/runs/background/subagent-runner.ts`** (lines 1-1892, ~1892 LOC)
   - Detached file-based runner for async/chain execution
   - `runSubagent()` orchestrates sequential/parallel steps
   - `runPiStreaming()` handles child process stdio (duplicates foreground logic)
   - `runSingleStep()` wraps individual agent runs within chains

3. **`src/runs/background/async-execution.ts`** (lines 1-621)
   - Entry point for async dispatch: `executeAsyncSingle()` + `executeAsyncChain()`
   - Resolves skills, models, builds step configs
   - Spawns detached `subagent-runner.ts` via jiti

### Shared Modules (Already Extracted)
4. **`src/runs/shared/completion-guard.ts`** (126 LOC)
   - `evaluateCompletionMutationGuard()` — detects no-edit completions
   - `expectsImplementationMutation()` — task intent analysis
   - `hasMutationToolCall()` — tool call inspection

5. **`src/runs/shared/long-running-guard.ts`** (206 LOC)
   - `isMutatingTool()`, `isMutatingBashCommand()` — mutation detection
   - `didMutatingToolFail()` — failure pattern matching
   - `createMutatingFailureState()`, `recordMutatingFailure()` — state tracking
   - `nextLongRunningTrigger()`, `nextStepTimeoutTrigger()` — control thresholds

6. **`src/runs/shared/model-fallback.ts`** (104 LOC)
   - `buildModelCandidates()` — deduplicated candidate list
   - `isRetryableModelFailure()` — error pattern matching
   - `formatModelAttemptNote()` — fallback logging
   - `resolveModelCandidate()` — provider resolution

7. **`src/runs/shared/subagent-control.ts`**
   - Control event building, activity state derivation
   - Notification claiming, intercom formatting

8. **`src/runs/shared/pi-args.ts`**, **`src/runs/shared/pi-spawn.ts`**
   - CLI argument building, spawn command resolution

9. **`src/runs/shared/single-output.ts`**
   - Output file handling, snapshot capture

10. **`src/runs/shared/parallel-utils.ts`**
    - Chain step flattening, parallel execution utilities

## Key Code: Duplicated Patterns

### 1. `emptyUsage()` — Identical in Both Runners

**Foreground** (`execution.ts:71-73`):
```typescript
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
```

**Background** (`subagent-runner.ts:117-119`):
```typescript
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
```

### 2. `sumUsage()` — Only in Foreground

**Foreground** (`execution.ts:75-82`):
```typescript
function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}
```

**Background**: Uses inline accumulation instead (`usage.input += eventUsage.input ?? ...`).

### 3. Drain Timer Constants — Identical in Both

**Foreground** (`execution.ts:245-246`):
```typescript
const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;
```

**Background** (`subagent-runner.ts:321-322`):
```typescript
const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;
```

Both have identical drain timer logic with `finalDrainTimer`, `finalHardKillTimer`, `clearFinalDrainTimers()`, `startFinalDrain()`.

### 4. JSON Stdout Line Parsing — Nearly Identical

**Foreground** (`execution.ts:483-492`):
```typescript
const processLine = (line: string) => {
	if (!line.trim()) return;
	jsonlWriter.writeLine(line);
	let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
	try {
		evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
	} catch {
		return; // Non-JSON stdout lines are expected
	}
	// ...
};
```

**Background** (`subagent-runner.ts:257-267`):
```typescript
const processStdoutLine = (line: string) => {
	if (!line.trim()) return;
	let event: ChildEvent;
	try {
		event = JSON.parse(line) as ChildEvent;
	} catch {
		rawStdoutLines.push(line);
		writeOutputLine(line);
		appendChildLine("subagent.child.stdout", line);
		return;
	}
	// ...
};
```

### 5. Tool-Event State Tracking — Duplicated Logic

Both runners track:
- `tool_execution_start` → set `currentTool`, `currentToolArgs`, `currentToolStartedAt`, `currentPath`
- `tool_execution_end` → clear tool state, push to `recentTools`
- `message_end` / `tool_result_end` → accumulate usage, append output

**Foreground** (`execution.ts:499-589`): ~90 lines of event handling
**Background** (`subagent-runner.ts:272-303`, `1063-1143`): Split between `runPiStreaming()` and `updateStepFromChildEvent()`

### 6. `appendRecentOutput()` — Slight Variant

**Foreground** (`execution.ts:84-90`):
```typescript
function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}
```

**Background** (`subagent-runner.ts:133-141`):
```typescript
function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
	const nonEmpty = lines.filter((line) => line.trim());
	if (nonEmpty.length === 0) return;
	step.recentOutput ??= [];
	step.recentOutput.push(...nonEmpty);
	if (step.recentOutput.length > 50) {
		step.recentOutput.splice(0, step.recentOutput.length - 50);
	}
}
```

### 7. Mutating-Failure Detection — Already Shared

Both import from `src/runs/shared/long-running-guard.ts`:
- `isMutatingTool()` — lines 103-110
- `didMutatingToolFail()` — lines 112-115
- `createMutatingFailureState()` — lines 165-171
- `recordMutatingFailure()` — lines 173-189
- `resetMutatingFailureState()` — lines 191-200

**Usage in Foreground** (`execution.ts:314`, `511`, `568-584`):
```typescript
const mutatingFailures = createMutatingFailureState();
const mutates = isMutatingTool(evt.toolName, toolArgs);
if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
	recordMutatingFailure(mutatingFailures, {...}, mutatingFailureWindowMs);
}
```

**Usage in Background** (`subagent-runner.ts:954`, `1069`, `1094-1124`):
```typescript
const mutatingFailureStates = flatSteps.map(() => createMutatingFailureState());
const mutates = isMutatingTool(event.toolName, event.args);
if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
	recordMutatingFailure(state, {...}, mutatingFailureWindowMs);
}
```

### 8. Completion Guard — Already Shared

Both import from `src/runs/shared/completion-guard.ts`:
- `evaluateCompletionMutationGuard()` — line 117

**Usage in Foreground** (`execution.ts:744-762`):
```typescript
const completionGuard = result.exitCode === 0 && !result.error
	? evaluateCompletionMutationGuard({ agent: agent.name, task, messages: result.messages })
	: undefined;
if (completionGuard?.triggered && !observedMutationAttempt) {
	result.exitCode = 1;
	result.error = "Subagent completed without making edits...";
}
```

**Usage in Background** (`subagent-runner.ts:643-679`):
```typescript
const completionGuard = run.exitCode === 0 && !run.error && !hiddenError?.hasError
	? evaluateCompletionMutationGuard({...})
	: undefined;
const completionGuardTriggered = completionGuard?.triggered === true && !run.observedMutationAttempt;
if (attempt.success || completionGuardTriggered) break;
```

### 9. Model Fallback — Already Shared

Both import from `src/runs/shared/model-fallback.ts`:
- `buildModelCandidates()` — line 42
- `isRetryableModelFailure()` — line 93
- `formatModelAttemptNote()` — line 98

**Usage in Foreground** (`execution.ts:856-918`):
```typescript
const candidates = buildModelCandidates(...);
for (let i = 0; i < modelsToTry.length; i++) {
	// ... run attempt ...
	if (attemptSucceeded) break;
	if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) break;
	attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
}
```

**Usage in Background** (`subagent-runner.ts:603-682`):
```typescript
for (let index = 0; index < candidates.length; index++) {
	// ... run attempt ...
	if (attempt.success || completionGuardTriggered) break;
	if (!isRetryableModelFailure(error) || index === candidates.length - 1) break;
	attemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
}
```

## Architecture

### Current State

```
┌─────────────────────────────────────────────────────────────────┐
│                     execution.ts (foreground)                   │
│  runSync() → runSingleAttempt() → spawn pi CLI                  │
│  - Direct stdio streaming                                       │
│  - Callback-based progress updates                              │
│  - Control event emission                                       │
│  - Model fallback loop                                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              subagent-runner.ts (background)                    │
│  runSubagent() → runSingleStep() → runPiStreaming() → spawn pi  │
│  - Detached process (stdio: ignore)                             │
│  - File-based status.json + events.jsonl                        │
│  - Parallel step orchestration                                  │
│  - Worktree setup for parallel isolation                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              async-execution.ts (dispatch layer)                │
│  executeAsyncSingle() / executeAsyncChain()                     │
│  - Skill/model resolution                                       │
│  - Step config building                                         │
│  - Spawns subagent-runner.ts via jiti                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    shared/ (already extracted)                  │
│  - completion-guard.ts                                          │
│  - long-running-guard.ts                                        │
│  - model-fallback.ts                                            │
│  - subagent-control.ts                                          │
│  - pi-args.ts, pi-spawn.ts                                      │
│  - single-output.ts                                             │
│  - parallel-utils.ts                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Hidden Coupling Between Execution Models

1. **Drain timer constants** (`FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`) are hardcoded in both runners. Changing one requires changing the other.

2. **Stdio buffer handling** is duplicated:
   - Both accumulate `buf += chunk.toString()`
   - Both split on `\n` and process line-by-line
   - Both handle trailing buffer on close

3. **Activity state update loop** logic differs:
   - Foreground: `setInterval()` at 1000ms with `updateActivityState()`
   - Background: Per-event updates + file mtime polling via `stepOutputActivityAt()`

4. **Control event emission** has divergent paths:
   - Foreground: Direct `options.onControlEvent()` callback
   - Background: JSONL append to `events.jsonl` + intercom bridge

5. **Progress snapshot types** differ:
   - Foreground: `AgentProgress` + `snapshotProgress()`
   - Background: `RunnerStatusStep` + inline updates

6. **Interruption handling**:
   - Foreground: `options.interruptSignal` AbortSignal
   - Background: `ASYNC_INTERRUPT_SIGNAL` (SIGUSR2/SIGBREAK) + `activeChildInterrupts` Map

## Test Infrastructure

### Test Runner Commands
```bash
npm test                    # unit tests only (experimental-strip-types)
npm run test:integration    # integration tests (experimental-transform-types)
npm run test:all            # both
```

### Test Files Covering Each Runner

#### Foreground (`execution.ts`)
- **`test/integration/single-execution.test.ts`** — Full `runSync()` pipeline with mock pi
  - Tests model fallback, control events, completion guard, artifacts
  - ~1098 LOC, comprehensive coverage

- **`test/integration/parallel-execution.test.ts`** — Parallel step execution
  - Uses `execution.ts` for concurrent agent runs

- **`test/integration/error-handling.test.ts`** — Error path coverage
  - Imports `execution.ts` for error handling tests

- **`test/integration/foreground-result-size.test.ts`** — Output truncation

#### Background (`subagent-runner.ts`)
- **`test/integration/chain-execution.test.ts`** — Sequential/parallel chain execution
  - Tests `runSingleStep()`, step orchestration, `{previous}` passing
  - ~772 LOC

- **`test/integration/async-execution.test.ts`** — Async single/chain dispatch
  - Tests `executeAsyncSingle()`, `executeAsyncChain()`
  - ~1400+ LOC, covers model fallback, worktree setup, control events

- **`test/integration/async-job-tracker.test.ts`** — Job tracking, status polling

- **`test/integration/async-status.test.ts`** — Status file format, activity state

- **`test/integration/fork-context-execution.test.ts`** — Forked context execution

#### Shared Modules
- **`test/unit/completion-guard.test.ts`** — `evaluateCompletionMutationGuard()` tests
  - ~108 LOC, covers all pattern matching cases

- **`test/unit/model-fallback.test.ts`** — `buildModelCandidates()`, `isRetryableModelFailure()`
  - ~77 LOC, provider resolution, retryable error detection

- **`test/unit/subagent-control.test.ts`** — Control event building, activity state

- **`test/unit/long-running-guard.test.ts`** — Mutating tool detection (if exists)

- **`test/unit/parallel-utils.test.ts`** — Step flattening, aggregation

### Test Support Files
- **`test/support/helpers.ts`** — `createMockPi()`, `makeAgentConfigs()`, event builders
- **`test/support/mock-pi.ts`** — Mock ExtensionAPI/ExtensionContext
- **`test/support/mock-pi-script.mjs`** — Mock pi child process for integration tests
- **`test/support/register-loader.mjs`** — `.js` → `.ts` import rewriter
- **`test/support/ts-loader.mjs`** — TypeScript transform loader

### Known Quirks
1. **Unit tests** use `--experimental-strip-types` — no parameter properties in test source
2. **Integration tests** use `--experimental-transform-types` — supports parameter properties
3. **Custom loader** rewrites `.js` imports to `.ts` at resolve time
4. **Pi packages** must be importable — tests skip gracefully if unavailable

## Start Here

**First file to open:** `src/runs/shared/long-running-guard.ts`

**Why:** This module already contains the most complex shared primitives (`isMutatingTool`, `didMutatingToolFail`, `createMutatingFailureState`, `recordMutatingFailure`, timeout triggers). It's the best template for what a unified child-runner primitives module should look like:
- Pure functions, no side effects
- Type-safe interfaces
- Already used by both runners without modification
- Well-tested patterns

**Next:** `src/runs/shared/completion-guard.ts` — similar pattern, simpler scope.

**Then:** Read both `runPiStreaming()` (background, lines 194-416) and `runSingleAttempt()` (foreground, lines 123-793) side-by-side to identify the exact stdio streaming logic that needs extraction.

## Extraction Candidates

### High Confidence (Already Shared)
- ✅ `completion-guard.ts` — Used identically by both
- ✅ `long-running-guard.ts` — Mutation detection, failure tracking
- ✅ `model-fallback.ts` — Candidate building, retryable detection
- ✅ `subagent-control.ts` — Control event building
- ✅ `pi-args.ts`, `pi-spawn.ts` — Spawn configuration

### Medium Confidence (Needs Extraction)
- ⚠️ **Drain timer constants/factories** — Identical constants, near-identical logic
  - Extract to `src/runs/shared/exit-drain.ts`
  - `FINAL_STOP_GRACE_MS`, `HARD_KILL_MS`
  - `createExitDrainHandlers()` factory

- ⚠️ **JSON line parsing** — Same pattern, different event types
  - Extract to `src/runs/shared/stdio-parser.ts`
  - `createLineProcessor()` with configurable event handler

- ⚠️ **Usage accumulation** — `emptyUsage()`, `sumUsage()` (foreground only)
  - Extract to `src/runs/shared/usage.ts`
  - `emptyUsage()`, `sumUsage()`, `usageFromAttempts()`

- ⚠️ **Output accumulation** — `appendRecentOutput()` / `appendRecentStepOutput()`
  - Extract to `src/runs/shared/output-buffer.ts`
  - `createRecentOutputBuffer(maxLines: number)`

### Low Confidence (Execution-Model Specific)
- ❌ **Activity state timer loop** — Foreground uses `setInterval`, background uses file polling
- ❌ **Control event emission** — Foreground callbacks vs background JSONL
- ❌ **Interruption handling** — AbortSignal vs SIGUSR2
- ❌ **Worktree setup** — Background-only parallel isolation
- ❌ **Progress file writing** — Background-only status.json updates

## Risks and Open Questions

1. **Type divergence:** `AgentProgress` (foreground) vs `RunnerStatusStep` (background) — need unified interface or adapter layer.

2. **Control event delivery:** Foreground emits synchronously via callback; background appends to JSONL for later delivery. Extraction must preserve both semantics.

3. **Timer ownership:** Foreground owns activity timer in `runSingleAttempt()`; background tracks via file mtime polling. May need separate extraction for "activity tracking" vs "timeout detection".

4. **Test coverage gap:** No unit tests for `runPiStreaming()` or `runSingleAttempt()` directly — only integration tests via full execution pipeline. Extraction should include unit-testable pure functions.

5. **Async-runner bootstrap:** `async-execution.ts` has jiti resolution logic (`resolveJitiCliPath`) that's unrelated to child execution but critical for async dispatch. Keep separate.

6. **Completion guard placement:** Currently in `shared/`, but both runners wrap it with `observedMutationAttempt` tracking. Consider extracting the wrapper logic too.

7. **Model fallback loop structure:** Foreground uses `for` loop with `sumUsage()`; background inlines accumulation. Extraction should provide both patterns or a unified iterator.
