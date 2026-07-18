# Handoff — M0-T2 Runtime precedence and child-session propagation

## Workspace

Workspace strategy: current-branch
Expected branch/worktree: current orchestrator-selected branch/worktree
Workspace owner: orchestrator
Close-out owner: orchestrator/human via finishing-development-branch

Before editing, confirm the current branch/worktree matches the Workspace section. If it is missing or mismatched, stop and report the mismatch instead of creating branches or editing product files.

## Executor prompt

Implement M0-T2 only after M0-T1 exists. Make inline `thinking` override configured agent/default thinking for one dispatch, including `off`, and propagate it through child Pi session spawning for single, chain, parallel, foreground, and background flows.
Oracle warnings folded in: include `src/shared/settings.ts` as the behavior-resolution boundary, normalize first-class `thinking?` to model suffixes at one child-session boundary, and strip any existing known suffix before applying inline thinking (including `off`).

Read first:
- `.pi/pmti/milestones/M0.md`
- `.pi/pmti/tasks/m0-t1-inline-thinking-api/brief.md`
- `src/runs/shared/pi-args.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- `src/shared/settings.ts`
- `src/agents/agents.ts` if behavior precedence is resolved there

Acceptance:
- Inline `thinking` wins over agent override/frontmatter for one dispatch only.
- `thinking: "off"` disables a configured thinking suffix for that dispatch.
- `thinking: "off"` also strips a pre-existing model suffix such as `provider/model:high`, so inline off truly wins.
- Chain/parallel tasks can each carry independent thinking values.
- A chain step's thinking setting does not leak into subsequent steps.
- Runtime tests prove model args or session creation payloads receive the expected effective level.

## Stop-on-mismatch

Stop and report if M0-T1 has not landed, if the field is absent from dispatch inputs, or if foreground/background paths cannot share a common resolution rule without larger refactor.
Stop and report if the code already has a competing thinking representation that would make first-class field plus suffix normalization ambiguous.

## Edit discipline (every file you touch)

- One logical edit per file, then re-read that file before the next edit to it. Never stack multiple anchored edits on the same file without re-reading — stale line anchors cause duplicate or orphaned code.
- For any structured/code file where you must change more than one location, or add/remove a function or block, prefer rewriting the whole file with `write` over stacking `replace_lines`/`set_line` edits.
- After an edit, re-read the changed region and confirm structure is intact: no duplicate declaration/function bodies, balanced braces/parens, and every block you opened has its matching closer.
- Respect the workspace's module system and file conventions (import style, strict-mode rules). Do not introduce a foreign style.

## Failure handling

- After an edit warning or anchor mismatch, re-read before the next edit.
- After a syntax/parse error, inspect the whole edited file before running more tests.
- If the same file or same test fails twice, stop incremental patching: re-read the affected file and the failing assertion, then make one deliberate fix or rewrite the small file cleanly. If that still fails, stop and report the file, the error, and the intended change instead of continuing with a corrupt file.
