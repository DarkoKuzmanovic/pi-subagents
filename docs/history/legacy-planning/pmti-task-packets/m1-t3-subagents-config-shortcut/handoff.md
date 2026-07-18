# Handoff — M1-T3 `/subagents config` JSON editor shortcut

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree; run `git status --short --branch` before editing
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

## Task hardness

Hardness: normal
Rationale: Localized slash-command/editor shortcut, but user-facing and touches settings JSON.
Recommended executor: worker
Review required: yes
Oracle required: no

## Executor prompt

Implement M1-T3 only in `/home/quzma/.pi/agent/extensions/pi-subagents` after M1-T1 has landed.

Goal: add `/subagents config` as the JSON control-plane shortcut for `subagents.modelLanes` while preserving current `/subagents` TUI behavior.

Read first:
- `.pi/pmti/milestones/M1.md`
- `.pi/pmti/tasks/m1-t3-subagents-config-shortcut/brief.md`
- M1-T1 changed files/helper API
- `src/slash/slash-commands.ts` lines around existing `pi.registerCommand("subagents", ...)`
- `test/integration/slash-commands.test.ts`
- `src/agents/agents.ts` settings path/read/write helpers if not already exposed by M1-T1

Implement:
1. Parse `_args` for the existing `subagents` command. Empty args keep current TUI hub behavior.
2. For `config`, `json`, or `edit`, ensure the user settings file exists and has `subagents.modelLanes` if missing. Preserve all existing settings.
3. Open the settings file with `$VISUAL`, then `$EDITOR`, then a conservative fallback (`nano` is acceptable). Do not concatenate shell strings; pass argv safely.
4. If editor launch fails or no UI/editor is available, notify the exact settings path and the reason.
5. Add focused tests for settings seeding/preservation and command branching.

Stop-on-mismatch:
- Do not implement a lane-editing TUI.
- Do not modify project settings by default; this shortcut targets user settings.
- Do not overwrite existing `modelLanes` or `agentOverrides`.
- Do not use shell execution with user-controlled strings.

Edit discipline (every file you touch):
- One logical edit per file, then re-read that file before the next edit to it. Never stack multiple anchored edits on the same file without re-reading — stale line anchors cause duplicate or orphaned code.
- For any structured/code file where you must change more than one location, or add/remove a function or block, prefer rewriting the whole file with `write` over stacking `replace_lines`/`set_line` edits.
- After an edit, re-read the changed region and confirm structure is intact: no duplicate declaration/function bodies, balanced braces/parens, and every block you opened has its matching closer.
- Respect the workspace's module system and file conventions (import style, strict-mode rules). Do not introduce a foreign style.

Failure handling:
- After an edit warning or anchor mismatch, re-read before the next edit.
- After a syntax/parse error, inspect the whole edited file before running more tests.
- If the same file or same test fails twice, stop incremental patching: re-read the affected file and the failing assertion, then make one deliberate fix or rewrite the small file cleanly. If that still fails, stop and report the file, the error, and the intended change instead of continuing with a corrupt file.

Before editing, confirm the current branch/worktree matches the Workspace section. If it is missing or mismatched, stop and report the mismatch instead of creating branches or editing product files.
Before editing, read the Task hardness section. If the work is broader or riskier than the recorded hardness, stop and report the mismatch instead of silently continuing with the selected executor.

Validation:
- Run focused slash command/config helper tests.
- Run `npm run test:unit` if helper tests are unit tests; run the targeted integration command if slash command tests are integration.
- Report editor-launch behavior as tested/mocked; do not actually block the test suite in an editor.

Final response shape:
Implemented X. Changed files: Y. Validation: Z. Open risks/questions: R. Recommended next step: M1-T2 or M1-T4 depending what has landed.
