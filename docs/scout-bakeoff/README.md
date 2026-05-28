# Scout bakeoff

This kit compares candidate models for the `scout` subagent role: fast, cheap, precise codebase reconnaissance that produces worker-ready handoffs without editing files.

## Candidates

See `models.json` for the canonical model list:

1. `minimax/MiniMax-M2.7-highspeed`
2. `crofai/qwen03.5-9b`
3. `crofai/greg-1-mini`
4. `crofai/kimi-k2.5-lightning`
5. `openai-codex/gpt-5.3-codex-spark`

Provider names are normalized to the lowercase form used by Pi model IDs.

## Protocol

1. Pick one task from `tasks/` and bind it into a concrete read-only prompt.
2. Launch all candidates with `agent: "scout"`, `context: "fresh"`, and identical task text.
3. Keep `worktree: false` by default because scout tasks are read-only and speed is part of the metric. If a model mutates the repo anyway, apply the hard penalty.
4. Do not coach a candidate mid-run.
5. Score with `rubric.md` and append one row per model to `scorecard.csv`.
6. Treat a single task as a smoke test only. Use all five tasks before changing the default scout model.

## What to measure

- Wall-clock time from launch to completion.
- Whether the brief can be handed to a worker without re-scouting.
- Factual precision of paths, symbols, tests, and flow descriptions.
- Noise level: whether the parent has to read around generic filler.
- Manual cost/quotas if known. Pricing is intentionally a scorecard field, not guessed in the rubric.

## Decision rule

Choose the scout model with the best combination of:

- high average rubric score,
- low hallucination rate,
- high accepted handoff rate,
- low wall-clock time,
- acceptable quota/cost impact.

If `openai-codex/gpt-5.3-codex-spark` wins speed but consumes a scarce shared Codex quota pool, keep it as an opt-in fast scout and choose the best cheap CrofAI/MiniMax model as the default.
