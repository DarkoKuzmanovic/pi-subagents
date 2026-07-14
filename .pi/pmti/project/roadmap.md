# PMTI Roadmap — pi-subagents

## Current milestone

No active PMTI milestone is currently open. M0 and M1 are closed in `.pi/pmti/project/changes-log.md`; M2 remains an inactive planned candidate with no task packet or implementation started.

## Completed milestones

### M0 — Thinking level dispatch controls

Exposed `thinking` level as a per-dispatch override in the `subagent` tool and `/subagents` TUI, with precedence `inline > agentOverrides > agent file > session default` and tests proving single, chain, parallel, and TUI paths.

**Source:** `TODO.md` entry requested 2026-06-01.

### M1 — Model lanes, JSON shortcut, and six-role roster

Added named model lanes, lane dispatch propagation, `/subagents config|json|edit`, and the six-role visible builtin roster (`recon`, `planner`, `worker`, `reviewer`, `oracle`, `janitor`). Compatibility agent files remain preserved but disabled by default.

**Source:** PMTI continuation requested 2026-06-05 from session 019e97b9-50a5-79a0-bd2c-11d80a0ca406.

## Later candidate milestones

### Legacy task context triage

Review existing `.pi/tasks/` histories and decide whether any durable lessons should be promoted into PMTI project decisions, watch items, or future milestone candidates.

### Subagent UX and orchestration polish

Use post-M0/M1 feedback to improve `/subagents` discoverability, dispatch previews, lane ergonomics, and safe defaults without changing runtime semantics unexpectedly.

### Lane-editing TUI

M2 is drafted but inactive: design a first-class lane-editing TUI only after explicit reprioritization. No task packet or implementation has started.

## Phase-boundary notes

- M0 is coherent because it finishes one user-visible capability across API, runtime, TUI, and verification.
- M1 is coherent because it finishes model-lane routing, the JSON editing shortcut, and the default six-role roster as one product-facing simplification.
- Legacy task migration and lane-editing UI remain intentionally separate so they do not block the completed lane/roster milestone.
