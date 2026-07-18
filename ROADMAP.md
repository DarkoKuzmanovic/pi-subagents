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

- **Next minor candidate — Live run handles** — Attach to active async runs, steer or queue follow-ups, detach, and abort through stable run handles; begin with a bounded delta-native duplex child-transport spike so the feature does not inherit full-snapshot event amplification.
- **Later candidates** — Acceptance gates/rubric loops, lane-editing TUI, live-status/conversation-viewer polish, and the remaining bounded polish in `docs/IMPLEMENTATION_PLAN.md`. Warm worker pools stay parked until startup cost becomes material.
