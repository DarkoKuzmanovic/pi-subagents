# PLAN — M13: Acceptance gates and bounded rubric-driven revision loops

Spec: `docs/plans/PLAN-acceptance-gates.md` (authorized 2026-08-02).
Run branch: `crew/m13-acceptance-gates`, cut from `main` @ `7fce02d`.

## Scope decision

| Field | Value |
|---|---|
| Tier | **Full** |
| Risk | **contained protected** (worktree-transaction outcome: **critical protected**) |
| Delivery | **local** — no delivery push, no PR |
| started-at | 2026-08-02T00:16:31+02:00 |
| first-worker-at | _(not yet)_ |
| completed-at | _(not yet)_ |

**Evidence (five-fact checkpoint, orchestrator-authored before any child dispatch):**

1. **User-visible outcomes — 4–5 with distinct boundaries.** Worktree transaction ·
   foreground gate (grade-once + loop) · orchestrator-run check injection · async parity.
   Types + the builtin `grader` role fold into grade-once rather than standing alone.
2. **Repos / release boundaries — 1 repo, 1 version bump.** `origin` →
   `DarkoKuzmanovic/pi-subagents` exists; delivery deliberately kept local.
3. **Unresolved architecture forks — none.** The three live forks were closed by the
   grill (D1/D2/D3 below). Remaining unknowns are detail, not direction.
4. **Protected risk — yes.** The gate's worktree transaction *applies* and *discards*
   diffs against the user's real working tree, in a repo whose conventions ban
   destructive git operations. An integrity failure here corrupts or loses work.
   D3 requires re-proving that machinery unattended in the detached async runner.
5. **Reversibility / verification / confidence.** Code fully reversible on the run
   branch. Verification deterministic and strong (`tsc --noEmit`, 1344 unit, 445
   integration, mock-pi harness). Requirement confidence high after the grill;
   **medium** on worktree seeding and blind-detection detail.

**Why Full rather than Standard.** Four outcomes sits on the boundary and a
single-repo resolved architecture reads Standard. The tip is fact 4: the worktree
transaction is a genuine apply/rollback boundary, architecturally separate from the
gate loop, and D3 adds a second execution environment that must re-prove it. Crew
promotes to Full when protected risk creates its own rollback boundary.
The planner's future milestone count did **not** inform this classification.

**Allowed ceremony.** One planner dispatch (outcome map + first slice only).
One combined `reviewer` `lane:standard` per independently verifiable outcome.
The worktree-transaction outcome takes the two-phase critical gate: one fresh
`scrutinize` pass with `reviewer` `lane:deep`, then one separate `reviewer`
`lane:deep` code review. No automatic project-end review repeat.

**Outcome dispatch ceilings.** Contained protected → **5** delivered dispatches per
outcome. The worktree-transaction outcome is critical protected → **6**.

**Promotion triggers.** A second repository entering scope; discovery that worktree
seeding requires a new architectural surface (snapshot/restore) rather than a
refusal path; any credential or privilege surface appearing in the grader's tool
grant; the apply-back step proving non-atomic in practice.

## Grill decisions — locked 2026-08-02 (intensity: gentle, 3/3 branches resolved)

- **D1 — Attempt isolation.** One transactional git worktree per **gated step**,
  reused across retries (not one per attempt). The cumulative diff applies to the
  real tree **only on a passing verdict**; on exhaustion the worktree is discarded.
  When isolation would be blind — dirty tree, or the step depends on uncommitted
  chain state a fresh worktree cannot see — the gate **refuses loudly** rather than
  running against a phantom baseline.
  _Rejected:_ keep-files-and-patch-on-top (a bad first attempt poisons later ones);
  snapshot/restore of the working tree (untracked files, deletions, modes, symlinks —
  a milestone hiding inside a milestone); scoping v1 to non-editing steps (guts the
  spec's own headline example).
  _Consulted:_ `pitaj` sol, mode=critique. Recommended this shape and named its own
  kill condition: seeding from the exact logical baseline. That condition is live —
  `git worktree add` checks out a committed ref and carries neither uncommitted nor
  untracked work. D1's refusal path is the answer to it.

- **D2 — Grader evidence.** The grader receives read-only tools (`read,grep,find,ls`)
  scoped to the **worktree**, not the real tree, and by default reads the produced
  files. Per-gate configuration may opt down to report-only for text-producing steps,
  but the **default reads files**. The grader **never executes**: when a gate needs
  check results, the **orchestrator** runs the configured checks in the worktree and
  injects the results as evidence for the grader to score.
  _Rejected:_ report-only default (grades the worker's self-report — the loop would
  optimize prose, since injected feedback shapes the next report, not the next
  artifact); arming the grader with command execution (nondeterministic judgment
  applied to a deterministic question, plus per-iteration wall-clock cost).
  _Consulted:_ `pitaj` fable, mode=critique. Identified that the **spec as written is
  option (a)** — "the producing step's output + the rubric", no file access — and
  called it the trap. Also surfaced the tree-ambiguity: a grader reading the real
  tree instead of the worktree grades stale state and every verdict is wrong.

- **D3 — Scope edge.** Background/async parity **is part of "done"** for M13. Not
  deferred to a later milestone.
  _Consequence:_ every D1/D2 mechanism must be re-proven in the detached runner,
  where failures surface as a result file rather than on screen, and where a worktree
  left by a crashed run has no observer. This is the largest single cost in the
  milestone and it lands in the last outcome — sequence accordingly.

**Spec defect to correct before implementation.** `docs/plans/PLAN-acceptance-gates.md`
specifies the grader as receiving only "the producing step's output + the rubric",
which contradicts D2. The doc also never states which tree the grader reads. Both
must be corrected in the spec, not silently diverged from in code.

## Open questions

- [ ] How does the gate *detect* that isolation would be blind? A dirty tree is
      trivially checkable; a step depending on an earlier chain step's uncommitted
      edits is not. Is refusal keyed on tree cleanliness alone, or on chain position?
- [ ] What is the default `maxIterations`? The spec shows `3` in an example but names
      no default, and the default governs the token-blow-up risk.
- [ ] Does `accept-best` apply the best attempt's *diff*, requiring every attempt's
      worktree to be retained until the gate resolves?
- [ ] Which checks can a gate ask the orchestrator to run, and how are they declared?

## Outcome map

_Awaiting the planner dispatch. The planner maps outcome boundaries and details only
the first slice; it may not author or alter the scope decision above._

## Conventions block

_Passed verbatim into every worker dispatch. Append environmental workarounds here as
they are discovered — a worker rediscovering a known workaround means it was not
passed forward._

- Test commands: `npm run typecheck` · `npm run test:unit` · `npm run test:integration`
  · `npm run test:all`. There is no lint script.
- Unit tests run under `--experimental-strip-types`; integration under
  `--experimental-transform-types`. Both go through
  `test/support/register-loader.mjs`.
- `@earendil-works/pi-tui` is **shimmed** in tests by `test/support/ts-loader.mjs`,
  with types in `test/support/shims/pi-tui.d.ts`. A member declared in the `.d.ts`
  but missing from the loader typechecks and then fails at runtime. Adding a shim
  member means adding it to both, plus a behavioural assertion in
  `test/unit/pi-tui-shim-surface.test.ts`.
- `mock-pi` responses are claimed **first-come** unless given `taskIncludes`, which
  reserves a response for a child whose rendered task text contains that substring.
  Any test dispatching concurrent children must key its responses, or they swap.
- `AGENTS.md` bans non-null assertions. 139 broader-form occurrences (`!(`, `![`,
  `!,`) remain repo-wide as accepted debt — do not "fix" them opportunistically here.
- Workers never commit. The orchestrator owns git, commits only gated slices on the
  run branch, and never uses `--no-verify`.
- Destructive git operations (`reset --hard`, `stash`, `clean -fd`) are prohibited.

## Deferred

_Should-fixes, nits, and out-of-scope discoveries awaiting close-out transfer.
Nothing is filed as a GitHub issue mid-run._

- _(empty)_

## Documentation evidence

_One line per outcome, recorded before its gate. Both contracts must be reconciled._

- _(none yet)_

## Gate log

| When | Event | Verdict / note |
|---|---|---|
| 2026-08-02 | Spec authorized | `docs/plans/PLAN-acceptance-gates.md` accepted as written, with one defect recorded above |
| 2026-08-02 | Grill (gentle) | 3/3 branches resolved, premise held → D1, D2, D3 |
| 2026-08-02 | `pitaj` sol, critique | Advisory, D1. Recommended transactional worktree; named the seeding kill condition |
| 2026-08-02 | `pitaj` fable, critique | Advisory, D2. Identified the spec-as-written grader trap and the stale-tree ambiguity |
| 2026-08-02 | Scope checkpoint | Tier Full, Risk contained protected, Delivery local — user-confirmed |

## Run metrics

```
dispatches:      0        (delivered only)
burned:          0
review-bundles:  0
review-dispatches: 0
worker-retries:  0
oracle:          0
direct-edits:    0
compactions:     0
```

## Pre-run housekeeping

Not part of M13; recorded so the run branch's base is understood.
`main` @ `7fce02d` — `fix(test): make the harness deterministic` closed both open
ROADMAP debt entries (fanout ordering race, pi-tui shim `setFilter`). Verified green
before the branch was cut: `tsc --noEmit` clean, unit 1344 pass / 4 skip / 0 fail,
integration 445 pass / 1 skip / 0 fail.
