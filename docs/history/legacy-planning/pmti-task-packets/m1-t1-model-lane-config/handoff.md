# Handoff — M1-T1 Model lane settings and resolution model

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree; run `git status --short --branch` before editing
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

## Task hardness

Hardness: high
Rationale: This creates the config boundary for model routing and must fail safely on invalid or unknown lanes.
Recommended executor: worker-heavy
Review required: yes
Oracle required: no, unless you believe the M1 precedence semantics need revision

## Executor prompt

Implement M1-T1 only in `/home/quzma/.pi/agent/extensions/pi-subagents`.

Goal: add a typed, tested settings helper for `subagents.modelLanes` without changing dispatch behavior yet.

Read first:
- `.pi/pmti/milestones/M1.md`
- `.pi/pmti/tasks/m1-t1-model-lane-config/brief.md`
- `src/agents/agents.ts` around settings path/read/write helpers and `readSubagentSettings`
- `test/unit/agent-overrides.test.ts`
- `test/unit/schemas.test.ts` only if you need thinking enum reference

Implement:
1. Add a focused model-lane settings module or carefully export/reuse settings helpers from `src/agents/agents.ts`.
2. Support settings shape `subagents.modelLanes[agentName][laneName] = { model?: string, thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh" }`.
3. Read user and project settings with project lane definitions winning over user definitions for the same agent/lane.
4. Return a safe result shape for found vs missing lanes; do not silently pick another lane.
5. Add unit tests for valid lanes, invalid shapes, invalid thinking, user/project precedence, and partial model/thinking lanes.

Stop-on-mismatch:
- If the existing dirty files are unrelated to this task, preserve them.
- If settings helpers cannot be reused without a broad refactor, stop and report the narrowest alternative before editing widely.
- Do not add runtime `lane` request fields in this task.

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
- Run the focused unit test(s) you added/changed.
- If feasible, run `npm run test:unit`.
- Report whether `npm run typecheck` was run; if it fails due known broad errors, cite the evidence and identify whether M1 files are implicated.

Final response shape:
Implemented X. Changed files: Y. Validation: Z. Open risks/questions: R. Recommended next step: M1-T2 and/or M1-T3.
