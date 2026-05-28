# Scout bakeoff scoring rubric

Use this rubric after each scout run. Score what the scout actually delivered, not how confident it sounded. Prefer verifiable citations over polished prose.

| Category | Points | What earns full credit |
|---|---:|---|
| Precision and factual accuracy | 30 | Claims match the repository, names are exact, no hallucinated files/symbols/commands, uncertainty is explicit. |
| Coverage of relevant surface area | 20 | Finds the important entry points, adjacent modules, tests, config/docs, and at least one non-obvious coupling for the task. |
| Traceability and evidence | 15 | Cites concrete file paths, symbols, commands, and line/section references where available; separates facts from inference. |
| Signal-to-noise and brevity | 15 | Produces a compact handoff a worker can use directly; avoids broad dumps, generic advice, and redundant narration. |
| Speed | 10 | Finishes quickly relative to the cohort on the same task. Use percentile ranking: fastest gets 10, slowest gets 0, interpolate or rank manually. |
| Cost efficiency | 10 | Use observed provider/request economics if available. If exact pricing is unknown, score from the user's quota impact or mark neutral `5` until manual math is added. |
| Total | 100 |  |

## Hard penalties

Apply hard penalties after category scoring:

- **-50** for mutating the repository, writing files, running destructive commands, or attempting implementation instead of read-only reconnaissance.
- **-40** for fabricating important evidence: nonexistent files, symbols, commands, tests, or source relationships that materially affect the decision.
- **-25** for missing the main entry point or recommending a wrong subsystem when the task has clear evidence in the repo.
- **-20** for ignoring explicit output constraints such as line limit, required sections, or read-only scope.
- **-15** for excessive context dumping that would force the parent/worker to re-scout the task.

Scores bottom out at 0.

## Scout Score rollup

For a model across all scout tasks:

```text
Scout Score =
  0.45 * average rubric score
+ 0.20 * precision average
+ 0.15 * speed percentile
+ 0.10 * cost efficiency percentile
+ 0.10 * accepted handoff rate
```

`accepted handoff rate` is the share of scout outputs the parent would hand to a worker without re-running reconnaissance.

## Pricing notes

Do not guess exact prices in the rubric. Record raw metrics and owner-supplied pricing separately in `scorecard.csv`:

- wall-clock time
- request/turn count if available
- provider quota pool notes
- manual cost estimate
- cost-efficiency score

For `openai-codex/gpt-5.3-codex-spark`, call out that it may share quota with other OpenAI Codex agents; score its cost only after the owner decides how to value that shared pool.
