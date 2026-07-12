# Plan: "Acceptance gates" (rubric loops)

> **Version target: TBD.** This was originally drafted as the v0.41.0 headline, but v0.41.0
> shipped instead as the runaway-containment + regression-audit fixes (see `CHANGELOG.md`).
> The acceptance-gate design below remains **unbuilt**; retarget to a future minor when picked up.

Status: **design draft** (not started). Deferred from v0.40.0.
Base: v0.40.0. Prereq: structured output (v0.39.0) + async dynamic fanout (v0.40.0) already shipped.

## Why

The single highest-value missing primitive, and the one this fork *deliberately dropped* when
porting from upstream (see `PLAN-structured-output-fanout.md`: "Tiers 3 (acceptance gates) …
out of scope"). It is the convergent signal across the field — Anthropic's "Performance
Outcomes" (a grader sends each subagent back to revise until it meets a rubric) and the
consensus/quality-gate patterns in the swarm frameworks are the same idea. Today a `worker`
runs once and returns whatever it returns; nothing checks the result against a contract and
loops until it passes.

An acceptance gate makes a step's output subject to a **rubric**, graded by a **separate
grader agent**, and **re-runs the producing step with feedback** until it passes or a cap is hit.

## Mechanism (composes existing primitives — this is the point)

A gate reuses machinery already shipped, so this is largely orchestration, not new plumbing:

1. **Grader = a structured-output child.** The grader is an ordinary subagent given the
   producing step's output + the rubric, required to finish by calling `structured_output`
   with a `GateVerdict` (v0.39.0 structured output — no new capture mechanism).
2. **Loop = the chain executor re-dispatching a step.** On a failing verdict, re-run the
   producing step with the grader's feedback injected into its task, reusing the step's context
   mode. Bounded by `maxIterations`.
3. **Budget = the v0.40.0 session token ceiling.** A gate loop is the most token-hungry pattern
   in the system (producer + grader per iteration). It MUST consult the budget ceiling and stop
   iterating when the session budget is exhausted (`onExhausted` behavior below). This is the
   concrete synergy that justified shipping Tier 2 first.

## Authoring shape

Per-step `gate` on a `SequentialStep` (and, later, a parallel task):

```ts
{ chain: [
  { agent: "worker", task: "Implement the CSV export from {outputs.plan}",
    gate: {
      rubric: [
        "Exports all columns present in the source schema",
        "Handles empty result sets without throwing",
        "Has a test that covers the empty case",
      ],
      grader: "reviewer",            // optional; default builtin `grader` role
      maxIterations: 3,              // total producer attempts (>=1)
      threshold: 1.0,               // fraction of criteria that must pass (default 1.0 = all)
      onExhausted: "fail",          // fail | accept-last | accept-best
    },
  },
  { agent: "reviewer", task: "Summarize the shipped change" },
]}
```

- `rubric`: a checklist (array of criteria) or a single prose contract string.
- `grader`: agent name; defaults to a new read-only builtin `grader` role (fresh context,
  no edit tools) whose prompt is a strict rubric-scoring contract.
- `maxIterations`: total producer attempts (not retries-on-top); `1` disables looping (grade-once).
- `threshold`: pass when `passedCriteria / totalCriteria >= threshold`. Checklist gate =
  threshold `1.0`; score gate = a lower threshold.
- `onExhausted`: `fail` aborts the chain (default); `accept-last` continues with the final
  attempt; `accept-best` continues with the highest-scoring attempt.

## Grader contract (`GateVerdict`)

Fixed schema the grader must satisfy (validated exactly like any `outputSchema`):

```ts
{
  pass: boolean,
  score: number,                     // 0..1, = passedCriteria / totalCriteria
  criteria: Array<{ criterion: string, met: boolean, note?: string }>,
  feedback: string,                  // actionable, injected into the next producer attempt
}
```

On a failing verdict the next producer attempt gets an injected preface:
`"A prior attempt was rejected by the acceptance gate. Unmet criteria: <list>. Reviewer
feedback: <feedback>. Address these specifically."` — mirroring the existing `{previous}`/read
instruction injection, so no new prompt-assembly path.

## Loop semantics

```
attempt = 1
loop:
  run producing step (attempt 1: normal task; attempt >1: task + injected feedback)
  if budget exhausted -> apply onExhausted, stop
  run grader child (step output + rubric) -> GateVerdict (structured)
  if verdict.pass (score >= threshold) -> publish step output under `as`, continue chain
  if attempt == maxIterations -> apply onExhausted, stop
  attempt += 1
```

- The **graded** step output is what publishes under `as` / feeds `{previous}` — a rejected
  attempt never leaks downstream (same success-gating as `isStorableStepResult`).
- `accept-best` requires retaining each attempt's output + score; `accept-last` retains only
  the final; `fail` aborts with a summary of the last verdict.

## Phases

### Phase 0 — Types + grader role (no behavior change)
- `src/shared/settings.ts`: `GateSpec` on `SequentialStep`; `GateVerdict` schema constant.
- New builtin `agents/grader.md` (fresh context, read-only tools, strict scoring prompt).
- Study upstream's Tier 3 implementation as a reference (it exists; we chose not to port it).

### Phase 1 — Foreground grade-once (`maxIterations: 1`)
- `src/runs/foreground/chain-execution.ts`: after a gated step, spawn the grader as a
  structured-output child, attach the verdict, fail the step if it doesn't pass. No looping yet.
- Reuse `createStructuredOutputRuntime` + `readStructuredOutput` for the grader.
- Tests: pass-through on met rubric; step fails on unmet rubric; grader schema-invalid handling.

### Phase 2 — Foreground loop + feedback injection
- Add the re-dispatch loop, feedback injection, `threshold`, `onExhausted`.
- Wire the v0.40.0 token-budget ceiling as a loop guard.
- Emit `gate.attempt` / `gate.verdict` / `gate.passed` / `gate.exhausted` events; show the
  attempt count in live progress.
- Tests: converges on attempt N; exhausts to each `onExhausted` mode; budget cutoff mid-loop.

### CHECKPOINT — foreground green before async.

### Phase 3 — Async parity
- Port the proven loop into `subagent-runner.ts`. Sequential-step gates first. The runner
  already re-runs single steps; the loop is a bounded wrapper around `runSingleStep` + a grader
  `runSingleStep`. Verify via the mock-`pi` harness (grader emits a `GateVerdict` via the
  structured-capture path the mock already supports as of v0.40.0).

## Composition / out of scope (deferred)
- **Gating dynamic-fanout items** (a rubric per expanded item). Natural follow-up; scope v1 to
  sequential steps, then parallel tasks.
- **Multi-grader panels / consensus** (N graders, majority vote) — a later enhancement once the
  single-grader loop is proven; this is where the "diverse-lens verify" pattern would land.
- **`.chain.md` gate syntax** — JSON/`.chain.js` only at first, matching structured output.

## Risks
- **Token blow-up** is the headline risk; mitigated by `maxIterations`, the budget ceiling, and
  loud per-attempt cost logging. Never loop unbounded.
- **Grader flakiness / grade drift**: a lenient grader passes bad output; a strict one never
  converges. Mitigate with a crisp `grader` contract prompt, `threshold`, and `onExhausted:
  accept-best` as an escape hatch.
- **Async index bookkeeping**: gate re-runs reuse one flat slot (unlike fanout's runtime
  splicing), so the async lift is lower-risk than v0.40.0 — attempts overwrite the same status
  step with an incrementing `attempt` field.

## Acceptance
- Foreground: a gated `worker` step that fails the rubric on attempt 1 and passes on attempt 2,
  with the grader feedback visibly injected into attempt 2, and only the passing output feeding
  downstream. Async parity via the mock harness. `onExhausted` modes covered. Typecheck + unit +
  integration green; README + CHANGELOG; version bump to 0.41.0.
