# Decisions

Append-only project decisions. Historical workflow decisions remain here even when superseded.

## 2026-06-01 — Initialize PMTI v1 for pi-subagents

**Decision:** Initialize `.pi/pmti/` in this repository and preserve existing `.pi/tasks/` artifacts read-only.

**Rationale:** The project already has legacy task scratch but no PMTI project state. The current TODO item is non-trivial, spans schema/runtime/TUI/tests, and benefits from milestone/task boundaries.

**Alternatives considered:**

- Continue with legacy `.pi/tasks/`: rejected for new planning because PMTI v1 is the current workflow.
- Bulk migrate all old `.pi/tasks/`: rejected for this pass to avoid mixing historical artifacts with the current TODO-derived milestone.

**Status:** Superseded on 2026-07-18 by the root Crew convention and historical archive.

## 2026-06-01 — Default workspace strategy: current-branch

**Decision:** PMTI default workspace strategy is `current-branch`.

**Meaning:** Executors must confirm they are in the orchestrator-selected current branch/worktree before editing. Milestones may override this if isolation requirements change.

**Branch/worktree naming:** n/a for default. If a later milestone chooses a branch/worktree strategy, that milestone must name the expected branch/worktree pattern explicitly.

**Status:** Superseded on 2026-07-18 for Crew runs by `crew/m<n>-<slug>` run branches; branch/worktree preflight remains an invariant.

## 2026-06-01 — Oracle review pending by default for M0

**Decision:** Record oracle review as pending in the initial TODO-derived milestone and task packets rather than delegating immediately.

**Rationale:** The user requested scaffolding and task creation, not implementation or review execution. Oracle can be run later before PMTI implementation begins.

**Status:** Historical; M0 is complete.

## 2026-06-01 — Thinking representation for M0

**Decision:** Carry inline `thinking?` as a first-class field through schema/type and behavior-resolution surfaces, then normalize it to Pi's existing model-suffix representation at the child-session argument boundary.

**Rationale:** Existing hub/chain-clarify paths already use known `:level` suffixes on model strings, but tool and chain/parallel dispatch need an explicit field so precedence is clear. A single normalization boundary prevents competing mechanisms.

**Implementation requirement:** `src/shared/settings.ts` owns chain/parallel behavior resolution and must carry `thinking` through `StepOverrides`, `SequentialStep`, `ParallelTaskItem`, `ResolvedStepBehavior`, and `resolveStepBehavior`. Runtime normalization must strip any existing known suffix before applying an inline value, including `off`.

## 2026-06-06 — M1 model lane and roster simplification

**Decision:** Represent light/medium/heavy implementation routing as named `subagents.modelLanes` for the primary `worker` role instead of keeping separate visible `worker-light` and `worker-heavy` builtins.

**Rationale:** Lane overrides keep model selection explicit at dispatch time while reducing the visible role roster to durable responsibilities. Compatibility agent files remain available for opt-in overrides and reference, but default discovery and list output should focus on six roles.

**Implementation requirement:** Disabled compatibility agents stay parseable through `discoverAgentsAll`; normal `discoverAgents` and management list output hide them unless explicitly re-enabled. Public guidance should route local/web recon through `recon`, synthesis through `reviewer`, test-focused implementation through `worker`, and cleanup through `janitor`.

**Future work:** A lane-editing TUI is deferred until the JSON control plane has baked in real use.

## 2026-07-10 — Pi 0.80.6 `max` thinking compatibility is a maintenance patch

**Decision:** Add Pi 0.80.6's opt-in `max` thinking level across pi-subagents without reopening completed M0 or creating a new PMTI milestone.

**Rationale:** M0's scope-out bounded that June 2026 milestone and the roadmap now has no active milestone. Pi 0.80.6 added `max` as a public thinking level after M0 closed. Updating only `models.json` would leave pi-subagents' schema, suffix normalization, model capability filtering, and selectors unable to dispatch the new level end to end.

**Alternatives considered:**

- Config-only model mappings: rejected because `subagent({ thinking: "max" })` would remain rejected or mishandled.
- Open a new M3 milestone: rejected for this bounded compatibility patch; the existing task plan and focused regression suite are sufficient.

## 2026-07-18 — Restore chain-specific async-by-default routing

**Decision:** For M11/v0.42.2, restore the chain-specific gate `requestedAsync && (hasChain ? clarify === false : clarify !== true)` rather than changing downstream execution semantics.

**Rationale:** The `c567660` merge collapsed chains into the single/parallel rule, allowing user config `asyncByDefault: true` to bypass the documented chain-default clarify UI. Explicit chain background execution continues to require `clarify: false`.

## 2026-07-18 — Retain native process isolation and API shape

**Decision:** Prefer warmed separate child processes over in-process sessions if startup latency becomes material; keep the native `subagent` API rather than adding Claude Code-style aliases; keep `MemoryScope` type-only while it remains a pure type.

**Rationale:** Separate processes preserve crash isolation, aliases would create two mental models for the same API, and a runtime `MemoryScope` import would be incorrect while no runtime value exists.

## 2026-07-18 — Adopt the canonical Crew state convention

**Decision:** Strategic milestones live in root `ROADMAP.md`, current tactical execution lives only in a transient root `PLAN.md`, design prose lives under `docs/`, decisions live here, and brainstorm backlog lives in root `IDEAS.md`. Status is derived; no planning state directory is maintained.

**Rationale:** The root files and `.pi/pmti/` had become competing state stores. A single parseable Markdown convention plus git history removes the possibility of divergent stored status.

## 2026-07-18 — Preserve M6 numbering for durable async OM lineage

**Decision:** Keep the v0.41.0 durable async OM milestone as M6 rather than renumbering it to fill M3–M5; leave those IDs unused.

**Rationale:** Durable async OM source markers already identify their foundation as M6.1. Renumbering the roadmap would sever that lineage, while canonical `M<n>` IDs are not required to be contiguous.

## 2026-07-24 — Warn before the run wall-clock deadline rather than kill-with-grace after it

**Decision:** `timeoutAction` now governs the run wall-clock deadline as well as step inactivity. Under `escalate_then_kill` the `timed_out_escalating` nudge fires one `escalationGraceMs` *before* the deadline; the deadline itself stays a synchronous hard stop. Under `notify` the deadline becomes advisory everywhere — no kill, no dispatch gating. `timed_out_escalating` joins the default `notifyOn` set.

**Rationale:** The schema documented `timeoutAction` as "action on timeout", but only the step-inactivity path consulted it; the run deadline killed unconditionally. A merely-slow child was destroyed with its whole context and the parent got a corpse instead of a warning it could act on with `wrap-up`.

**Alternatives considered:**

- *Post-deadline grace window (nudge at the deadline, kill `escalationGraceMs` later):* implemented first, then rejected. It broke five existing integration tests that assert the shared deadline stops dispatch **synchronously**, and it was incoherent besides — the deadline also terminates queued work and marks the run `failed`, so the grace window would leave children running against durable failed state.
- *Leaving the pre-flight checks (run entry, between model-fallback attempts) unconditional:* rejected. `notify` would then appear to work until model fallback engaged, at which point the run would die anyway. Half-gating is less predictable than either extreme.
- *Leaving `notifyOn` defaults alone:* rejected. `appendControlEvent` filters on `notifyOn`, so the new nudge would have been dropped before reaching anyone and the change would have shipped as a no-op.

**Accepted cost:** `timeoutAction: "notify"` removes the run-duration backstop entirely. Documented in README, CHANGELOG, and the tool schema; `interrupt` is the stated way to stop such a run.
