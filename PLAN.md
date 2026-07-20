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
- **dispatches:** 6
- **review-bundles:** 2
- **review-dispatches:** 2
- **worker-retries:** 0
- **oracle:** 0
- **completed-outcomes:** 2
- **child-runtime-minutes:** 23
- **compactions:** 0

## M11 — v0.42.2 routing and distribution close-out

**Counters:** dispatches: 6/9 · review-bundles: 2 · review-dispatches: 2 · fix-cycles: 2/2 · oracle: 0 · worker-retries: 0 · direct-edits: 3

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
  - **Documentation:** README — rewritten in M11.2 | AGENTS — verified accurate; no change needed.

- [x] **M11.2 — Replace stale npm installation and rewrite user documentation**
  - **Risk:** ordinary documentation/distribution contract; no publish or remote action.
  - **Counters:** dispatches: 4/4 · review-bundles: 1 · review-dispatches: 1 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 0 · direct-edits: 1
  - [x] Dispatch `docs-freshener` using `deepseek/deepseek-v4-pro` with `thinking: high` in an isolated worktree.
  - [x] Replace `pi install npm:pi-subagents` with GitHub default-branch installation plus an optional immutable tag-pin example.
  - [x] Rewrite `README.md` into a clearer user-first guide while preserving accurate advanced reference material or moving it to appropriate existing docs.
  - [x] Reconcile README, CHANGELOG, ROADMAP, AGENTS, and relevant docs against source and v0.42.2 behavior; edit documentation only.
  - [x] Validate README anchors/fences/TOC with the freshness gate.
  - [x] Run full repository verification after integrating the documentation diff.
  - [x] Pass one fresh combined documentation/integration review and repair its accepted findings.
  - **Acceptance:** no npm installation command for `pi-subagents` remains; GitHub installation is accurate; README is materially clearer without dropping supported behavior; top-level docs agree on v0.42.2 and M11 status.
  - **Documentation:** README — rewrite integrated | AGENTS — verified accurate; no change needed.

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
- 2026-07-20 — M11.1 fresh full gate: `npm run test:all`, exit `0`; captured integration-stage tail tests `399`, pass `398`, fail `0`, skipped `1`. The preceding unit stage passed through the script's `&&` chain, but its counts were not captured in this run summary.
- 2026-07-20 — M11.1 deep review: `PASS`; no blockers. Accepted one should-fix to guard both untouched single and top-level-parallel branches against accidental `clarify === false` symmetry.
- 2026-07-20 — M11.1 review fix added the two missing unchanged-branch assertions. The first full rerun exposed test leakage from detached background cases (`396` pass, `2` fail); root cause was unawaited async result files bleeding mock calls into later tests.
- 2026-07-20 — M11.1 final fresh gate after awaiting background completion: focused routing `1/1`, fork-context `36/36`, typecheck exit `0`, full `npm run test:all` exit `0`; captured integration-stage tail `399` tests, `398` pass, `0` fail, `1` skipped. Unit counts were not captured in this run summary.
- 2026-07-20 — M11.2 documentation worker dispatched in isolated worktree as run `094b5c3f-c4b7-4e64-a2ef-a082c4c6c52d` using `deepseek/deepseek-v4-pro` with high thinking.
- 2026-07-20 — Scope correction: the global `BRAIN.md` row was located at line 133 and contradicted by current `agents/recon.md`, but is deferred because M11.2 is repository documentation only.
- 2026-07-20 — M11.2 DeepSeek documentation worker completed in `6m12s`; integrated README, CHANGELOG, ROADMAP, and plan-doc changes. AGENTS required no change.
- 2026-07-20 — Integration audit restored valid npm install commands for published companion packages (`pi-intercom`, `pi-web-access`, `@counterposition/pi-web-search`) while keeping `pi-subagents` GitHub-only; corrected CHANGELOG claims to the actual nine-case regression and async-result cleanup.
- 2026-07-20 — README freshness gate exit `0`: headings `49`, link anchors `47`, fences balanced, broken anchors none, headings missing from TOC none.
- 2026-07-20 — M11.2 pre-review verification: README freshness exit `0`; typecheck exit `0`; `npm run test:all` exit `0`; captured integration-stage tail `399` tests, `398` pass, `0` fail, `1` skipped; nine documentation assertions passed.
- 2026-07-20 — M11.2 standard review: `FIX-FIRST`, no blockers. Accepted three source-backed should-fixes: remove false same-author attribution, restore dropped background/parallel observability guidance, and restore legacy local intercom-checkout discovery.
- 2026-07-20 — M11.2 review fix worker restored the missing observability and legacy-intercom guidance and removed false authorship attribution. Freshness exit `0` with headings `50`, anchors `48`, balanced `98` fences, no broken/missing TOC links; all six focused review-fix assertions passed.
- 2026-07-20 — Mandatory close-out verifier: `PASS`. Focused routing `1/1`; typecheck exit `0`; `npm run test:all` exit `0` with unit tests `1112`, pass `1065`, fail `0`, skipped `47`, then integration tests `399`, pass `398`, fail `0`, skipped `1`; README gate exit `0` with headings `50`, anchors `48`, balanced `98` fences, no broken/missing TOC links; scope exactly eight intended paths and no junk.

## Confidence gaps

- The `PI_LIVE_SMOKE=1` integration smoke remains intentionally skipped because it requires real model access; all deterministic local gates passed.
- GitHub tag-pin syntax is supported by installed Pi package documentation, but no v0.42.2 tag may be created during this local run.

## Rejected alternatives

- Publishing stale npm package versions during this run: rejected by user direction and local delivery boundary.
- Pinned-only GitHub installation: rejected because it would be unusable until a separately authorized tag exists.
- Local-checkout-only installation: rejected because the repository remains publicly installable from GitHub.

## Deferred

- Remove the confirmed stale `~/.pi/agent/BRAIN.md:133` recon eager-off shim row in a separate Pi-config maintenance change; `agents/recon.md` has no matching `extensions:`/shim entry, but global BRAIN is outside this repository outcome.
