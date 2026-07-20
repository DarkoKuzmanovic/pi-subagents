# M11 — v0.42.2 routing and distribution close-out

## Scope decision

- **Tier:** Standard
- **Risk:** contained protected
- **Delivery:** local
- **Evidence:** `ROADMAP.md` M11; approved `docs/plans/PLAN-0.42.2.md`; current routing source/tests; README npm install claim; npm registry latest `0.35.1` versus repository `0.42.1`; user-approved GitHub-source replacement and requested DeepSeek documentation rewrite.
- **Allowed ceremony:** one implementation worker and one contained-protected reviewer for M11.1; one requested documentation worker and one combined documentation/integration reviewer for M11.2; one judgment fix cycle per outcome.
- **Outcome dispatch ceiling:** M11.1 `5`; M11.2 `4`.
- **Promotion triggers:** unresolved routing architecture, a second repository, release/publish authorization, or evidence that the README rewrite changes product scope rather than documentation structure.
- **Delivery boundary:** no push, PR, issue, tag, GitHub Release, or npm publish. GitHub reads are allowed; deferred issue transfer requires separate close-out approval.

## Run metrics

- **started-at:** 2026-07-20T13:33:33+02:00
- **first-worker-at:** 2026-07-20T13:34:41+02:00
- **time-to-first-worker:** 1m08s
- **dispatches:** 2
- **review-bundles:** 1
- **review-dispatches:** 1
- **worker-retries:** 0
- **oracle:** 0
- **completed-outcomes:** 1
- **child-runtime-minutes:** 9
- **compactions:** 0

## M11 — v0.42.2 routing and distribution close-out

**Counters:** dispatches: 2/9 · review-bundles: 1 · review-dispatches: 1 · fix-cycles: 1/2 · oracle: 0 · worker-retries: 0 · direct-edits: 2

- [x] **M11.1 — Restore chain-default clarify precedence with routing regression**
  - **Risk:** contained protected — shared dispatch-routing invariant and public behavior.
  - **Counters:** dispatches: 2/5 · review-bundles: 1 · review-dispatches: 1 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 0 · direct-edits: 1
  - [x] Add the smallest routing truth-table regression and observe the expected RED failure.
  - [x] Restore only the chain branch of `effectiveAsync`: `requestedAsync && (hasChain ? clarify === false : clarify !== true)`.
  - [x] Preserve existing single/top-level-parallel behavior and chain parallel-group semantics.
  - [x] Bump package metadata to `0.42.2`; npm also updated the intentionally ignored local lockfile.
  - [x] Run focused routing tests, typecheck, and full unit/integration tests.
  - [x] Pass one fresh contained-protected combined review.
  - **Acceptance:** the truth table in `docs/plans/PLAN-0.42.2.md` is executable and green; all existing checks remain green; no downstream chain behavior changes.
  - **Documentation:** README — pending M11.2 rewrite | AGENTS — verify invariant/workflow guidance remains accurate.

- [ ] **M11.2 — Replace stale npm installation and rewrite user documentation**
  - **Risk:** ordinary documentation/distribution contract; no publish or remote action.
  - **Counters:** dispatches: 0/4 · review-bundles: 0 · review-dispatches: 0 · fix-cycles: 0/1 · oracle: 0 · worker-retries: 0 · direct-edits: 0
  - [ ] Dispatch `docs-freshener` using `deepseek/deepseek-v4-pro` with `thinking: high` in an isolated worktree.
  - [ ] Replace `pi install npm:pi-subagents` with GitHub default-branch installation plus an optional immutable tag-pin example.
  - [ ] Rewrite `README.md` into a clearer user-first guide while preserving accurate advanced reference material or moving it to appropriate existing docs.
  - [ ] Reconcile README, CHANGELOG, ROADMAP, AGENTS, and relevant docs against source and v0.42.2 behavior; edit documentation only.
  - [ ] Validate README anchors/fences/TOC with the freshness gate.
  - [ ] Run full repository verification after integrating the documentation diff.
  - [ ] Pass one fresh combined documentation/integration review.
  - **Acceptance:** no npm installation command remains; GitHub installation is accurate; README is materially clearer without dropping supported behavior; top-level docs agree on v0.42.2 and M11 status.
  - **Documentation:** README — rewrite required | AGENTS — verify/update only if maintainer contracts drifted.

## Conventions

- Follow root `AGENTS.md`: ESM TypeScript, no `any`, no non-null assertions, type-only imports where appropriate, Node built-in test runner.
- TDD is mandatory for the routing behavior: observe RED before production code, then focused GREEN and full verification.
- Workers do not commit; the orchestrator owns explicit-path staging and local commits after gates.
- `package-lock.json` changes only through npm's version tooling; do not hand-edit generated lock data.
- Documentation claims must be verified against source; README freshness script must finish with no broken anchors and balanced fences.
- Delivery is local: no remote writes, tags, releases, PRs, issues, or npm publication.

## Grill decisions

- User explicitly skipped the grill because M11 already has an approved narrow design.
- Installation replacement: GitHub default branch as the primary command, with an optional release-tag pin for reproducibility.
- Documentation worker: explicitly requested `deepseek/deepseek-v4-pro` with `thinking: high` and a substantial README rewrite.

## Gate log

- 2026-07-20 — Spec locked from the approved M11 plan and user distribution/docs decisions.
- 2026-07-20 — Scope classified Standard / contained protected / local. No GitHub write is justified during execution.
- 2026-07-20 — M11.1 RED: focused routing truth-table command exited `1`; omitted chain `clarify` incorrectly returned an async id.
- 2026-07-20 — M11.1 fresh focused GREEN: exit `0`, tests `1`, pass `1`, fail `0`.
- 2026-07-20 — M11.1 fresh typecheck: `npm run typecheck`, exit `0`.
- 2026-07-20 — M11.1 fresh full gate: `npm run test:all`, exit `0`, tests `399`, pass `398`, fail `0`, skipped `1` (`PI_LIVE_SMOKE=1` opt-in).
- 2026-07-20 — M11.1 deep review: `PASS`; no blockers. Accepted one should-fix to guard both untouched single and top-level-parallel branches against accidental `clarify === false` symmetry.
- 2026-07-20 — M11.1 review fix added the two missing unchanged-branch assertions. The first full rerun exposed test leakage from detached background cases (`396` pass, `2` fail); root cause was unawaited async result files bleeding mock calls into later tests.
- 2026-07-20 — M11.1 final fresh gate after awaiting background completion: focused routing `1/1`, fork-context `36/36`, typecheck exit `0`, full `npm run test:all` exit `0` with tests `399`, pass `398`, fail `0`, skipped `1`.

## Confidence gaps

- The exact README restructuring is delegated but must preserve every currently supported public feature; the documentation reviewer owns completeness evidence.
- GitHub tag-pin syntax is supported by installed Pi package documentation, but no v0.42.2 tag may be created during this local run.

## Rejected alternatives

- Publishing stale npm package versions during this run: rejected by user direction and local delivery boundary.
- Pinned-only GitHub installation: rejected because it would be unusable until a separately authorized tag exists.
- Local-checkout-only installation: rejected because the repository remains publicly installable from GitHub.

## Deferred

- None.
