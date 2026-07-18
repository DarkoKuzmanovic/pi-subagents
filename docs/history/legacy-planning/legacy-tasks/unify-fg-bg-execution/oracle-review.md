# Oracle Review: Unify FG/BG Execution Plan

**Verdict: Steps 1–7 are sound. Step 8 has 3 blocking issues that need resolution before a worker can implement it.**

---

## ✅ What's Sound

- **Steps 1–4 (shared modules):** The extraction boundaries are correct. `emptyUsage`, drain timer constants/lifecycle, output ring buffer, and stdio line parsing are genuine duplications with identical semantics. The module API designs are clean and testable.
- **Step 5 (unit tests):** Correct test strategy. New shared modules are pure functions; unit tests are the right layer.
- **Steps 6–7 (consumer refactors):** The approach of having consumers import shared modules while keeping `AgentProgress` and `RunnerStatusStep` types separate is the right call. The adapter pattern (consumers bridge their own types to shared primitives) preserves type isolation per the brief's constraint.
- **Risk analysis:** The 6 identified risks are real and the mitigations are sensible.

## 🔴 Blocking Issues in Step 8

### Issue 1: Type constraint violation — `resultMode` excludes `"single"`

`AsyncChainParams.resultMode` is typed as `Exclude<SubagentRunMode, "single">` (L110 of `async-execution.ts`). The plan says to pass `mode: "single"` into `executeAsyncChain`, but the chain function's type **deliberately excludes** the `"single"` mode.

**Fix:** Widen `resultMode` to `SubagentRunMode` (which includes `"single"`). This is a deliberate type boundary change — the plan should state it explicitly.

### Issue 2: 23 call sites not addressed — function deletion would break callers

`executeAsyncSingle` has:
- **20 direct calls** in `test/integration/async-execution.test.ts`
- **3 production calls** in `subagent-executor.ts` (L478, L998, L1847)

The plan says "Delete `executeAsyncSingle()` function" but doesn't mention updating ANY callers. Two options:
1. **Keep `executeAsyncSingle` as a thin wrapper** that converts params and delegates to `executeAsyncChain`. Zero caller changes needed. (Recommended — smallest blast radius.)
2. **Update all 23 call sites** to construct `AsyncChainParams` and call `executeAsyncChain` directly. High effort, high churn.

### Issue 3: Param shapes are incompatible for spreading

The plan's pseudocode:
```typescript
const chainParams = isSingle
  ? { ...params, chain: [singleToStep(params)], mode: "single" }
  : { ...params, mode: "chain" };
```

This can't work. `AsyncSingleParams` and `AsyncChainParams` have **6 mutually exclusive fields**:
- Single-only: `agent`, `agentConfig`, `sessionFile`, `skills`, `output`, `outputMode`, `modelOverride`
- Chain-only: `chain`, `agents`, `resultMode`, `chainSkills`, `sessionFilesByFlatIndex`

You can't spread `AsyncSingleParams` and get valid `AsyncChainParams`. The `singleToStep` function needs to be a proper conversion that:
1. Creates a one-element `chain` from the single agent's config
2. Wraps `agents: [agentConfig]`
3. Maps `sessionFile` → `sessionFilesByFlatIndex: [sessionFile]`
4. Handles skill resolution, output path resolution, and model resolution that `executeAsyncSingle` currently does inline

**Estimated conversion complexity:** ~40 lines. Not trivial.

## 🟡 Medium Issues

### Issue 4: `jsonlWriter.writeLine` omitted from stdio-parser design

Foreground's `processLine` (L483-491) calls `jsonlWriter.writeLine(line)` for **ALL non-empty lines** (JSON and non-JSON) BEFORE attempting JSON parse. The plan's `createLineProcessor` routes to `onJson` OR `onRaw` exclusively — there's no `onAll` pre-parse hook.

**Impact:** A literal-minded worker replacing the foreground's `processLine` with `createLineProcessor` would lose the `jsonlWriter.writeLine` call, silently breaking JSONL artifact logging.

**Fix:** Add this note to Step 6: *"Consumer must call `jsonlWriter.writeLine(line)` before `lineProcessor.processLine(line)`. The stdio-parser only dispatches post-parse; the pre-parse JSONL write stays in the consumer."*

### Issue 5: `accumulateUsage` doesn't fit any actual use case — drop it

The plan proposes `accumulateUsage(base: Usage, partial: {...}): Usage` as a "non-mutating reducer." But neither foreground nor background has this pattern:

- **Foreground** (L535-543): Inline accumulation from raw event data using `u.input || 0`, `u.cost?.total || 0` (note: `||` not `??`)
- **Background** (L289-294): Inline accumulation using `eventUsage.input ?? eventUsage.inputTokens ?? 0`, `eventUsage.cost?.total ?? 0` (note: `inputTokens` fallback)
- **Background status** (L1131-1140): Accumulates into `step.tokens: { input, output, total }` — different type entirely

None of these can use `accumulateUsage` as proposed because:
1. Raw event usage has different field names (`inputTokens`/`outputTokens` fallback)
2. Raw event usage has nested `cost.total` structure
3. Background status tokens use a different type (`{ input, output, total }`)

**Fix:** Remove `accumulateUsage` from the plan. It adds dead code. The inline accumulation-from-events is specific to the raw event schema and should stay in each consumer. Only `emptyUsage` and `sumUsage` are genuinely shared.

### Issue 6: `snapshot()` returns internal array reference — aliasing risk

The plan's `createRecentOutputBuffer.snapshot()` returns `buffer` directly. When foreground assigns `progress.recentOutput = outputBuffer.snapshot()`, any external modification to `progress.recentOutput` would corrupt the buffer's internal state.

**Fix:** Return `[...buffer]` (shallow copy). Performance cost is negligible (copying ≤50 strings).

## 🟢 Low / Informational

| # | Issue | Severity |
|---|-------|----------|
| 7 | Brief mentions `usageFromAttempts()` — no such function exists. Plan correctly omits it. | Info |
| 8 | Plan Step 8 line ref wrong: says L232-487, actual is L492-619 (129 lines). | Typo |
| 9 | Drain timer guards differ: foreground checks `processClosed`/`detached`, background doesn't. Plan's shared `startFinalDrain` has no guards. Acceptable (consumers own guards), but add a comment. | Low |
| 10 | Usage accumulation uses `||` (foreground) vs `??` (background) — semantically different for `0` values. Out of scope for this plan, but document for awareness. | Info |

## Recommendation

**Steps 1–7:** Proceed as planned with fixes for Issues 4, 5, and 6.

**Step 8:** Revise to keep `executeAsyncSingle` as a **thin wrapper** (10–15 lines) that converts `AsyncSingleParams` to `AsyncChainParams` and delegates to `executeAsyncChain`. This:
- Avoids breaking 23 call sites
- Avoids the incompatible-spread problem
- Still achieves the goal (single implementation path, no duplicated spawn/event logic)
- Requires widening `AsyncChainParams.resultMode` to include `"single"`
- Reduces risk from High to Low

With these fixes, the plan satisfies all acceptance criteria and honors all out-of-scope constraints.
