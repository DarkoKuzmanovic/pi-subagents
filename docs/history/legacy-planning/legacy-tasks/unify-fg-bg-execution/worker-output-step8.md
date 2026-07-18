# Step 8 Worker Output

## Changes made

### 1. Widened `AsyncChainParams.resultMode` type
**File:** `src/runs/background/async-execution.ts` — line 110

```typescript
// Before:
resultMode?: Exclude<SubagentRunMode, "single">;

// After:
resultMode?: SubagentRunMode;
```

### 2. Replaced `executeAsyncSingle` body with thin wrapper
**File:** `src/runs/background/async-execution.ts` — lines 489–536

Deleted ~122 lines of duplicate spawn/event/runner logic. Replaced with 38-line thin wrapper that:
- Destructures `agent, agentConfig, skills, output, outputMode, modelOverride` from params
- Pre-normalizes output via `normalizeSingleOutputOverride(output, agentConfig.output)` → maps `undefined → false` to suppress chain's fallback
- Constructs a `SequentialStep` with `reads: false, progress: false` to suppress chain instruction injection
- Delegates to `executeAsyncChain(id, { chain: [step], resultMode: "single", agents: [agentConfig], ...allOtherFields })`

## Validation

```
npm test: 525 pass, 4 fail, 39 skipped  ← identical to baseline
```

The 4 failures are pre-existing (index-child-registration.test.ts ×2, package-manifest.test.ts, path-resolution.test.ts) — unrelated to this change.

Plan Step 9 grep:
```
grep -c "executeAsyncSingle" src/runs/background/async-execution.ts  → 1  ✓ (export + signature only, body collapsed)
```

## LOC impact
- Deleted: 122 lines (old body)
- Added: 38 lines (thin wrapper)
- Net: **-84 LOC** (oracle predicted -90; difference is the exact original function size)

## All imports retained
`injectSingleOutputInstruction`, `resolveSingleOutputPath`, `validateFileOnlyOutputMode` — all remain used in `buildSeqStep` inside `executeAsyncChain`. No dead imports introduced.

## Zero caller changes
All 20 test calls + 3 production calls stay as `executeAsyncSingle(id, params)`.
