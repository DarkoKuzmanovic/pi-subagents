# Step 8 Recommendation: Do the thin wrapper (revised Option C)

**TL;DR:** Option B is inapplicable. Option A is safe but wasteful. The thin wrapper works perfectly — I've traced every divergence and they all resolve. **Do Step 8 as-planned with the thin wrapper.**

---

## Option B is a red herring

`async-execution.ts` is a **launcher**, not a **runner**. It constructs configuration, spawns the runner process via `spawnRunner()`, emits an event, and returns a success message. It never:
- Accumulates usage (Steps 1-4's `usage.ts`)
- Uses drain timers (Steps 1-4's `exit-drain.ts`)
- Buffers output (Steps 1-4's `output-buffer.ts`)
- Parses stdout JSON lines (Steps 1-4's `stdio-parser.ts`)

Those shared primitives apply to `execution.ts` (foreground runner) and `subagent-runner.ts` (background runner) — the processes that actually _run_ agents. The launcher just sets them up and detaches.

**Option B ("have executeAsyncSingle import shared primitives") doesn't apply. There are no shared primitives to import.**

## The output-resolution divergence is solvable

The blocker was: "single uses `normalizeSingleOutputOverride` → `resolveSingleOutputPath`, chain uses `resolveStepBehavior` → `buildChainInstructions`."

I traced both paths through the code. They converge:

### Output resolution

| Param state | Single path result | Chain path result (with correct step overrides) |
|---|---|---|
| `output: undefined` | `normalizeSingleOutputOverride(undefined, agentDefault)` → `undefined` → no output | Step override `output: false` → `resolveStepBehavior` returns `false` → `resolveSingleOutputPath(false, ...)` → `undefined` → no output ✅ |
| `output: true` | `normalizeSingleOutputOverride(true, agentDefault)` → agent's default path | Step override `output: agentDefault` → `resolveStepBehavior` returns it → resolved ✅ |
| `output: "result.md"` | passed through | Step override `output: "result.md"` → passed through ✅ |
| `output: false` | returns `false` → no output | Step override `output: false` → `false` ✅ |

**Key insight:** Pre-normalize with `normalizeSingleOutputOverride` _before_ constructing the step. Map `undefined` result → `false` (suppresses chain's fallback to `agentConfig.output`).

### Read/progress instructions

`buildChainInstructions` with `reads: false, progress: false, output: false` returns `{ prefix: "", suffix: "" }`. Setting `reads: false` and `progress: false` in the step override produces identical task text to the single path. Verified by reading `buildChainInstructions` (L461-537 of settings.ts).

### Skill resolution

| Single path | Chain path |
|---|---|
| `params.skills ?? agentConfig.skills ?? []` | `resolveStepBehavior` with `stepOverrides.skills = params.skills`: if defined, uses it; if undefined, falls back to `agentConfig.skills ?? []` |

Identical semantics. ✅

### Model resolution

| Single path | Chain path |
|---|---|
| `params.modelOverride ?? agentConfig.model` | `behavior.model = stepOverrides.model ?? agentConfig.model` → same |

Identical. ✅

### Event emission

The `handleStarted` listener (async-job-tracker.ts L201-212) already defensively handles both shapes:
```typescript
const rawAgents = info.agents?.length ? info.agents 
    : info.chain?.length > 0 ? info.chain 
    : info.agent ? [info.agent] 
    : undefined;
```

Chain event adds `agents`, `chain`, `chainStepCount`, `parallelGroups` — all handled by existing fallback logic. Extra fields are additive. No listener breakage. ✅

## Concrete thin wrapper

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

~35 lines. Zero caller changes. All 20 test calls + 3 production calls stay as `executeAsyncSingle(id, params)`.

## Required type change

`AsyncChainParams.resultMode` must widen from `Exclude<SubagentRunMode, "single">` to `SubagentRunMode`:
```typescript
// Before:
resultMode?: Exclude<SubagentRunMode, "single">;
// After:
resultMode?: SubagentRunMode;
```

## LOC impact

| What | Lines |
|---|---|
| Delete `executeAsyncSingle` body (L496-620) | -125 |
| Add thin wrapper | +35 |
| Widen `resultMode` type | +0 (in-place) |
| **Net** | **-90** |

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Output path produces different result | **Eliminated** — traced all 4 cases | Pre-normalize + explicit `false` for undefined |
| Read/progress instructions leak in | **Eliminated** — explicit `false` overrides | Step overrides suppress chain defaults |
| Event shape breaks listener | **Eliminated** — handler already defensive | Additive fields only |
| Skill resolution differs | **Eliminated** — equivalent semantics | Direct substitution |
| Unknown caller expectation | Low | 20 integration tests cover every call pattern |

## Recommendation

**Do Step 8 as-written in the plan (thin wrapper).** The divergences that triggered the blocker are all solvable with the field mapping above. The conversion is ~35 lines, deletes ~125 lines, breaks zero callers, and is fully covered by existing integration tests.

Deferring (Option A) would leave the largest single-file duplication untouched — the very thing this task was created to fix. Steps 1-7 address _runner_ duplication; Step 8 addresses _launcher_ duplication. They're orthogonal. Doing both completes the picture.

## One adjustment to make in plan.md

Update the Step 9 verify grep:
```bash
# OLD (wrong — function still exists as wrapper):
grep -r "executeAsyncSingle" src/  # Zero hits

# NEW (correct — body is gone, wrapper remains):
grep -c "executeAsyncSingle" src/runs/background/async-execution.ts  # Should be ~2 (export + function)
```
