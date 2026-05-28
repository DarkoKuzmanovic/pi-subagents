---
description: Compare scout models on read-only reconnaissance speed, cost, and precision
---

Run a scout-subagent bakeoff for the task below. Compare the same read-only reconnaissance task across the five candidate scout models, using fresh isolated contexts and the rubric in `docs/scout-bakeoff/rubric.md`.

Candidate models:

- `minimax/MiniMax-M2.7-highspeed`
- `crofai/qwen03.5-9b`
- `crofai/greg-1-mini`
- `crofai/kimi-k2.5-lightning`
- `openai-codex/gpt-5.3-codex-spark`

## Parent protocol

1. Bind the task to one concrete brief from `docs/scout-bakeoff/tasks/`.
2. Launch the five candidates with identical prompts, `agent: "scout"`, `context: "fresh"`, and `worktree: false`.
3. Keep the task read-only. If a candidate writes or mutates files, record the mutation and apply the hard penalty.
4. Do not provide mid-run coaching.
5. After completion, inspect each output, measure wall-clock time, count obvious tool/turn usage if available, and score with `docs/scout-bakeoff/rubric.md`.
6. Append one row per candidate to `docs/scout-bakeoff/scorecard.csv`.
7. Leave manual pricing blank or neutral if exact pricing/quota impact is unknown.

## Dispatch shape

Use this shape for one benchmark task. Replace `<TASK-ID>` and `<BOUND-SCOUT-BRIEF>` before launching.

```typescript
subagent({
  tasks: [
    {
      agent: "scout",
      model: "minimax/MiniMax-M2.7-highspeed",
      task: `<BOUND-SCOUT-BRIEF>`,
      output: "scout-bakeoff/<TASK-ID>/minimax-highspeed.md",
      progress: false,
    },
    {
      agent: "scout",
      model: "crofai/qwen03.5-9b",
      task: `<BOUND-SCOUT-BRIEF>`,
      output: "scout-bakeoff/<TASK-ID>/qwen035-9b.md",
      progress: false,
    },
    {
      agent: "scout",
      model: "crofai/greg-1-mini",
      task: `<BOUND-SCOUT-BRIEF>`,
      output: "scout-bakeoff/<TASK-ID>/greg-mini.md",
      progress: false,
    },
    {
      agent: "scout",
      model: "crofai/kimi-k2.5-lightning",
      task: `<BOUND-SCOUT-BRIEF>`,
      output: "scout-bakeoff/<TASK-ID>/kimi-lightning.md",
      progress: false,
    },
    {
      agent: "scout",
      model: "openai-codex/gpt-5.3-codex-spark",
      task: `<BOUND-SCOUT-BRIEF>`,
      output: "scout-bakeoff/<TASK-ID>/codex-spark.md",
      progress: false,
    },
  ],
  concurrency: 5,
  context: "fresh",
  worktree: false,
})
```

## Bound scout brief template

```text
Benchmark task: <TASK-ID> / <TASK-NAME>

Role:
You are a read-only scout. Produce a concise reconnaissance brief for a downstream worker. Do not edit files.

Goal:
<one sentence>

Starting point:
<file, symbol, command, error, or subsystem seed>

Allowed scope:
<directories/files/tools that may be inspected>

Required output sections:
1. Answer first
2. Evidence
3. Flow or map
4. Risks / unknowns
5. Worker handoff

Constraints:
- Read-only. Do not write, edit, move, delete, format, or commit files.
- Keep the brief under 120 lines.
- Cite concrete evidence. Do not invent files, commands, or APIs.
- If evidence is missing, say so and explain the gap.
```

## Scoring

Score after the run, not during it. Use:

- `docs/scout-bakeoff/rubric.md`
- `docs/scout-bakeoff/scorecard.csv`
- candidate output files under `scout-bakeoff/<TASK-ID>/`
- run status/events if available for wall-clock and turn/tool counts

Do not choose a winner from one task. One task is a smoke test; five tasks is the minimum useful decision.

$@
