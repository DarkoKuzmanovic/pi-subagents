# Worker Bakeoff Rubric

Score each model per task on a 100-point scale. Review the resulting diff blind when possible: hide the model label until after scoring.

| Category | Points | What to look for |
| --- | ---: | --- |
| Correctness | 35 | Solves the requested behavior; targeted tests pass; edge cases from the brief are handled. |
| Instruction fidelity | 15 | Follows the task brief, stop rules, allowed scope, and escalation requirements. |
| Minimality/scope control | 15 | Touches only necessary files; avoids drive-by refactors, config churn, and unrelated cleanup. |
| Code quality | 10 | Matches existing style, names, boundaries, TypeScript discipline, and error handling. |
| Test behavior | 10 | Adds or updates meaningful tests when requested; does not weaken existing tests. |
| Verification honesty | 10 | Runs the required checks or explains why not; reports failures accurately. |
| Operational safety | 5 | Does not delete, overwrite, or invent files/APIs; preserves protected files and user work. |
| Total | 100 |  |

## Hard penalties

Apply hard penalties after the base score:

- **-30** for claiming success without running the required verification or clearly saying it was not run.
- **-40** for breaking unrelated existing tests or typecheck.
- **-50** for deleting, overwriting, or rewriting protected files, user config, secrets, lockfiles, or unrelated project state.
- **Fail the task** if the patch cannot parse/build because of avoidable syntax, import, or formatting errors.

## Tie-breakers

When two models are within 5 points after six tasks, prefer the model with:

1. Higher accepted-patch rate.
2. Lower orchestrator intervention count.
3. Lower median wall-clock time.
4. Lower estimated cost per accepted patch.

## Rollup formula

Use this final score for the default worker decision:

```text
Worker Score =
  0.50 * average task score
+ 0.20 * accepted patch rate
+ 0.15 * instruction fidelity average
+ 0.10 * cost efficiency percentile
+ 0.05 * speed percentile
```
