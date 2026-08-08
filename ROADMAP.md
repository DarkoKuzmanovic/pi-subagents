# Roadmap

**Status:** active

## Released

- **M0** — Thinking-level dispatch controls — v0.35.0 (2026-06-01)
- **M1** — Model lanes, JSON configuration shortcut, and six-role visible roster — v0.36.0 (2026-06-06)
- **M6** — Durable async OM completion, runaway containment, interrupt semantics, budget accounting, model fallback, and runtime hardening — v0.41.0 (2026-07-12)
- **M7** — Chain-rendering, control, configuration, and regression hardening — v0.41.1 (2026-07-13)
- **M8** — Delta-aware stream accounting that avoids snapshot-amplification false kills — v0.42.0 (2026-07-14)
- **M9** — Cumulative unaccounted-byte backstop for genuinely unparsed stream floods — v0.42.1 (2026-07-14)
- **M10** — Commit-engineer user agent with isolated Git safety proof (2026-07-14)
- **M11** — Restore chain-default clarify precedence and add the routing truth-table regression — v0.42.2 (2026-07-20)
- **M12** — Live run handles: acknowledged cross-process steering/follow-up/wrap-up transport, durable run-handle recovery, and compact attach/detach inspection across live and completed runs — v0.43.0 (2026-07-22)
- **M2** — Lane-editing TUI over user-scope `subagents.modelLanes`: staged create/rename/edit/delete with per-role undo, read-only project rows with shadow labeling, and an atomic merge-preserving user-only lane store — v0.45.0 (2026-07-31)
- **M15** — Upstream backports rebuilt on this fork's own architecture: live-child `resume` moved onto the M12.1 live-control transport, in-child `toolBudget` enforcement, and the `subagent_wait` settle-barrier — v0.46.0 (2026-08-09)

## Current

## Parked

- **M13** — Acceptance gates and bounded rubric-driven revision loops — **M13.1 stopped 2026-08-05** by user decision after 18 dispatches / 7 review rounds, each finding a new path by which the real tree could change despite report-only intent; reverted to the T1 gate contract only (which ships). Automatic apply-back is deferred behind a written re-entry bar (4 named defects + re-review from scratch) — full record in `PLAN.md`'s gate log. Revisit only if usage argues for it.

## Planned

Ordered. Each entry names its upstream provenance (`nicobailon/pi-subagents`) so a future reader can
read the original fix before porting it. Upstream's 0.41.0 removed `tasks[]`, `chain[]`, and static
parallel in favour of `workflowScript`; nothing below assumes that rewrite, and anything post-0.41 is a
concept port rather than a merge — same as M15.

- **M16** — **Fan-out survival: the failure modes our load profile actually produces.** Six upstream fixes,
  all pre-0.41 or architecture-neutral, each one a way a healthy child dies or a parent lies. Verify before
  porting — M8/M9's delta-aware stream accounting may already cover part of the first item.
  1. **Bound streamed progress snapshots** (upstream 0.38.0, #680/#681). A deep fan-out emits a
     `tool_execution_update` above the child-stdout protocol cap and the child is killed with
     `protocol_output_limit`. We have `createRecentOutputBuffer` for output lines, but `recentTools`
     (`src/runs/foreground/execution.ts:641`) has no visible cap and lines are not length-truncated. Cap
     `recentTools`, truncate line length, and keep the full transcript in the returned result and in
     detached-exit recovery.
  2. **Project oversized `turn_end`/`agent_end` child events** to bounded lifecycle records (0.41.0, #743),
     preserving `agent_end.willRetry` drain. Image-heavy children — anything handed `read` on a screenshot —
     currently risk the same `protocol_output_limit` kill.
  3. **Retry short zero-activity child startup exits** on the same model with bounded backoff (0.38.0 #671,
     0.41.0), without replaying model or tool work. We fan out 3–8 children routinely; this launch race is
     currently eaten silently.
  4. **Reload hygiene.** Clean fanout-child nested-control listeners on reload so stale listeners cannot
     duplicate resume handling (0.43.0), and ignore stale extension-context errors from advisory foreground
     control notifications after reload (0.44.0, #905). Same family as the M15 resume bug, and we reload
     this extension constantly while developing it.
  5. **Resync async job control-event scans** that resume inside an oversized JSONL record (0.39.0, #700),
     so a malformed tail does not swallow later control events.
  6. **Canonical signal-termination errors** (0.39.0, #688): report signal-killed children as a signal
     error classified apart from ordinary task failure, instead of stderr-tail noise.

- **M17** — **Tier 2 backports: features that fit this fork's architecture.** Larger surface than M16 and
  none of it urgent, but every item is native to `tasks[]`/`chain[]` and several are cheap while the M15
  child runtime is still warm.
  - **`artifactDir`** (`project` | `session` | `temp`) plus `artifacts.includeTranscript` gating and a
    transcript byte cap (0.36.0, 0.33.0). This is the **production half** of the run-transcript leak in
    Debt below; `cleanupRunTranscripts` is the **retention half**. Land them together or the leak just
    refills more slowly.
  - **Chain approval checkpoints**: `{ checkpoint, message? }` steps, `approve-checkpoint` /
    `reject-checkpoint` controls, persisted checkpoint status, terminal `rejected` outcome (0.39.0, #694).
    Fork-exclusive — upstream deleted chains, so this is ours to keep or lose.
  - **`turnBudget`** (`maxTurns` + `graceTurns`) (0.33.0): soft wrap-up warning through the system prompt,
    abort after grace, partial output returned. The turn-shaped sibling of M15's `toolBudget`, and it slots
    into the same child runtime.
  - **`subagent_wait` follow-ups**: `{ nonBlocking: true }` durable subscriptions that wake the originating
    session, live status streaming while waiting, and structured `details.completions` carrying run identity
    and artifact paths (0.41.0 #832; upstream Unreleased).
  - **`projectRootResolution: "git-root"`** (0.38.0) so monorepos and worktrees stop resolving
    `agentOverrides` from the nearest package root.
  - **Session-scoped `allowedAgents` ceilings** and the monotonic capability-ceiling API with inherited
    async/nested propagation (0.39.0; 0.37.0 #585).
  - **`/subagents-detach`** (0.39.0): detach the active foreground single run without terminating the child.
  - **`usageBudget`** token *and cost* ceilings (0.39.0), extending today's output-token-only
    `sessionTokenBudget`.
  - **Agent-definition ergonomics**, individually trivial and collectively an afternoon:
    `agentOverrides.description` (0.40.0), builtin worker aliases `developer`/`coder`/`implementer`/`develop`
    (0.39.0), `defaultThinking` and `defaultExtensions` (0.37.0), `acceptanceRole` (0.35.0).

- **M14** — Full-coverage green CI: recover the ~67 environmentally-skipped integration tests in the isolated CI environment (add `jiti` as a devDependency for the ~42 loader-gated tests; evaluate shims or install strategy for the `@earendil-works/*`-gated remainder). Originally slated to ship with the next minor bump; it **did not ship in v0.46.0**, which went to the M15 backports instead. Deliberately not re-promised to a version — take it when the skip count next obstructs a release or hides a real failure.

- **M18** — **Herdr integration.** Replace the pi-intercom skill's cmux/tmux fallback with herdr's own surface
  for peer sessions. Upstream built this on missions/FleetView (0.41.0), so the port is conceptual, but the
  event contract and pane-binding design are worth reading first: automatic Herdr status metadata for active
  async runs including reload recovery and needs-attention blocking, the forward-compatible `herdr:busy`
  sibling event for semantic working state (#730), optional drill-in inspector panes with durable pane
  bindings and lifecycle/transcript dashboards plus steer/stop over the existing file control channel, and
  Herdr project panes for opening a project-rooted session for cross-codebase work. Requires Herdr 0.7.5+.

- **M19** — **`external-cli` agent profiles** (upstream 0.41.0). Opt-in async one-shot agents that spawn a
  *non-Pi* CLI: stdin prompt delivery, argv-only spawning, lifecycle/status artifacts, stdout/stderr logs,
  timeout, and stop support. Makes the existing Claude/Codex/agy delegation habit a first-class agent type
  instead of an `interactive_shell` improvisation, and it composes with M18's panes.
## Debt

Known, accepted, and deliberately unbundled. Each entry states why it was not fixed in the milestone
that surfaced it, so a future reader does not mistake it for an oversight.

- ~~**Fanout ordering race in the integration suite**~~ — **resolved 2026-07-24.** The diagnosis in this
  entry was wrong: index-directory assignment was already deterministic. The nondeterminism was in the
  test harness — `mock-pi`'s response queue was claimed first-come, so concurrent parallel children
  swapped each other's responses and the assertion on `parallel-N/0-*` read the sibling's output.
  `MockPiResponse.taskIncludes` now reserves a response for the matching task; unkeyed responses stay
  first-come. Reproduced 2-of-22 pre-fix runs, 0-of-12 post-fix, with a dedicated regression in
  `test/unit/mock-pi-response-routing.test.ts`.
- **139 broader-form non-null assertions repo-wide** — `AGENTS.md` bans non-null assertions, but the
  M12.4 sweep only covered the 24 `!.` dot-access occurrences; the `!(`, `![`, and `!,` forms remain.
  Scoped out of M12.4 deliberately rather than missed. Per-file concentrations and the regression-risk
  assessment live in `IDEAS.md` — keep the detail there, not duplicated here. — effort:M
- ~~**`setFilter` missing from the pi-tui test shim**~~ — **resolved 2026-07-24.** `setFilter` now
  implements the installed component's semantics exactly (prefix match on `value`, selection reset to 0,
  no callback), and `SelectList` reads through `filteredItems` like the real class. The audit against the
  installed `pi-tui` dist also found `SettingsList.updateValue` real-public but undeclared, now added.
  `test/unit/pi-tui-shim-surface.test.ts` exercises every declared member behaviourally, so the next
  declared-but-missing gap fails there. Two known simplifications are asserted rather than hidden: the
  shim's `wrapTextWithAnsi` chunks by width instead of word-wrapping, and `Text` accepts but ignores the
  padding arguments.

- ~~**README–code drift: `--no-context-files` for fresh children is documented but unwired**~~ —
  **resolved 2026-08-05.** `skipContextFiles` was only ever set from `inlineReads === true` in chain paths,
  which nothing set. Decision (user-selected): wire the flag rather than bless the drift in docs.
  `shouldSkipContextFiles()` (`src/shared/fork-context.ts`) now derives the flag from resolved
  `fresh`/`fork`/`lineage` context and is wired through single, parallel, and chain dispatch (both step
  types); async/background dispatch does not go through this path and is unaffected — tracked separately
  if it turns out to need the same treatment. Regression coverage: `shouldSkipContextFiles` unit tests,
  a `buildPiArgs` CLI-arg test, and updated integration fixtures across chain/parallel/fork-context suites.
- ~~**No-edits guard false-positives on read-only diagnostic dispatches**~~ — **resolved 2026-08-05.**
  `EXPLICIT_NO_EDIT_PATTERNS` only recognized "do not edit"-style wording; phrasing like the observed
  "edit nothing, quote a sentence from your context" matched nothing and fell through to the
  implementation-mutation default. `src/runs/shared/completion-guard.ts` now also recognizes "edit
  nothing", "make/making no edits", "without editing/making edits/making changes", and "no edits
  needed/required/necessary". Regression test reproduces the exact repro phrasing plus the new variants.
- **Subagent run transcripts (`<parent-id>/<hash>/run-N/session.jsonl`) are never pruned** — surfaced 2026-08-08.
  `getSubagentSessionRoot()` (`src/extension/index.ts:68`, mirrored in `fanout-child.ts:66`) derives a per-parent
  session base dir (`sessions/<parent>_<parentId>/`), and `subagent-executor.ts:2910` joins a `runId` onto it,
  then `sessionDirForIndex` (`:2921`) writes `<hash>/run-N/session.jsonl` under it. The dirs are created with
  `fs.mkdirSync` and **nothing ever removes them**: `cleanupOldArtifacts` (`src/shared/artifacts.ts:43`) sweeps
  only `subagent-artifacts/`, `cleanupOldChainDirs` (`src/shared/settings.ts:170`) sweeps only tmp chain dirs, and
  worktree sweeping touches only git branches. On this machine the leak is 36 dated dirs / 263 child-run dirs /
  399 `session.jsonl` files ≈ **411 MB**, and it grows one dir per subagent-spawning parent session, surviving even
  if the parent `.jsonl` is later deleted.
  **Proposed fix (M17, retention half):** extend the existing housekeeping pattern so run transcripts are covered.
  Add a `cleanupRunTranscripts(sessionsBase, maxAgeDays)` analog in `src/shared/artifacts.ts` that walks each
  dated dir, deletes child hashes whose run transcripts are older than `maxAgeDays` (reusing the marker-file
  rate-limit idiom from `cleanupOldArtifacts`), and also removes a dated parent dir once it has zero children AND
  its parent `.jsonl` is gone (true orphan). Wire it alongside the existing `cleanupAllArtifactDirs`/`cleanupOldChainDirs`
  startup call (`src/extension/index.ts:228`-`234`) and the `session_start` hook (`cleanupSessionArtifacts`, `:514`),
  gated by the same-or-new `modelLanes`-adjacent config defaulting to a conservative cutoff (e.g. 30 days).
  Conservative defaults: never delete children referenced by a still-open parent session; only prune by age, and
  only fully remove a dated dir when its parent `.jsonl` is verified absent. Regression: unit test on the walk/
  prune logic with a seeded temp layout, asserting both age cutoff and orphan-parent removal. — effort:S
  **Production half (also M17):** upstream's `artifactDir` (`project`/`session`/`temp`) plus
  `artifacts.includeTranscript` gating and a transcript byte cap stop the transcripts being written at this
  volume in the first place. Retention without production control just refills the disk more slowly.
## Deferred decisions

Settled by explicit user decision, not oversight. Revisit only if usage argues otherwise.

- **Stale lane deletes reject the whole batch** rather than being idempotent (decided 2026-07-31). If a
  lane you staged a delete against was removed externally, the entire staged batch is rejected and the
  session's other lane edits are lost. Chosen for loud drift detection over work preservation.
- **Lane undo is strict top-of-stack per role** rather than a per-role scan-and-splice (decided
  2026-07-31). With two roles interleaved, a role's older action stays unreachable until the newer
  other-role action is undone from its own view.
