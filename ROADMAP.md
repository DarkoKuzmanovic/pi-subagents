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

## Current

## Planned

- **M13** — Acceptance gates and bounded rubric-driven revision loops

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
## Deferred decisions

Settled by explicit user decision, not oversight. Revisit only if usage argues otherwise.

- **Stale lane deletes reject the whole batch** rather than being idempotent (decided 2026-07-31). If a
  lane you staged a delete against was removed externally, the entire staged batch is rejected and the
  session's other lane edits are lost. Chosen for loud drift detection over work preservation.
- **Lane undo is strict top-of-stack per role** rather than a per-role scan-and-splice (decided
  2026-07-31). With two roles interleaved, a role's older action stays unreachable until the newer
  other-role action is undone from its own view.
