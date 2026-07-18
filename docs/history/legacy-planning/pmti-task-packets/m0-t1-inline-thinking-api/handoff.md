# Handoff — M0-T1 Inline thinking API and schema plumbing

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

Before editing, confirm the current branch/worktree matches the Workspace section. If it is missing or mismatched, stop and report the mismatch instead of creating branches or editing product files.

## Executor prompt

Implement M0-T1 only: add optional inline `thinking` support at the schema/type boundary for single, chain, and parallel subagent dispatch. Do not implement runtime precedence or TUI behavior in this task.
Oracle warning folded in: `src/shared/settings.ts` is in scope for this task. Add `thinking` to `StepOverrides`, `SequentialStep`, `ParallelTaskItem`, `ResolvedStepBehavior`, and behavior-resolution surfaces so chain/parallel dispatch does not silently drop it. Use the project decision to carry first-class `thinking?` until runtime normalizes to a model suffix.

Read first:
- `.pi/pmti/project/charter.md`
- `.pi/pmti/milestones/M0.md`
- `TODO.md`
- `src/extension/schemas.ts`
- `src/shared/types.ts`
- `src/shared/settings.ts`
- relevant executor type definitions discovered from the files above

Acceptance:
- `thinking` is accepted in the public schema for single dispatch, chain steps, and parallel task items.
- Internal input types preserve `thinking` for later runtime consumption.
- `src/shared/settings.ts` preserves `thinking` through chain/parallel step behavior resolution.
- Existing tests/typecheck do not regress for unchanged dispatch shapes.

## Stop-on-mismatch

Stop and report if the schema/type architecture differs from the milestone assumptions or if adding this field requires broader runtime changes to compile.
Stop and report if you find another behavior-resolution boundary that can drop chain/parallel `thinking` before runtime propagation.

## Edit discipline (every file you touch)

- One logical edit per file, then re-read that file before the next edit to it. Never stack multiple anchored edits on the same file without re-reading — stale line anchors cause duplicate or orphaned code.
- For any structured/code file where you must change more than one location, or add/remove a function or block, prefer rewriting the whole file with `write` over stacking `replace_lines`/`set_line` edits.
- After an edit, re-read the changed region and confirm structure is intact: no duplicate declaration/function bodies, balanced braces/parens, and every block you opened has its matching closer.
- Respect the workspace's module system and file conventions (import style, strict-mode rules). Do not introduce a foreign style.

## Failure handling

- After an edit warning or anchor mismatch, re-read before the next edit.
- After a syntax/parse error, inspect the whole edited file before running more tests.
- If the same file or same test fails twice, stop incremental patching: re-read the affected file and the failing assertion, then make one deliberate fix or rewrite the small file cleanly. If that still fails, stop and report the file, the error, and the intended change instead of continuing with a corrupt file.
