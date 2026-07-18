# Handoff — M0-T3 `/subagents` TUI thinking selector

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

Before editing, confirm the current branch/worktree matches the Workspace section. If it is missing or mismatched, stop and report the mismatch instead of creating branches or editing product files.

## Executor prompt

Implement M0-T3 only after M0-T1 exists. Add a thinking-level selector/override to the interactive `/subagents` hub and pass the selected override into dispatch. Do not implement release metadata or broad runtime refactors in this task.
Oracle warning folded in: do not create a competing thinking representation. Use the M0 decision: expose first-class `thinking?` where needed, but converge with the existing model-suffix TUI mechanism at the runtime normalization boundary.

Read first:
- `.pi/pmti/milestones/M0.md`
- `.pi/pmti/tasks/m0-t1-inline-thinking-api/brief.md`
- `src/tui/subagent-hub.ts`
- `src/runs/foreground/chain-clarify.ts` for existing thinking selector patterns only
- `src/shared/model-info.ts`
- relevant hub integration tests/support files

Acceptance:
- The hub displays effective thinking for the selected agent.
- A launch-time override can be selected and included in the hub result/dispatch input.
- Unsupported model levels are filtered or reset safely.
- The override is not persisted to agent config.
- Existing suffix-based model override behavior and the new thinking override converge; they do not compete or double-apply.

## Stop-on-mismatch

Stop and report if `/subagents` hub does not currently support enough stateful editing to add this safely, or if runtime propagation from hub result depends on unfinished M0-T2 architecture.

## Edit discipline (every file you touch)

- One logical edit per file, then re-read that file before the next edit to it. Never stack multiple anchored edits on the same file without re-reading — stale line anchors cause duplicate or orphaned code.
- For any structured/code file where you must change more than one location, or add/remove a function or block, prefer rewriting the whole file with `write` over stacking `replace_lines`/`set_line` edits.
- After an edit, re-read the changed region and confirm structure is intact: no duplicate declaration/function bodies, balanced braces/parens, and every block you opened has its matching closer.
- Respect the workspace's module system and file conventions (import style, strict-mode rules). Do not introduce a foreign style.

## Failure handling

- After an edit warning or anchor mismatch, re-read before the next edit.
- After a syntax/parse error, inspect the whole edited file before running more tests.
- If the same file or same test fails twice, stop incremental patching: re-read the affected file and the failing assertion, then make one deliberate fix or rewrite the small file cleanly. If that still fails, stop and report the file, the error, and the intended change instead of continuing with a corrupt file.
