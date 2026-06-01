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