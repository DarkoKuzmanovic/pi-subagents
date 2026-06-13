# Plan: Port Structured Output (Tier 1) + Dynamic Fanout (Tier 2) from upstream

Source: `nicobailon/pi-subagents` v0.26.0 (`9ea6c54` dynamic fanout + acceptance gates,
`8e02b1c` nested fanout). We diverged at common ancestor `3ee17de5` (~2026-05-03).
Tiers 3 (acceptance gates) and 4 (workflow graph) are **out of scope**.

## Decision
- **Full parity is the target — including the async runner.**
- Sequence 0 → 1 → 2 → 3 with a **hard checkpoint after Phase 2**. Prove the mechanism
  in the foreground (cheap, additive) before entering the diverged background hot zone.

## Mechanism (how it works)
Structured output is **file + env based**, not a globally-registered tool:
1. Parent creates a temp `{schema.json, output.json}` runtime per step with `outputSchema`.
2. Paths passed to child via `PI_SUBAGENT_STRUCTURED_OUTPUT_{SCHEMA,CAPTURE}`.
3. Child bootstrap registers a `structured_output` tool (writes validated JSON to capture
   path, returns `terminate: true`) + appends instructions to its system prompt.
4. Parent reads+validates `output.json` after clean exit → `SingleResult.structuredOutput`
   → exposed as `{outputs.name}` to later chain steps.

**Dynamic fanout requires structured output** (it expands an array from `source.structured`).
Tier 1 is a hard prerequisite for Tier 2.

## De-risking facts (verified)
- `typebox@^1.1.24` already a dep; `typebox/compile` resolves → **zero new deps**.
- Mechanism is contained in `src/runs/shared/`; child-bootstrap files already exist in fork.
- Our `subagent-prompt-runtime.ts` diverged (uses `rewriteSubagentPrompt`, not upstream's
  `registerSubagentPromptRuntime`) → child tool registration is a **merge, not a copy**.
- Background runner (`subagent-runner.ts`, `async-execution.ts`) is our most diverged area.

## Phases

### Phase 0 — Foundations (no behavior change)
- `src/shared/types.ts`: `JsonSchemaObject`, `ChainOutputMapEntry`, `ChainOutputMap`;
  add `structuredOutput?` / `structuredOutputPath?` / `structuredOutputSchemaPath?` to
  `SingleResult`; `outputs?: ChainOutputMap` on chain result.
- `src/shared/settings.ts`: add `as?`/`outputSchema?`/`phase?`/`label?` to `SequentialStep`
  & `ParallelTaskItem`; add `DynamicExpandSpec`/`DynamicCollectSpec`/`DynamicParallelTemplate`/
  `DynamicParallelStep`; extend `ChainStep` union; add `isDynamicParallelStep`.
- Port `src/runs/shared/structured-output.ts` verbatim (import-path fixups only).
- Tests: `validateStructuredOutputValue`, runtime create/read/cleanup.

### Phase 1 — Tier 1 structured output (foreground: single + chain)
- `pi-args.ts`: accept `structuredOutput` runtime; set the two env vars.
- `subagent-prompt-runtime.ts`: **merge** — register `structured_output` tool when capture
  env set; append `STRUCTURED_OUTPUT_INSTRUCTIONS` in `rewriteSubagentPrompt`.
- `runs/foreground/execution.ts`: create runtime when `outputSchema` present; read+validate
  after clean exit; attach to result; cleanup.
- Port `chain-outputs.ts` (`resolveOutputReferences`, `outputEntryFromResult`,
  `validateChainOutputBindings` — dynamic branch stubbed off).
- `runs/foreground/chain-execution.ts`: thread `ChainOutputMap`; resolve `{outputs.name}`
  before each step (alongside `{previous}`); store `as` after each step; wire per-step/
  per-parallel-task structured runtimes.
- `extension/schemas.ts`: add `as` + `outputSchema` to `ChainItem`, `ParallelTaskSchema`, `TaskItem`.
- **Verify**: pi-coding-agent honors `terminate: true`; reuse envelope-coercion seam for a
  JSON-stringified `value` arg (cheap-driver tolerance — our fork's identity).
- Tests: single structured output; chain `{outputs.name}` handoff; schema-invalid fails;
  missing `structured_output` call fails.

### Phase 2 — Tier 2 dynamic fanout (foreground)
- Port `dynamic-fanout.ts` verbatim.
- `chain-execution.ts`: detect `isDynamicParallelStep` → `materializeDynamicParallelStep`
  → run via existing parallel runner → `collectDynamicResults` → `validateDynamicCollection`
  → store under `collect.as`.
- `chain-outputs.ts`: enable dynamic branch in `validateChainOutputBindings`.
- `extension/config.ts` + `schemas.ts`: `expand`/`collect`/`concurrency`/`failFast` on
  `ChainItem` (optional, runtime-discriminated); `chain.dynamicFanout.maxItems` config knob.
- Tests: happy path, `maxItems` guard, duplicate-key, empty `onEmpty: skip|fail`, unknown ref.

### CHECKPOINT — foreground Tier 1+2 green before background.

### Phase 3 — Background/async parity (GATED)
- `runs/background/subagent-runner.ts` + `async-execution.ts`: structured capture + dynamic
  fanout on the async path. High-conflict diverged zone — port the *proven* mechanism.
- Tests: async structured output + async dynamic fanout parity.

### Docs + release
- README sections (structured output + dynamic fanout), version bump, CHANGELOG.

## Out of scope (deferred)
- `.chain.md` `outputSchema` as a JSON-Schema file path (JSON/`.chain.js` inline only for now).
- Tier 3 acceptance gates, Tier 4 workflow graph.
- **Tier 2 dynamic fanout in the async/background runner** (see Outcome).

## Outcome (v0.39.0)
- **Phase 0–2 (foreground): DONE.** Structured output + dynamic fanout fully implemented and tested.
- **Dual async review (gpt-5.5 + deepseek-v4-pro): DONE.** 9 findings fixed (B1 coercion of single-object `parallel`, B2 clarify gating, B3 stale-capture-across-retries, B4 cleanup-in-finally, S1 maxItems prevalidation, K1 `lane`/`thinking` key allow-list, S2 fork-wrap, S3 display labels, S6 gate-before-artifacts) + 9 regression tests.
- **Phase 3 (async): structured output DONE.** `runSingleStep` runtime+read+cleanup, chain loop `ChainOutputMap`/`{outputs}`/`as`, pre-spawn binding validation. Single dispatch + chains.
- **Phase 3 (async): dynamic fanout DEFERRED.** The async runner pre-bakes per-task scaffolding (session files, status slots, intercom targets, flat indices) from the static chain shape; fanout's runtime task count needs (a) extracting the inline parallel executor into a shared function and (b) runtime splicing of the status/index arrays — verifiable only via live detached runs. Shipped a clear launch-time guard instead; full async fanout is a tracked follow-up.
- **Verification:** typecheck clean, biome+tsc `check` clean, unit 756 pass / 0 fail, integration 322 pass / 0 fail.
