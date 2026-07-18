# Handoff — M0-T4 Tests, docs, and release close-out

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

Before editing, confirm the current branch/worktree matches the Workspace section. If it is missing or mismatched, stop and report the mismatch instead of creating branches or editing product files.

## Executor prompt

Implement M0-T4 only after M0-T1, M0-T2, and M0-T3 have landed. Add/extend tests, update public docs if needed, satisfy version/changelog policy, run verification, and update PMTI close-out artifacts.

Read first:
- `.pi/pmti/milestones/M0.md`
- all M0 task briefs
- `AGENTS.md` versioning/testing sections
- `package.json`
- `CHANGELOG.md`
- existing tests around subagent schemas, execution, async/foreground flows, and TUI hub

Acceptance:
- Unit/integration tests cover single, chain, parallel, precedence including `off`, and `/subagents` TUI override behavior.
- Tests include explicit cases for `thinking: "off"` stripping pre-existing model suffixes and for chain step thinking not leaking into the next step.
- `npm run typecheck` passes.
- Relevant tests pass; if full suite is impractical, state exact commands run and why.
- Version/changelog are updated after implementation verification; this M0 implementation is non-trivial, so treat the bump/release note as required.
- `.pi/pmti/project/changes-log.md` and `.pi/pmti/milestones/M0.md` reflect implementation close-out status without claiming reviewer approval if review did not run.

## Stop-on-mismatch

Stop and report if prerequisite tasks are incomplete, if the working tree contains unreviewed unrelated changes that would make version/changelog close-out ambiguous, or if tests reveal a design blocker that requires revisiting M0-T1 through M0-T3.

## Edit discipline (every file you touch)

- One logical edit per file, then re-read that file before the next edit to it. Never stack multiple anchored edits on the same file without re-reading — stale line anchors cause duplicate or orphaned code.
- For any structured/code file where you must change more than one location, or add/remove a function or block, prefer rewriting the whole file with `write` over stacking `replace_lines`/`set_line` edits.
- After an edit, re-read the changed region and confirm structure is intact: no duplicate declaration/function bodies, balanced braces/parens, and every block you opened has its matching closer.
- Respect the workspace's module system and file conventions (import style, strict-mode rules). Do not introduce a foreign style.

## Failure handling

- After an edit warning or anchor mismatch, re-read before the next edit.
- After a syntax/parse error, inspect the whole edited file before running more tests.
- If the same file or same test fails twice, stop incremental patching: re-read the affected file and the failing assertion, then make one deliberate fix or rewrite the small file cleanly. If that still fails, stop and report the file, the error, and the intended change instead of continuing with a corrupt file.
