# Handoff — M1-T4 Six-role roster, docs, tests, and close-out

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree; run `git status --short --branch` before editing
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

## Task hardness

Hardness: normal
Rationale: Final roster/docs/tests pass after core model-lane behavior lands; user-facing but mostly metadata/docs.
Recommended executor: worker
Review required: yes
Oracle required: no, unless compatibility risk around disabled agents is unclear

## Executor prompt

Implement M1-T4 only in `/home/quzma/.pi/agent/extensions/pi-subagents` after M1-T1, M1-T2, and M1-T3 have landed.

Goal: close M1 by making the visible builtin roster six roles and updating docs/tests around lane dispatch and `/subagents config`.

Read first:
- `.pi/pmti/milestones/M1.md`
- `.pi/pmti/tasks/m1-t4-roster-docs-tests-closeout/brief.md`
- Full current git diff from M1-T1/T2/T3
- `agents/*.md` for builtin frontmatter
- `chains/go.chain.md`
- `README.md`
- `AGENTS.md`
- `skills/pi-subagents/SKILL.md`
- `test/unit/agent-disabled.test.ts`
- `test/unit/package-manifest.test.ts` if inventory expectations are asserted there

Implement:
1. Disable/hide by default: `deslopper`, `oracle-fresh`, `scout`, `researcher`, `synthesizer`, `test-writer`, `worker-light`, `worker-heavy`.
2. Keep executable by default: `recon`, `planner`, `worker`, `reviewer`, `oracle`, `janitor`.
3. Update `go.chain.md` to use only the six-role roster, or explicitly mark any old chain as compatibility-only if disabling would break it.
4. Update docs/examples to explain folded roles:
   - scout/researcher -> recon with local/web context prompts
   - synthesizer -> reviewer synthesis prompt/skill
   - test-writer -> worker with test-writing prompt/skill
   - worker-light/heavy -> worker with `lane`/`model` override
   - oracle-fresh -> oracle with fresh context or artifact prompt if needed
   - deslopper -> janitor
5. Mention `/subagents config` and `lane` dispatch in user-facing docs.
6. Record full lane-editing TUI as deferred/future work, not implemented.
7. Add/update tests for executable-agent list and chain/doc consistency as practical.
8. Update changelog/version metadata only if project convention requires it for this package change.

Stop-on-mismatch:
- Do not delete agent files without explicit approval.
- Do not run provider bakeoff.
- If disabling agents breaks a required chain/test in a way that needs a product decision, stop and report options.
- Preserve unrelated dirty files.

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
- Run focused agent inventory/disabled tests.
- Run focused docs/chain tests if changed.
- Run `npm run test:unit` if feasible.
- Request or run fresh-context reviewer on the full M1 diff before declaring M1 complete.

Final response shape:
Implemented X. Changed files: Y. Validation: Z. Open risks/questions: R. Recommended next step: fresh-context reviewer / M1 close-out.
