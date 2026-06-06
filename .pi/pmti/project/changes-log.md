# PMTI Changes Log

## 2026-06-01 — PMTI initialized

Initialized PMTI v1 project state for `pi-subagents` and planned M0 from `TODO.md`.

- Project default workspace strategy: `current-branch`.
- Existing `.pi/tasks/` preserved as read-only legacy scratch context.
- Oracle review for M0 recorded as pending.

Implementation changes are not recorded here until PMTI implementation close-out.

## 2026-06-01 — M0 implementation (fix-back 2: hub thinking persistence)

Implemented inline `thinking` level dispatch controls across schema, runtime, TUI, and tests.

- `thinking` field added to `SubagentParams`, `TaskItem`, `ParallelTaskSchema`, `ChainItem` schemas.
- `thinking` carried through `settings.ts` behavior resolution (`StepOverrides`, `SequentialStep`, `ParallelTaskItem`, `ResolvedStepBehavior`, `resolveStepBehavior`).
- Runtime normalization via `applyEffectiveThinkingSuffix` strips pre-existing model suffix before applying effective thinking (including `off`).
- Foreground and background execution paths both pass effective thinking into child Pi session args via `buildPiArgs`.
- `/subagents` TUI shows effective thinking level, supports Tab cycling, and persists thinking overrides coherently for its configuration-hub workflow.
- 18 new unit tests covering suffix stripping, precedence, and chain step isolation.
- Version bumped to 0.35.0; CHANGELOG updated.
- Reviewer initially BLOCKED (runtime propagation incomplete, TUI compile errors, false close-out claims). Fix-back 1 completed: runtime propagation through single/chain/parallel/async paths, TUI duplicates removed. Fix-back 2: `/subagents` hub persisted thinking overrides. Re-review remained BLOCKED on overwrite/no-model/display gaps. Local fix-back 3 merged model+thinking override saves, uses the current session model when inline thinking has no explicit model, fixes bare-model thinking display/cycling, and adds regression tests. Re-review 2 remained BLOCKED on two propagation gaps. Local fix-back 4 passes resolved parallel thinking to foreground `runSync`, passes single clarify thinking to async background dispatch, and raises thinking-dispatch coverage to 46 passing tests.
- Final re-review returned PASS_WITH_WARNINGS with no critical or important findings. M0 is closed from the thinking-dispatch perspective; remaining notes are source-text guardrails versus future stronger runtime tests and broad pre-existing typecheck failures outside M0.

Changed files (M0 scope only):
- `src/extension/schemas.ts`
- `src/shared/settings.ts`
- `src/runs/shared/pi-args.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- `src/tui/subagent-hub.ts`
- `src/slash/slash-commands.ts`
- `test/unit/thinking-dispatch.test.ts` (46 tests)
- `package.json`
- `CHANGELOG.md`

## 2026-06-06 — M1 implementation (model lanes and six-role roster)

Implemented model lane dispatch, the `/subagents config` JSON shortcut, and the six-role builtin roster.

- Added `subagents.modelLanes` parsing/resolution with project-over-user precedence and explicit missing-lane errors.
- Threaded optional `lane` through single dispatch, top-level parallel, chain steps, slash inline config, and async serialization before child model candidates are built.
- Added `/subagents config|json|edit` to seed missing `subagents.modelLanes` in user settings and open the JSON with safe argv-based editor launch.
- Disabled eight compatibility builtins by default (`scout`, `researcher`, `synthesizer`, `test-writer`, `worker-light`, `worker-heavy`, `oracle-fresh`, `deslopper`) while preserving their files and `discoverAgentsAll` visibility.
- Updated the default `go` chain to `context-builder → planner → worker → reviewer`.
- Updated README, bundled skill documentation, CHANGELOG, and package version to 0.36.0; full lane-editing TUI is deferred.
- Final fresh-context review found one documentation fix-back in `skills/pi-subagents/SKILL.md`; follow-up review returned no findings.

Changed files (M1 scope):
- `agents/deslopper.md`, `agents/oracle-fresh.md`, `agents/researcher.md`, `agents/scout.md`, `agents/synthesizer.md`, `agents/test-writer.md`, `agents/worker-heavy.md`, `agents/worker-light.md`
- `chains/go.chain.md`
- `README.md`, `skills/pi-subagents/SKILL.md`
- `src/agents/agent-serializer.ts`, `src/agents/agents.ts`, `src/agents/model-lanes.ts`
- `src/extension/schemas.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/shared/settings.ts`
- `src/slash/slash-commands.ts`, `src/slash/subagents-config.ts`
- `test/integration/async-execution.test.ts`, `test/integration/parallel-execution.test.ts`, `test/integration/slash-commands.test.ts`
- `test/unit/agent-disabled.test.ts`, `test/unit/agent-frontmatter.test.ts`, `test/unit/model-lanes.test.ts`, `test/unit/schemas.test.ts`, `test/unit/subagents-config.test.ts`
- `CHANGELOG.md`, `package.json`, `.pi/pmti/milestones/M1.md`, `.pi/pmti/project/changes-log.md`, `.pi/pmti/project/decisions.md`, `.pi/pmti/project/roadmap.md`

Validation:
- Focused closeout tests: agent frontmatter serialization and slash-command integration pass after final review fix-back.
- Full unit suite: 702 tests, 655 pass, 0 fail, 47 skipped. Full integration suite: 340 tests, 312 pass, 0 fail, 28 skipped.
- Typecheck remains blocked in the orchestrator environment because `tsc` is unavailable locally.