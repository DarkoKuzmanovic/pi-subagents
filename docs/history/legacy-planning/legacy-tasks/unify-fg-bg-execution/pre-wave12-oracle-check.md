# Pre-Wave 1+2 Oracle Check

**Date:** 2026-05-26  
**Checked after:** Wave 0 commit (490 tests passing, 4 pre-existing failures)

---

## 1. Line Reference Verification

All plan line references checked against actual codebase. **Wave 0 changes did NOT shift any lines in the files Wave 1+2 will touch.**

### execution.ts (995 lines total)
| Plan reference | Actual | Status |
|---|---|---|
| `emptyUsage()` L71-73 | L71:c87 – L73:b18 | ✅ exact |
| `sumUsage()` L75-82 | L75:24f – L82:b18 | ✅ exact |
| `appendRecentOutput()` L84-90 | L84:28d – L90:b18 | ✅ exact |
| `FINAL_STOP_GRACE_MS` L245 | L245:065 | ✅ exact |
| `HARD_KILL_MS` L246 | L246:46c | ✅ exact |
| `processLine` (JSON parsing) | L483:f8f – L491:d32 | ✅ (not referenced by line in plan, verified by grep) |

### subagent-runner.ts (1892 lines total)
| Plan reference | Actual | Status |
|---|---|---|
| `emptyUsage()` L117-119 | L117:c87 – L119:b18 | ✅ exact |
| `appendRecentStepOutput()` L133-141 | L133:f0d – L141:b18 | ✅ exact |
| `FINAL_STOP_GRACE_MS` L321 | L321:065 | ✅ exact |
| `HARD_KILL_MS` L322 | L322:46c | ✅ exact |
| `processStdoutLine` (JSON parsing) L257-267 | L257:65d – L266:d32 | ✅ (ends at 266, plan said 267 — off by 1, non-blocking) |

### async-execution.ts (621 lines total)
| Plan reference | Actual | Status |
|---|---|---|
| `AsyncChainParams` L107 | L107:c78 – L128:b18 | ✅ exact |
| `AsyncSingleParams` L130 | L130:3e0 – L153:b18 | ✅ exact |
| `executeAsyncChain` L232 | L232:e68 – L487:b18 | ✅ exact |
| `executeAsyncSingle` L492 | L492:98c – L620:b18 | ✅ exact |

**Verdict: No stale anchors. All plan references are correct.**

---

## 2. Failing Integration Tests — Blocking?

4 failures in 3 files, all pre-existing:

| Test file | Failure | Related to Wave 1+2? |
|---|---|---|
| `test/unit/index-child-registration.test.ts` (×2) | Spawn error — `--experimental-transform-types` subprocess fails | ❌ No — tests extension index.ts, not execution/runner |
| `test/unit/package-manifest.test.ts` (×1) | `@earendil-works` runtime import validation | ❌ No — checks package.json deps |
| `test/unit/path-resolution.test.ts` (×1) | ENOENT `/home/quzma/.agents/skills` | ❌ No — tests skill path resolution |

**Verdict: Not blocking. These failures are in unrelated test files and will remain at 4 failures before and after Wave 1+2.**

However: the plan's Step 9 acceptance criterion says `npm test # Must pass with 490 tests`. The worker should verify **490 pass, 4 fail** (same as current baseline), not expect zero failures.

---

## 3. Typecheck Errors — Impact on Step 8?

`npm run typecheck` produces **hundreds** of errors, nearly all pre-existing:
- ~80% are `Cannot find name 'node:fs'` / `node:path` / `NodeJS` / `Buffer` — missing `@types/node` in the shim-based type environment
- ~15% are `AgentToolResult<Details>` type mismatches — upstream Pi API type drift (`type` field now required)
- ~5% are real code drift (`memory` field not in `AgentConfig`, `Container.clear` missing, etc.)

**Impact on Step 8 specifically:** The type widening `Exclude<SubagentRunMode, "single">` → `SubagentRunMode` is at L110 of `async-execution.ts`. This is a local interface change — it won't interact with any of the shim errors. The worker **cannot use `npm run typecheck` as a verification tool** because it's pre-broken. Must rely on `npm test` + `npm run test:all` instead.

**Verdict: Not blocking for implementation, but the plan's Step 9 should remove the `npm run typecheck # Must pass clean` criterion. It won't pass clean. Use test suite as verification.**

---

## 4. Current Function Anchors (for worker reference)

### Functions to extract/replace:

```
# execution.ts
71:c87   function emptyUsage(): Usage {
75:24f   function sumUsage(target: Usage, source: Usage): void {
84:28d   function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
245:065  const FINAL_STOP_GRACE_MS = 1000;
246:46c  const HARD_KILL_MS = 3000;
252:028  const clearFinalDrainTimers = () => {
262:29a  const startFinalDrain = () => {
483:f8f  const processLine = (line: string) => {

# subagent-runner.ts
117:c87  function emptyUsage(): Usage {
133:f0d  function appendRecentStepOutput(step: RunnerStatusStep, lines: string[]): void {
321:065  const FINAL_STOP_GRACE_MS = 1000;
322:46c  const HARD_KILL_MS = 3000;
350:2f8  const clearDrainTimers = () => {
360:ac9  function startFinalDrain(): void {
257:65d  const processStdoutLine = (line: string) => {

# async-execution.ts
107:c78  interface AsyncChainParams {
110:fda  resultMode?: Exclude<SubagentRunMode, "single">;  ← widen this
130:3e0  interface AsyncSingleParams {
232:e68  export function executeAsyncChain(
492:98c  export function executeAsyncSingle(
```

### Usage/call sites for `emptyUsage()`:
- execution.ts: L172, L812, L823, L840, L864, L925 (6 call sites)
- subagent-runner.ts: L223 (1 call site)

### Usage/call sites for `sumUsage()`:
- execution.ts: L899 (1 call site — model retry aggregation)
- subagent-runner.ts: **0 call sites** (background doesn't use sumUsage)

### Usage/call sites for `appendRecentOutput`:
- execution.ts: L548, L565 (2 call sites)

### Usage/call sites for `appendRecentStepOutput`:
- subagent-runner.ts: L1093, L1129 (2 call sites)

### `executeAsyncSingle` call sites:
- subagent-executor.ts: L478, L991, L1840 (3 production calls)
- test/integration/async-execution.test.ts: 20 test calls
- **Total: 23 call sites** — confirms plan's "zero caller changes" approach is correct

---

## 5. BLOCKERS and RISKS

### ⚠️ BLOCKER: Step 8 thin wrapper pseudocode has wrong field mapping

The plan's thin wrapper maps `output` and `outputMode` into `AsyncChainParams`:
```typescript
const chainParams: AsyncChainParams = {
    ...commonFields(params),
    chain: [{ agent: params.agent, task: params.task }],
    ...
    output: params.output,        // ← NOT a field on AsyncChainParams!
    outputMode: params.outputMode, // ← NOT a field on AsyncChainParams!
};
```

**`AsyncChainParams` does NOT have `output` or `outputMode` fields.** These exist only on `AsyncSingleParams`.

How `executeAsyncSingle` currently handles output:
1. Resolves output path from `params.output` + `agentConfig.output` (L538-539)
2. Validates `outputMode` (L540-542)
3. Injects output instruction into task text (L543)
4. Passes `outputPath` and `outputMode` into the step config (L566-567)

How `executeAsyncChain` handles output:
1. Delegates to `buildSeqStep()` → `resolveStepBehavior()` which reads from the `SequentialStep` object's `.output` and `.outputMode` fields (L321-323)

**Fix:** The thin wrapper must bake output/outputMode into the `SequentialStep` chain element, NOT pass them as top-level params:
```typescript
chain: [{
    agent: params.agent,
    task: params.task,
    output: normalizeSingleOutputOverride(params.output, agentConfig.output) || undefined,
    outputMode: params.outputMode,
}],
```

**BUT** — this still won't work cleanly because `executeAsyncChain`'s `buildSeqStep` resolves output via `resolveStepBehavior()` which does different normalization than `executeAsyncSingle`'s inline path. The two output-resolution paths are NOT equivalent.

Key differences in output handling:
- **Single:** `normalizeSingleOutputOverride(params.output, agentConfig.output)` → `resolveSingleOutputPath()` → `injectSingleOutputInstruction()` → bakes into step config
- **Chain:** `resolveStepBehavior(agent, stepOverrides, chainSkills)` → uses `agent.defaultOutput` and override cascade → `buildChainInstructions()` → different instruction format

**This is the real blocker for Step 8.** The thin wrapper approach requires either:
1. Adding an `outputOverride` field to `AsyncChainParams` and handling it in `executeAsyncChain` (scope creep)
2. Pre-resolving the output and baking a fully-resolved task + outputPath into the step (fragile, duplicates logic)
3. Keeping `executeAsyncSingle` as-is for now — just do Steps 1-7 (shared primitives) and defer Step 8

### ⚠️ MEDIUM: Drain timer guard divergence

- **Foreground:** `if (childExited || finalDrainTimer || settled || processClosed || detached) return;`
- **Background:** `if (childExited || finalDrainTimer || settled) return;`

The plan's shared `startFinalDrain(timers, onGrace, onHardKill)` delegates guard checks to the consumer's callbacks. This works — the consumer wraps the callback with its own guards. But the worker MUST NOT try to encode these guards into the shared factory. The plan is correct here; just noting for the worker.

### ⚠️ MEDIUM: `sumUsage()` has 0 callers in background

Background (`subagent-runner.ts`) never calls `sumUsage()`. It only uses `emptyUsage()`. The plan says "Remove local sumUsage()" from both files, but there's no `sumUsage` in subagent-runner.ts to remove. Worker should not search for it there.

### ⚠️ LOW: `processLine` has `jsonlWriter.writeLine` interleaved (foreground only)

Foreground's `processLine` (L483-491) calls `jsonlWriter.writeLine(line)` BEFORE `JSON.parse`. The plan's `stdio-parser.ts` only handles post-parse dispatch. The plan already has a note about this ("CRITICAL: Call jsonlWriter.writeLine(line) BEFORE lineProcessor.processLine(line)"). Worker must keep `jsonlWriter.writeLine(line)` in the consumer, not in the shared parser.

Background's `processStdoutLine` (L257-266) does NOT use jsonlWriter — it writes via `writeOutputLine(line)` in the catch block (non-JSON only). These are fundamentally different patterns, correctly handled by the `onRaw` callback in the plan.

### ⚠️ LOW: Usage accumulation pattern divergence

Per-message usage accumulation cannot be shared:
- **Foreground (L539-543):** Uses `||` coercion (coerces 0 to fallback), no `inputTokens`/`outputTokens` fallback
- **Background (L289-294):** Uses `??` coercion (preserves 0), HAS `inputTokens`/`outputTokens` fallbacks, types via `ChildUsage` interface (L159-166)

Only `emptyUsage()` initializer and `sumUsage()` model-retry aggregator are truly shared. The plan correctly dropped `accumulateUsage` per earlier oracle review.

---

## Summary

| Item | Status | Action |
|---|---|---|
| Line references | ✅ All correct | None |
| Pre-existing test failures | ✅ Not blocking | Acceptance = 490 pass, 4 fail |
| Typecheck | ⚠️ Pre-broken | Remove from acceptance criteria |
| Steps 1-7 | ✅ No blockers | Proceed |
| Step 8 (thin wrapper) | ❌ Output-resolution divergence | See options below |

### Step 8 Options

**Option A — Defer Step 8.** Do Steps 1-7 only. Still delivers ~200 LOC deduplication from shared primitives. Step 8 becomes a follow-up task with its own design spike.

**Option B — Narrow Step 8 scope.** Don't convert `executeAsyncSingle` to delegate to `executeAsyncChain`. Instead, just have `executeAsyncSingle` import and use the shared primitives (usage, drain timers) from Steps 1-4. Still removes ~40 LOC of duplication within async-execution.ts without the fragile output-path reconciliation.

**Option C — Full thin wrapper.** Pre-resolve all single-specific output/skills/model handling BEFORE constructing the chain step, injecting a fully-resolved task + outputPath into a `SequentialStep`. This is ~60 lines and fragile — future changes to either path could silently diverge.

**Recommendation:** Option A (defer) or Option B (narrow). Option C is the plan's current approach and carries real divergence risk.
