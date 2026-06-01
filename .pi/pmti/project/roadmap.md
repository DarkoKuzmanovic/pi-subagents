# PMTI Roadmap — pi-subagents

## Current milestone

### M0 — Thinking level dispatch controls

Expose `thinking` level as a per-dispatch override in the `subagent` tool and `/subagents` TUI, with precedence `inline > agentOverrides > agent file > session default` and tests proving single, chain, parallel, and TUI paths.

**Source:** `TODO.md` entry requested 2026-06-01.

## Later candidate milestones

### M1 — Legacy task context triage

Review existing `.pi/tasks/` histories and decide whether any durable lessons should be promoted into PMTI project decisions, watch items, or future milestone candidates.

### M2 — Subagent UX and orchestration polish

Use post-M0 feedback to improve `/subagents` discoverability, dispatch previews, and safe defaults without changing runtime semantics.

## Phase-boundary notes

- M0 is coherent because it finishes one user-visible capability across API, runtime, TUI, and verification.
- M1 is intentionally separate so historical task migration does not block the active TODO item.
- M2 depends on the new thinking controls being stable enough to observe in real use.
