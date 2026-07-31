# Legacy planning archive

This directory preserves historical planning and execution evidence migrated from ignored state directories on 2026-07-18.

It is **not active project state**. Current strategic state lives in root `ROADMAP.md`; root `PLAN.md` exists only while a Crew build is in flight. Decisions live in root `DECISIONS.md`, and uncommitted product ideas live in root `IDEAS.md`.

## Preserved sources

| Source | Destination | Files | Bytes | Pre/post-move tree SHA-256 |
|---|---|---:|---:|---|
| `.pi/pmti/tasks/` | `pmti-task-packets/` | 16 | 52,600 | `2a7412632b0a530d45beca650fc4b0e5e44394cffafd7ee1924a200fc5c3c5e2` |
| `.pi/tasks/` | `legacy-tasks/` | 30 | 191,343 | `ee0788a4946d1e534c825fdc9b2f8c3853857716f0f6c9f7bf4f2ac2439a1f0a` |
| `pre-plan.md` | `pre-plan-upstream-adoption-2026-05-28.md` | 1 | 6,718 | Renamed without content changes |

The two directory tree hashes matched before and after relocation. `SHA256SUMS` records every preserved file at its canonical archive path.

## Completed build plans

Root `PLAN.md` exists only while a build is in flight; at release close-out it is archived here rather
than deleted, so the reasoning behind a shipped milestone stays recoverable. Each plan carries its own
close-out record (gates run, review findings, decisions deferred and why).

| Archived plan | What it covered | Shipped in | Archived |
|---|---|---|---|
| `PLAN-0.44.0-tui-revamp.md` | `/subagents` hub rebuilt as a Pi-style themed TUI | v0.44.0 | 2026-07-31 |
| `PLAN-0.44.0-subagent-hub-fixes.md` | Hub data-loss and dirty-tracking fixes from a 3-reviewer pass | v0.44.0 | 2026-07-31 |
| `PLAN-M12.4-review-hardening.md` | Async file modes, recovery state, non-null assertion sweep | v0.44.2 | 2026-07-30 |
| `PLAN-M2-lane-editing-tui.md` | M2 — lane-editing TUI over user-scope `subagents.modelLanes` | v0.45.0 | 2026-07-31 |

The two `0.44.0` plans were left in the repository root after that release and were archived on
2026-07-31 during the M2 close-out. `SHA256SUMS` now covers all four (51 entries total, verified with
`sha256sum -c SHA256SUMS`).

Tracked PMTI project state and milestone records were graduated into the canonical root files and remain recoverable from git history. They were moved out of the working tree to `/tmp/pi-subagents-crew-migrate-2026-07-18-removed/pmti-state/`.
