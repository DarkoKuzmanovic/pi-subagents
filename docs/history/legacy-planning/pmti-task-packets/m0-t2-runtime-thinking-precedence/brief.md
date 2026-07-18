# M0-T2 — Runtime precedence and child-session propagation

**Milestone:** M0 — Thinking level dispatch controls
**Status:** Prepared
**Depends on:** M0-T1
**Blocks:** M0-T4
**Can run in parallel with:** M0-T3 after M0-T1 lands
**Workspace strategy:** current-branch

## Goal

Make inline dispatch `thinking` affect spawned subagent sessions with precedence `inline > agentOverrides > agent file > session default` across foreground, background, chain, and parallel paths.

## Scope in

- Consume the `thinking` field introduced by M0-T1.
- Resolve effective thinking for single dispatch, chain steps, and parallel tasks.
- Carry `thinking` through `src/shared/settings.ts` behavior resolution for chain and parallel steps.
- Ensure foreground and background execution paths pass the resolved level into child Pi session arguments.
- Preserve existing `applyThinkingSuffix` behavior and avoid double suffixes.
- Treat `off` as an explicit override, not as missing.
- When inline thinking is present, strip any existing known `:level` suffix from the model string before applying the effective level; this includes `thinking: "off"`.

## Out of scope

- Public schema additions from M0-T1.
- `/subagents` TUI selector from M0-T3.
- Release metadata and docs from M0-T4.

## Likely files

- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- `src/runs/shared/pi-args.ts`
- `src/shared/settings.ts`
- `src/agents/agents.ts` only if behavior merging needs a helper
- Tests for runtime argument/model construction

## Acceptance criteria

- Inline `thinking` overrides configured agent/default thinking for that dispatch only.
- `thinking: "off"` prevents adding a thinking suffix even if the agent has `thinking: high`.
- `thinking: "off"` also strips an already-baked model suffix such as `model: "provider/id:high"`.
- Chain and parallel tasks can set distinct thinking levels.
- Chain step thinking does not leak into the next step.
- Async/background execution remains consistent with foreground execution.
- Existing model fallback behavior preserves the selected thinking level safely.

## Risks

- There may be multiple behavior-resolution layers; patch the boundary that owns effective per-dispatch behavior.
- Chain context must not accidentally leak a previous step's thinking setting.
- Model suffix handling may differ between `model-info.ts`, `model-fallback.ts`, and `pi-args.ts`.
- `applyThinkingSuffix(model, "off")` currently returns `model` unchanged, so runtime normalization must strip known suffixes before calling it when inline thinking is present.
