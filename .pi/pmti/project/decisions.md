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
