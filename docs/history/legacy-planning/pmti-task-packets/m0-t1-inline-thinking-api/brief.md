# M0-T1 — Inline thinking API and schema plumbing

**Milestone:** M0 — Thinking level dispatch controls
**Status:** Prepared
**Depends on:** none
**Blocks:** M0-T2, M0-T4
**Workspace strategy:** current-branch

## Goal

Add `thinking` as an optional inline dispatch field for single, chain, and parallel subagent requests at the schema/type boundary, without implementing runtime precedence yet.

## Scope in

- Extend the public `subagent` tool schema for:
  - top-level single dispatch: `{ agent, task, thinking, ... }`
  - chain step objects: `{ agent, task, thinking, ... }`
  - parallel task objects: `{ agent, task, thinking, ... }`
- Extend internal request/step/task types so the field survives validation/parsing.
- Add `thinking` to `src/shared/settings.ts` behavior-resolution types: `StepOverrides`, `SequentialStep`, `ParallelTaskItem`, and `ResolvedStepBehavior`.
- Keep accepted values aligned with `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Use the recorded representation decision: carry `thinking?` as a first-class field until runtime normalizes to a model suffix at the child-session boundary.
- Add or prepare low-level schema/type tests if the existing test structure has a clear place.

## Out of scope

- Runtime precedence and child-session spawning changes.
- `/subagents` TUI selector.
- Release/version bump.

## Likely files

- `src/extension/schemas.ts`
- `src/shared/settings.ts`
- `src/shared/types.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- Relevant tests under `test/unit/` or `test/integration/`

## Acceptance criteria

- TypeScript accepts `thinking` on single, chain, and parallel dispatch inputs.
- Tool schema descriptions mention `thinking` in the same style as `model`, `skill`, `progress`, `output`, and `reads`.
- No runtime behavior changes are required in this task, but the field must not be discarded before M0-T2 can consume it.
- `thinking` must not be dropped by `resolveStepBehavior` or related chain/parallel behavior-resolution types.
- Existing tests continue to pass for unchanged fields.

## Risks

- Updating only TypeBox schema but not TypeScript types will make implementation fragile.
- Updating only types but not schema will make API calls fail validation.
- Reusing agent-definition `thinking` semantics too early may obscure inline precedence for M0-T2.
- Omitting `src/shared/settings.ts` will silently drop chain/parallel thinking overrides before runtime can consume them.
