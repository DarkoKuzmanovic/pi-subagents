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

- **README–code drift: `--no-context-files` for fresh children is documented but unwired** (found 2026-08-02).
  The README's fork-changes section claims fresh-context children spawn with `--no-context-files`. In code,
  the flag is only pushed when `skipContextFiles` is set (`src/runs/shared/pi-args.ts`), which only happens
  from `inlineReads === true` in chain paths — and nothing in the codebase sets `inlineReads`. Verified
  empirically: fresh worker children quoted same-day-authored sentences from both global `AGENTS.md` and
  `APPEND_SYSTEM.md` verbatim, so full global context reaches fresh children. Impact: fresh children carry
  the driving-seat context the feature was meant to strip, and the README misdescribes runtime behavior.
  Not fixed on discovery because it surfaced in a prompt-stack audit session and needs a decision first —
  wire the flag (restore isolation) or fix the README (bless inheritance) — plus a spawn-args regression test.
- **No-edits guard false-positives on read-only diagnostic dispatches** (found 2026-08-02, observed 4×).
  Workers dispatched with explicitly read-only probe tasks ("edit nothing, quote a sentence from your
  context") complete correctly, but the run is reported failed ("completed without making edits for an
  implementation task"). The guard assumes every worker dispatch is an implementation task. Same scoping
  reason for deferral; candidate fix is a diagnostic/read-only dispatch flag or task-text intent detection,
  with the failure signal downgraded to informational for such runs.
## Deferred decisions

Settled by explicit user decision, not oversight. Revisit only if usage argues otherwise.

- **Stale lane deletes reject the whole batch** rather than being idempotent (decided 2026-07-31). If a
  lane you staged a delete against was removed externally, the entire staged batch is rejected and the
  session's other lane edits are lost. Chosen for loud drift detection over work preservation.
- **Lane undo is strict top-of-stack per role** rather than a per-role scan-and-splice (decided
  2026-07-31). With two roles interleaved, a role's older action stays unreachable until the newer
  other-role action is undone from its own view.
