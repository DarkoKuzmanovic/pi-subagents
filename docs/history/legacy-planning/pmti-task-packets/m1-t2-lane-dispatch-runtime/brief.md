# M1-T2 — Lane dispatch schema and runtime propagation

## Preflight

- Project: `pi-subagents`
- Milestone: `.pi/pmti/milestones/M1.md`
- Depends on: M1-T1
- Workspace strategy: current-branch
- Expected branch/worktree: current orchestrator-selected branch/worktree; stop on mismatch

## Goal

Add `lane` as an explicit dispatch override and route selected lanes through all execution paths with safe precedence.

## Task hardness

Hardness: high
Rationale: This touches public schema/types plus foreground/background/chain/parallel model resolution paths.
Recommended executor: worker-heavy
Review required: yes
Oracle required: no, unless precedence or async propagation differs from M1

## Scope in

- Add optional `lane?: string` to single dispatch params, chain sequential steps, parallel task items, and slash parser config where applicable.
- Add schema descriptions so the tool prompt exposes `lane` as a model-lane selector, not as an agent role.
- Apply resolved lane values before child-session model candidates are built.
- Preserve field-level precedence: explicit inline `model` overrides lane model; explicit inline `thinking` overrides lane thinking.
- Unknown requested lane returns a clear error before spawning a child session.
- Cover foreground single, top-level parallel, chains, async chains/parallel groups, and slash `/run`/`/chain`/`/parallel` if parser support is added.

## Scope out

- Do not create the settings parser; M1-T1 owns it.
- Do not implement `/subagents config`; M1-T3 owns it.
- Do not disable agents or rewrite docs; M1-T4 owns it.
- Do not auto-classify task difficulty.

## Suggested implementation surface

- `src/extension/schemas.ts`: add `lane` to `SubagentParams`, `TaskItem`, `ChainItem`/step schemas.
- `src/runs/foreground/subagent-executor.ts`: add `lane` to `TaskParam`/`SubagentParamsLike`; resolve lane for single/parallel/chain before model/thinking normalization.
- `src/shared/settings.ts`: add `lane` to `StepOverrides`, `SequentialStep`, `ParallelTaskItem` if chain behavior needs to carry it.
- `src/runs/background/async-execution.ts` and runner config types: ensure async uses the same resolved behavior, not a divergent lane lookup.
- `src/slash/slash-commands.ts`: if config parser accepts `[model=...]`, extend it to `[lane=easy]` and propagate to `/run`, `/chain`, `/parallel`.

## Acceptance criteria

- `subagent({ agent: "worker", lane: "easy", task: "..." })` uses `modelLanes.worker.easy`.
- `subagent({ agent: "worker", lane: "easy", model: "override/model", task: "..." })` uses `override/model` while still taking lane thinking if no inline thinking is set.
- `subagent({ agent: "worker", lane: "easy", thinking: "off", task: "..." })` treats `off` as explicit and does not resurrect lane thinking.
- Unknown lane produces an error like `Unknown model lane 'easy' for agent 'worker'` and does not spawn.
- Chain and parallel lane requests behave the same as single-agent requests.

## Validation

- Unit tests in `test/unit/schemas.test.ts` for schema shape.
- Focused runtime tests near existing single/parallel/chain execution tests, or source-text guardrail tests only if full spawn tests are too heavy.
- Slash command test if `[lane=...]` is added.
