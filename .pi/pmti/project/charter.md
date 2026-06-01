# PMTI Project Charter — pi-subagents

**Created:** 2026-06-01
**PMTI version:** 1
**Project:** `pi-subagents`
**Primary user:** Pi extension maintainer / orchestrator
**Default workspace strategy:** current-branch

## One-liner

`pi-subagents` is a Pi extension for delegating work to subagents through single-agent, parallel, chain, async/background, forked-context, and intercom-coordinated workflows.

## Why this exists

This project lets one orchestrator keep decision ownership while cheaply delegating scoped reconnaissance, planning, implementation, review, and synthesis to specialized agents. It should make delegation safer, more structured, and easier to recover from when a worker stalls or diverges.

## Scope in

- Subagent tool schema and runtime execution flows.
- Chain, parallel, async, and foreground execution behavior.
- `/subagents` TUI dispatch UX.
- Agent/chain/skill/prompt discovery and management.
- Durable planning via PMTI project/milestone/task artifacts.

## Scope out

- Replacing Pi core agent session APIs.
- Adding unrelated model-provider support outside subagent routing needs.
- Implementing product source changes during PMTI planning.
- Backporting old `.pi/tasks/` packets into PMTI unless a later milestone explicitly calls for it.

## Constraints and invariants

- Runtime dependencies stay limited to Node built-ins, `@earendil-works/*`, and `typebox` unless explicitly approved.
- ESM TypeScript conventions: `.js` import specifiers, no `any`, no non-null assertions for new code, type-only imports where appropriate.
- Node built-in test runner is the test framework; do not introduce Jest/Vitest.
- Planning artifacts live under `.pi/pmti/` only; legacy `.pi/tasks/` remains read-only scratch context.
- Implementation tasks must verify branch/worktree expectations before editing.

## Review posture

- Oracle review is pre-code advisory for milestone/task plans.
- Executors implement approved task packets and stop on ambiguity.
- Reviewer runs after concrete implementation exists.
- Orchestrator/human owns tradeoff decisions, approvals, and branch close-out.
