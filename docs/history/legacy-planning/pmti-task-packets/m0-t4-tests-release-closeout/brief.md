# M0-T4 — Tests, docs, and release close-out

**Milestone:** M0 — Thinking level dispatch controls
**Status:** Prepared
**Depends on:** M0-T1, M0-T2, M0-T3
**Blocks:** none
**Workspace strategy:** current-branch

## Goal

Close out M0 with tests, documentation/release metadata where needed, and verification that the thinking-dispatch feature works end-to-end.

## Scope in

- Add or extend unit/integration tests for:
  - single dispatch `thinking`
  - chain step `thinking`
  - parallel task `thinking`
  - precedence including explicit `off`
  - `/subagents` TUI selected override behavior
- Update README or docs only if public examples/API docs need the new field.
- Bump `package.json` version and roll `CHANGELOG.md` `[Unreleased]` into a dated release entry if implementation is non-trivial, per root `AGENTS.md`.
- Run `npm run typecheck` and relevant tests.
- Update PMTI close-out artifacts after implementation verification.

## Out of scope

- Adding runtime/TUI behavior not completed by M0-T1 through M0-T3.
- Post-code review execution unless requested by orchestrator.
- Historical `.pi/tasks/` migration.

## Likely files

- `test/unit/*.test.ts`
- `test/integration/*.test.ts`
- `test/support/*` only if needed for mocks
- `README.md` or docs if examples need updating
- `CHANGELOG.md`
- `package.json`
- `.pi/pmti/project/changes-log.md`
- `.pi/pmti/milestones/M0.md`

## Acceptance criteria

- Tests prove all M0 acceptance criteria from the milestone.
- Typecheck passes.
- Relevant unit/integration tests pass.
- Version/changelog policy is satisfied if source implementation changed.
- PMTI changes log and milestone status reflect close-out state.

## Risks

- Release metadata should not be changed before implementation is actually verified.
- TUI tests may need existing mock-pi patterns; do not invent a new runner.
- PMTI close-out should distinguish implementation completion from reviewer approval if review remains pending.
