# M1-T4 — Six-role roster, docs, tests, and close-out

## Preflight

- Project: `pi-subagents`
- Milestone: `.pi/pmti/milestones/M1.md`
- Depends on: M1-T1, M1-T2, M1-T3
- Workspace strategy: current-branch
- Expected branch/worktree: current orchestrator-selected branch/worktree; stop on mismatch

## Goal

Finish the M1 phase by reducing the visible builtin roster to six durable roles, updating docs/examples, and validating the full lane + JSON shortcut feature set.

## Task hardness

Hardness: normal
Rationale: Mostly docs/tests/agent metadata after core lane runtime lands, but visibility changes affect user workflows.
Recommended executor: worker
Review required: yes
Oracle required: no; run oracle only if compatibility risk is unclear

## Scope in

- Disable or hide these builtin agents from executable list by default: `deslopper`, `oracle-fresh`, `scout`, `researcher`, `synthesizer`, `test-writer`, `worker-light`, `worker-heavy`.
- Keep six visible roles: `recon`, `planner`, `worker`, `reviewer`, `oracle`, `janitor`.
- Preserve compatibility artifacts where practical; do not delete agent files unless explicitly approved.
- Update builtin chains and docs/examples so the default flow uses six roles. The old `go` chain should not depend on disabled agents without an explicit compatibility story.
- Update README, bundled `pi-subagents` skill docs, and `AGENTS.md` builtin-agent table as needed.
- Record full lane-editing TUI as a later milestone candidate/follow-up rather than implementing it.
- Add/adjust tests proving disabled agents do not appear in executable list and six-role docs/chain behavior are coherent.
- Changelog/version metadata if required by project release discipline.

## Scope out

- No full lane-editing TUI.
- No provider bakeoff execution.
- No permanent deletion of deprecated/compatibility agent files.
- No unrelated cleanup of legacy `.pi/tasks/`.

## Suggested implementation surface

- `agents/*.md`: set `disabled: true` or equivalent for duplicate/niche builtins if builtin frontmatter supports it; otherwise apply disable through builtin config/override mechanism.
- `chains/go.chain.md`: update to a six-role sequence such as `recon -> planner -> worker -> reviewer`, or document/rename the old chain as legacy if keeping it.
- `README.md`, `AGENTS.md`, `skills/pi-subagents/SKILL.md`: update visible role list and examples.
- Tests near `test/unit/agent-disabled.test.ts`, `test/unit/package-manifest.test.ts`, and any docs/chain tests that assert builtin inventory.

## Acceptance criteria

- `subagent({ action: "list" })` reports only the six durable agents as executable by default.
- Disabled names are documented as compatibility/deprecated, not recommended roles.
- `worker-light`/`worker-heavy` semantics are represented as model lanes or dispatch overrides, not as visible agents.
- `scout`/`researcher`/`synthesizer` are folded into `recon`/`reviewer` usage guidance.
- `test-writer` is folded into `worker` with test-writing skill guidance or explicit prompt guidance.
- Public docs mention `/subagents config` and `lane` dispatch.
- Future lane-editing TUI is explicitly deferred.

## Validation

- Focused inventory/disabled-agent tests.
- Focused docs/chain tests if present.
- `npm run test:unit` if feasible.
- Fresh-context reviewer after full M1 implementation diff exists.
