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

- **Fanout ordering race in the integration suite** — parallel children race over which materialized
  index directory they claim, so a different test in the `namespaces inherited default outputs` family
  fails intermittently under full-suite concurrency (`test/integration/async-dynamic-fanout.test.ts`,
  `test/integration/async-execution.test.ts`). Isolated runs always pass. Proven **pre-existing** during
  M2 by running the full suite in a pristine `HEAD` worktree containing no M2 code: it failed the same
  family 2-of-2 runs. Not bundled into M2 because it predates that work and would have muddied the
  three-model review diff. Fixing it means making index-directory assignment deterministic rather than
  first-come. — effort:M
- **139 broader-form non-null assertions repo-wide** — `AGENTS.md` bans non-null assertions, but the
  M12.4 sweep only covered the 24 `!.` dot-access occurrences; the `!(`, `![`, and `!,` forms remain.
  Scoped out of M12.4 deliberately rather than missed. Per-file concentrations and the regression-risk
  assessment live in `IDEAS.md` — keep the detail there, not duplicated here. — effort:M
- **`setFilter` missing from the pi-tui test shim** — declared in `test/support/shims/pi-tui.d.ts` but
  unimplemented in `test/support/ts-loader.mjs`, so a future call would typecheck and then fail at test
  runtime. Same class of gap as the `SelectList.handleInput` no-op closed during M2, which had been
  hiding a wrong-lane-deletion bug. Worth auditing the whole shim against the real component surface
  rather than fixing this one method. — effort:S

## Deferred decisions

Settled by explicit user decision, not oversight. Revisit only if usage argues otherwise.

- **Stale lane deletes reject the whole batch** rather than being idempotent (decided 2026-07-31). If a
  lane you staged a delete against was removed externally, the entire staged batch is rejected and the
  session's other lane edits are lost. Chosen for loud drift detection over work preservation.
- **Lane undo is strict top-of-stack per role** rather than a per-role scan-and-splice (decided
  2026-07-31). With two roles interleaved, a role's older action stays unreachable until the newer
  other-role action is undone from its own view.
