# PMTI Decisions

## 2026-06-01 — Initialize PMTI v1 for pi-subagents

**Decision:** Initialize `.pi/pmti/` in this repository and preserve existing `.pi/tasks/` artifacts read-only.

**Rationale:** The project already has legacy task scratch but no PMTI project state. The current TODO item is non-trivial, spans schema/runtime/TUI/tests, and benefits from milestone/task boundaries.

**Alternatives considered:**

- Continue with legacy `.pi/tasks/`: rejected for new planning because PMTI v1 is the current workflow.
- Bulk migrate all old `.pi/tasks/`: rejected for this pass to avoid mixing historical artifacts with the current TODO-derived milestone.

## 2026-06-01 — Default workspace strategy: current-branch

**Decision:** PMTI default workspace strategy is `current-branch`.

**Meaning:** Executors must confirm they are in the orchestrator-selected current branch/worktree before editing. Milestones may override this if isolation requirements change.

**Branch/worktree naming:** n/a for default. If a later milestone chooses a branch/worktree strategy, that milestone must name the expected branch/worktree pattern explicitly.

## 2026-06-01 — Oracle review pending by default for M0

**Decision:** Record oracle review as pending in the initial TODO-derived milestone and task packets rather than delegating immediately.

**Rationale:** The user requested scaffolding and task creation, not implementation or review execution. Oracle can be run later before PMTI implementation begins.

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