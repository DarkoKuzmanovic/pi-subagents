# pi-subagents v0.41.1 Crew Plan

## Scope decision

- **Tier:** Standard
- **Risk:** contained protected
- **Evidence:** five-model review plus direct source/test verification on v0.41.0; one confirmed template-rendering integrity defect, four bounded runtime/config defects, four regression-test gaps, and four stale documentation items.
- **Allowed ceremony:** two supervised outcomes; no planner because file surfaces and dependencies are already mapped; one deep combined reviewer per protected outcome; no project-end repeat unless close-out creates new integration scope.
- **Outcome dispatch ceiling:** 5 child calls per outcome.
- **Session ceilings:** 12 child dispatches, 180 child-runtime minutes, 2 completed outcomes, 2 compactions, or a model swap.
- **Promotion triggers:** new repository, unresolved architecture fork, destructive/data-integrity surface, materially expanded public API, or inability to verify deterministic behavior.
- **Started-at:** 2026-07-13T00:32:27+02:00
- **First-worker-at:** 2026-07-13T00:37:06+02:00
- **Time-to-first-worker:** 4m39s

## Grill decisions

- Intensity: gentle.
- Include all verified runtime, regression-test, config-hardening, and documentation items in v0.41.1.
- Preserve a strict patch boundary: no async template-variable capability expansion, slash-command `thinking=` parity feature, package-lock policy change, PID-reuse redesign, or unrelated cleanup.

## Acceptance criteria

- Every chain execution path resolves author template tokens in one pass; substituted values cannot introduce another token expansion.
- Clarify-selected thinking overrides the prior effective thinking value, including `off`.
- Explicit async interrupt works from persisted run state after in-memory tracker reset.
- Timeout escalation notices use configured grace and accurately describe intercom route availability.
- Malformed legacy config cannot crash extension startup or dispatch path.
- Regression coverage exercises runaway fallback, hard-kill escalation, interrupted lifecycle suppression, and degraded OM completion-outbox publication.
- Verified stale documentation is corrected without introducing new planning promises.
- `npm run typecheck`, `npm run test:all`, and extension lint pass.
- `package.json` and `CHANGELOG.md` release v0.41.1.
- Root `README.md` and `AGENTS.md` remain accurate; update only where behavior or maintainer invariants changed.

## Conventions

- ESM imports use `.js` extensions; files remain `.ts`.
- Node built-in test runner only.
- No `any`, no non-null assertions, type-only imports use `import type`.
- Bug fixes use TDD in the same worker dispatch.
- Do not edit generated files or add dependencies.
- Workers do not commit.
- Baseline: `npm run typecheck` passes; `npm test` reports 1051 passed, 0 failed, 47 skipped.
- On this machine, isolated worktree tests inherit global commit signing and can block on pinentry. Run the suite with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false`; this is a per-command test override, not a config change.

## Outcome map

### Outcome 1 — Template rendering integrity across all execution modes

**State:** completed

**Counters:** dispatches: 3/5 · review-bundles: 1 · review-dispatches: 1 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 0 · direct-edits: 0

- [x] Add failing call-path regressions for foreground parallel, dynamic fanout, async sequential, and async parallel token injection.
- [x] Route all paths through the shared single-pass renderer.
- [x] Compute previous-token behavior from raw author templates.
- [x] Verify focused tests, typecheck, unit and integration suites.
- [x] Run one fresh deep combined review; resolve accepted findings within the one-cycle rule.

**Gate log:** PASS after one accepted should-fix cycle. Core output/author-token and dynamic-item non-recursion invariants are closed. Existing direct renderer tests remain authoritative. Async call-path tests are present but environment-skipped locally where jiti is unavailable.

### Outcome 2 — Control/config correctness, regression hardening, docs, and release

**State:** completed

**Counters:** dispatches: 5/5 · review-bundles: 1 · review-dispatches: 1 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 1 · direct-edits: 0

- [x] Make Clarify thinking selection override prior effective thinking, including `off`, with regression tests.
- [x] Resolve explicit async interrupt from persisted run state after tracker reset, with regression tests.
- [x] Render timeout escalation notices from configured grace and actual intercom route availability.
- [x] Validate legacy config JSON at the input boundary without crashing startup or dispatch.
- [x] Add end-to-end runaway fallback, hard-kill escalation, interrupted lifecycle suppression, and degraded OM outbox tests.
- [x] Repair tracked stale docs; locally correct ignored historical `pre-plan.md` without changing ignore policy.
- [x] Review README/AGENTS accuracy; no contract text change required unless the gate identifies drift.
- [x] Release v0.41.1 via package version and dated CHANGELOG section.
- [x] Run one fresh deep combined review and final verification; no duplicate review of unchanged Outcome 1 scope.

**Gate log:** PASS after one accepted should-fix cycle. Sequential/background Clarify thinking propagation, full-valid config round-trip coverage, and tracked-doc CHANGELOG wording were corrected. Async-only regressions remain environment-skipped locally where jiti is unavailable.

## Run metrics

- Dispatches: 8/12
- Review bundles: 2
- Review dispatches: 2
- Worker retries: 1
- Oracle dispatches: 0
- Completed outcomes: 2/2
- Child runtime minutes: ≥30/180 (one timed-out worker; exact foreground totals unavailable)
- Compactions: 1/2

## Final verification evidence

- `npm run typecheck` — exit 0.
- `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false npm run test:all` — unit: 1104 tests, 1057 passed, 0 failed, 47 skipped; integration: 395 tests, 349 passed, 0 failed, 46 skipped.
- Changed-file Biome — exit 0; two pre-existing warnings and informational suggestions, no errors.
- `git diff --check` — exit 0.
- `npm pack --dry-run --json` — `pi-subagents@0.41.1`, 124 files, 394151-byte archive, 1524567 bytes unpacked.

## Crew handoff

- **Done:** v0.41.1 implementation, tests, protected-boundary reviews, docs, roadmap, version, and changelog.
- **Next:** choose git close-out; no push or publication performed.
- **Open questions:** async-only regression cases remain skipped in this standalone checkout because jiti is unavailable; they are present and typechecked.
- **Confidence gaps:** direct executed evidence exists for foreground fallback/hard-kill, persisted interrupt, config, thinking, notices, and OM degradation; detached async equivalents require a jiti-enabled environment.
