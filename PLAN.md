# Commit Engineer User Agent — Crew Plan

## Scope decision

- **Tier:** Standard
- **Risk:** contained protected
- **Evidence:** one user-scoped agent definition plus isolated Git fixture verification; the agent intentionally mutates Git index/history in arbitrary target repositories, so shared-checkout ownership and remote-action authority are protected boundaries.
- **Allowed ceremony:** one supervised implementation outcome, one fresh deep combined review, then deterministic fixture verification and local close-out. No planner because the spec fixes the file surface and behavior.
- **Outcome dispatch ceiling:** 5 child calls.
- **Session ceilings:** 12 child dispatches, 180 child-runtime minutes, 2 compactions, or a model swap.
- **Promotion triggers:** need for a runtime Git guard beyond prompt enforcement, a second repository requiring coordinated code changes, destructive cleanup, or unresolved release/publish semantics.
- **Started-at:** 2026-07-14T12:00:00+02:00
- **First-worker-at:** 2026-07-14T12:08:00+02:00
- **Time-to-first-worker:** 8m

## Grill decisions

- Intensity: gentle.
- Default authority ends at local commits; push, tag, publish, PR creation, and other remote actions require exact dispatch authorization.
- Release metadata follows repository policy first, exact task requirements second, and otherwise remains untouched.
- Mixed/ambiguous checkout changes block committing unless ownership is provable.
- Any pre-existing staged change blocks immediately, even if it appears task-related.
- Repositories without automated checks may still be committed after deterministic staged-diff inspection, but the result must report incomplete verification rather than claiming a passing test gate.

## Acceptance criteria

- `~/.agents/commit-engineer.md` is discovered as a fresh-context user agent.
- The definition permits Git/verification and surgical edits to existing release/state metadata, but excludes arbitrary file creation.
- Explicit-path staging, pre-staged-index refusal, ambiguous-ownership refusal, no-amend/no-reset/no-stash/no-broad-add rules, and exact remote-action authorization are unambiguous.
- An isolated fixture proves the agent commits only an explicitly authorized path while leaving unrelated changes unstaged and uncommitted.
- A second isolated fixture proves an ambiguous “commit the work” request creates no commit and stages nothing.
- The agent reports structured evidence for commits, verification, remaining changes, ambiguity, remote actions, and blockers.
- `IDEAS.md` records the agent as built only after fixture verification.
- The owning `pi-subagents` README/AGENTS remain accurate; no extension runtime documentation claims the user agent is a packaged builtin.

## Conventions

- Agent definitions live under `~/.agents/*.md` with YAML frontmatter.
- User agents use fresh context and do not inherit project context or skills unless explicitly justified.
- Workers do not commit the `pi-subagents` repository.
- Fixture repositories live under `/tmp`, have no remotes, and disable commit signing only through fixture-local Git config.
- Never test the commit-capable agent against a live repository.

## Outcome map

### Outcome 1 — Commit-engineer definition, isolated safety proof, and roster documentation

**State:** completed

**Counters:** dispatches: 5/5 · review-bundles: 2 · review-dispatches: 2 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 0 · direct-edits: 3

- [x] Implement `~/.agents/commit-engineer.md` from `docs/specs/2026-07-14-commit-engineer-design.md` and the grill decisions above.
- [x] Confirm discovery through `subagent({ action: "list" })`.
- [x] Run the explicit-path fixture and verify commit contents plus untouched unrelated work.
- [x] Run the ambiguity fixture and verify zero commits/staged paths.
- [x] Run one fresh deep combined review over the definition, spec, fixture evidence, and `IDEAS.md` update.
- [x] Resolve the broad commit-time staging and short hook-bypass blocker within the one-cycle rule; delta re-review passed.
- [x] Update `IDEAS.md`, final verification evidence, and Crew handoff.

**Gate log:** Initial deep review returned FIX-FIRST because `git commit -a`/`--all`/`-am` and `git commit -n` were not explicitly banned. The agent definition and design spec now ban those forms; fresh deep delta review returned PASS. The optional pre-staged-index fixture remains a future strengthening, not an acceptance blocker.

## Run metrics

- Dispatches: 5/12
- Review bundles: 2
- Review dispatches: 2
- Worker retries: 0
- Oracle dispatches: 0
- Completed outcomes: 1/1
- Child runtime minutes: ≥6/180 (exact foreground totals unavailable)
- Compactions: 0/2

## Final verification evidence

- `subagent({ action: "list" })` discovers `commit-engineer` as a user agent with fresh context.
- Explicit fixture: 2 commits; HEAD `8ba28b3` contains only `owned.txt`; index empty; `neighbor.txt` remains modified.
- Ambiguous fixture: baseline commit only; index empty; `alpha.txt` and `beta.txt` remain modified.
- Fresh deep combined review: FIX-FIRST on commit-time broad staging and short hook bypass.
- Fresh deep delta re-review after the prompt/spec fix: PASS.
- `git diff --check` and final repository status remain required before commit close-out.

## Crew handoff

- **Done:** user-scoped `commit-engineer` definition, discovery proof, two isolated Git fixtures, protected-boundary review/fix/re-review, design spec, historical v0.41.1 PLAN archive, and `IDEAS.md` roster update.
- **Next:** investigate and decide async-by-default chain routing semantics before assigning the next extension version.
- **Open questions:** whether to add a third fixture for the already-specified pre-existing-staged-index hard block.
- **Confidence gaps:** prompt-level command restrictions cannot physically constrain `bash`; safety is supported by explicit prohibitions, isolated behavior fixtures, and review, not a deterministic shell policy.
