# Roadmap

**Status:** active

## Released

- **v0.41.0** — Runaway containment, interrupt semantics, budget accounting, model fallback, sequential single-pass template rendering, and validation hardening.
- **v0.41.1** — Completed single-pass rendering across chain modes, corrected control/config behavior, and added regression hardening from the v0.41.0 review.
- **v0.42.0** — Made stream-budget accounting delta-aware and credited parsed JSON bytes so snapshot amplification no longer false-kills coherent runs.
- **v0.42.1** — Changed the 1 GiB raw backstop to measure cumulative unaccounted/unparsed bytes, preserving protection against genuine raw floods without charging fully parsed amplified streams.

## Current

- **v0.42.2** — Restore chain-default clarify precedence: chains background only with `clarify: false`; add the missing routing truth-table regression before changing the one owning expression.

## Planned

- **Future minor candidates** — Acceptance gates/rubric loops, lane-editing TUI, warm worker processes, mid-run steering, attach/detach UX, and the remaining bounded polish in `docs/IMPLEMENTATION_PLAN.md`. Candidates are not authorized implementation work.
