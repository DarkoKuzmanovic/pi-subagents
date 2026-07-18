# Handoff — M1-T2 Lane dispatch schema and runtime propagation

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree; run `git status --short --branch` before editing
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

## Task hardness

Hardness: high
Rationale: Public schema and execution routing changes have high blast radius across single/parallel/chain/async paths.
Recommended executor: worker-heavy
Review required: yes
Oracle required: no, unless precedence semantics need revision

## Executor prompt

Implement M1-T2 only in `/home/quzma/.pi/agent/extensions/pi-subagents` after M1-T1 has landed.

Goal: add dispatch-level `lane` support and use the M1-T1 lane resolver across runtime paths.

Read first:
- `.pi/pmti/milestones/M1.md`
- `.pi/pmti/tasks/m1-t2-lane-dispatch-runtime/brief.md`
- M1-T1 changed files and tests
- `src/extension/schemas.ts`
- `src/runs/foreground/subagent-executor.ts` around `SubagentParamsLike`, `TaskParam`, single/parallel/chain execution setup
- `src/shared/settings.ts` around `StepOverrides`, `SequentialStep`, `ParallelTaskItem`, `resolveStepBehavior`
- `src/runs/background/async-execution.ts` around `buildStepOverrides`, `executeAsyncChain`, `AsyncSingleParams`
- `src/slash/slash-commands.ts` parser only if adding `[lane=...]` slash support

Implement:
1. Add optional `lane` to relevant types and schemas.
2. Resolve lane values for each requested agent/step/task before child model candidates are built.
3. Apply field-level precedence: inline `model` > lane model > agent model; inline `thinking` > lane thinking > agent thinking. Treat `thinking: "off"` as explicit.
4. Unknown requested lane returns a tool error before spawning any child process.
5. Extend slash config syntax to `[lane=easy]` if it is a small parser addition; otherwise record it as a follow-up and do not block tool API support.
6. Add focused tests for schema shape, precedence, unknown lane failure, and at least one chain/parallel propagation path.

Stop-on-mismatch:
- Do not edit `/subagents config` behavior here; M1-T3 owns it.
- Do not change roster visibility here; M1-T4 owns it.
- If async requires a much broader redesign than resolving before async config serialization, stop and report.

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
- Run focused schema/runtime tests changed by this task.
- Run `npm run test:unit` if feasible.
- Report broad typecheck status separately from targeted test status.

Final response shape:
Implemented X. Changed files: Y. Validation: Z. Open risks/questions: R. Recommended next step: M1-T3 or M1-T4 depending what has landed.
