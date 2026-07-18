# Plan: v0.40.0 — "Async parity & cost control"

Base: `main` @ `f045666` (v0.39.0). Branch: `claude/pi-subagents-0.40.0`.

## Theme & decision

The weakest seam in the codebase is the **background/async path**, and it is exactly where
token cost and un-observed failures concentrate. v0.39.0 shipped structured output + dynamic
fanout in the **foreground only**; the single remaining `TODO` in the tree is async fanout.
There is **no cost ceiling** anywhere — a fan-out can burn unbounded tokens with the parent
detached.

v0.40.0 closes that seam and adds a spend guard. It is deliberately **focused**: the big-design
item (acceptance gates / rubric loops) is teed up for v0.41.0, not crammed here.

**Scope is verified against source, not assumed.** Two candidate items were dropped after
checking the code:
- *Async model fallback* — already implemented (`subagent-runner.ts:696`,
  `async-execution.ts:389`). Not a gap.
- *Inline `thinking` per dispatch* — already in `schemas.ts` for single/parallel/chain
  (lines 52/69/88/200). Only the interactive TUI selector remains (Tier 4).

## Tiers

### Tier 1 (headline) — Async dynamic fanout parity
Lift the guard at `src/runs/background/async-execution.ts:292` (`TODO(async-fanout)`). The
foreground mechanism is proven (v0.39.0); this ports it into the diverged background runner.
Steps are already scoped in `PLAN-structured-output-fanout.md` (§ "Follow-up"):

1. **Extract the inline ~170-line parallel executor** in `subagent-runner.ts` (`mapConcurrent`
   + per-task `statusPayload.steps[fi]` writes + intercom + completion/interrupt) into a
   reusable function callable for both static groups and runtime-materialized dynamic groups.
2. **Runtime splicing of the index arrays.** Materialized items have no pre-baked slots, so
   insert N entries into `statusPayload.steps`, `stepEscalationStartedAt`, and `parallelGroups`
   at the live flat index — keeping every *later* step's index resolvable.
3. **Runtime resource minting + launcher deferral.** Mint session files / artifact dirs per
   materialized item; teach `async-execution.ts` (which pre-bakes session files, intercom
   targets, and parallel groups before spawn) to **defer** those allocations for dynamic steps.

**Acceptance:** a live detached async chain whose step 1 emits a structured array and step 2
fans out via `expand`/`collect`, feeding a `{outputs.<collect.as>}` consumer — green. This
**cannot be proven by unit tests**; it needs live async runs plus a new integration harness
that drives a detached run to completion and asserts the collected array. When green, remove
the guard and drop the "foreground only" caveat from README + CHANGELOG.

**Risk:** highest-conflict diverged zone. Gate the rest of the release behind Tier 1 landing
green; if it slips, Tiers 2–4 still ship as v0.40.0 and Tier 1 moves to 0.40.1.

### Tier 2 — Session token-budget ceiling
No budget primitive exists today (`session-tokens.ts` only *records* usage). Add an opt-in
spend ceiling that halts further fan-out/step dispatch when hit.

- **Config:** `sessionTokenBudget?: number` (output tokens) in `ExtensionConfig`
  (`src/extension/config.ts`, `src/shared/types.ts`), plus per-call override
  `budget?: number` on the `subagent` params (`schemas.ts`).
- **Accounting:** extend `src/shared/session-tokens.ts` with a running `spent()` accumulator
  fed by the existing `usage.ts` totals across foreground + async runs (shared pool, keyed by
  session id).
- **Enforcement point:** before each new step / materialized fan-out task is spawned, check
  `remaining()`; when exhausted, stop dispatching new work, mark remaining steps
  `skipped(budget-exhausted)`, and surface a clear footer. Never kill in-flight children.
- **Observability:** emit a `subagent:budget-exhausted` event and include
  `[budget: spent/total]` in the result footer (reuse the token-footer seam).

**Acceptance:** a chain with a low budget stops dispatching after the ceiling, reports skipped
steps, and never truncates a running child. Unit-testable against the accumulator + a fake
dispatcher.

### Tier 3 — Housekeeping (dead-weight removal)
- **Relocate/prune the 8 disabled compat agents** (`scout`, `researcher`, `synthesizer`,
  `test-writer`, `worker-heavy`, `worker-light`, `oracle-fresh`, `deslopper`). Move to
  `agents/legacy/` (still discoverable via override) or drop entirely. Update README's
  "Compatibility agents" note. Keep `janitor`'s honor intact by not leaving orphans.
- **Move completed root plans** `PLAN-0.38.2.md`, `PLAN-structured-output-fanout.md` (and this
  file, on release) into `docs/plans/`. Root should not accumulate finished plans.
- **Reconcile the `maxSubagentDepth` docs**: README config default says `2`; agent-frontmatter
  default is `1`. State both precisely in one place.

### Tier 4 (small win) — Thinking selector in the launch TUI
Inline `thinking` dispatch already works; the remaining piece from the historical thinking request is the
interactive selector. Add a `t`-key thinking picker to the `/subagents` hub / clarify launch
(`src/tui/subagent-hub.ts`, `src/runs/foreground/chain-clarify.ts`) that shows the effective
level and passes an override through to spawn. Low risk, self-contained.

## Out of scope (deferred, with rationale)
- **Acceptance gates / rubric loops (upstream Tier 3).** The deliberately-dropped feature and
  the highest-value missing primitive (≈ Anthropic "Performance Outcomes"). Deserves its own
  release — proposed **v0.41.0 headline**. Needs design: gate schema (`gate: {rubric,
  maxIterations, grader}`), re-dispatch loop, and convergence/stop conditions. Spike only if
  Tier 1 lands early.
- **Shared/queryable cross-agent memory.** Per-agent `MEMORY.md` already exists
  (`src/shared/memory.ts`); a shared retrievable store (vs RuFlo/LangGraph) is a larger design.
- **OpenTelemetry / Langfuse trace export.** Pairs naturally with Tier 2 but is additive; defer.
- **`.chain.md` structured-output parity** (`outputSchema`/`as` in markdown chains). Unchanged
  from v0.39.0's deferral.

## Verification gates (whole release)
- `npm run typecheck` clean; `npm test` (unit) + `npm run test:integration` green.
- New tests: async-fanout integration (live detached run), budget accumulator + enforcement
  unit tests, housekeeping discovery snapshot.
- README + CHANGELOG updated; `package.json` bumped to `0.40.0`.

## Sequencing
Tier 1 first (it gates the theme and is the riskiest). Tiers 2–4 are independent and can land
in any order; ship whatever is green at cut. If Tier 1 slips, release Tiers 2–4 as 0.40.0 and
move async fanout to 0.40.1.
