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

Tracked PMTI project state and milestone records were graduated into the canonical root files and remain recoverable from git history. They were moved out of the working tree to `/tmp/pi-subagents-crew-migrate-2026-07-18-removed/pmti-state/`.
