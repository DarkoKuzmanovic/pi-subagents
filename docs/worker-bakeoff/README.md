# Worker Bakeoff

This directory defines a repeatable benchmark for choosing the default implementation `worker` model.

The benchmark compares:

- `mimo/mimo-v2.5-pro`
- `openai-codex/gpt-5.4-mini`
- `minimax/MiniMax-M2.7-highspeed`
- `crofai/glm-5.1-precision`

It is intentionally a **worker-subagent** test, not a general reasoning benchmark. We care about accepted diffs per dollar: correct implementation, scope control, safe behavior, and honest verification.

## Files

- `models.json` — exact candidate model set.
- `tasks/` — six implementation task classes to run against identical starting commits.
- `rubric.md` — 100-point scoring rubric and hard penalties.
- `scorecard.csv` — copy per-result scores here.
- `prompts/worker-bakeoff.md` — Pi prompt template for launching isolated model runs.

## Protocol

1. Pick one task brief from `tasks/` and bind it to a concrete repo target.
2. Ensure the working tree is clean.
3. Launch all four candidates from the same commit with `worktree: true`.
4. Let each worker run once. Do not coach individual models mid-run unless the benchmark case is explicitly measuring clarification behavior.
5. Run or inspect each candidate's verification output.
6. Score the diffs blind if possible.
7. Record results in `scorecard.csv`.
8. Repeat for all six tasks. Start with one pilot task if cost or quota is uncertain.

## Recommended sample size

Minimum useful run:

```text
4 models * 6 tasks = 24 runs
```

Better confidence:

```text
4 models * 6 tasks * 2 repeats = 48 runs
```

Use one repeat only after the first 24 runs identify a plausible top two.

## Acceptance decision

The winner is not necessarily the highest raw model. Prefer the model with the best blend of:

- accepted patch rate,
- average task score,
- low manual intervention,
- low dangerous-diff rate,
- cost per accepted patch.

Use the formula in `rubric.md` for the final worker routing decision.

## Cost-control notes

- Run a one-task pilot first.
- Cap each worker prompt to the same context files.
- Prefer `reads` or task files over dumping parent context.
- Do not run full test suites inside each candidate unless the task needs it; run full verification only for finalists.
