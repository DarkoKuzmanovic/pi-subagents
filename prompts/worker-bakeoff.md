---
description: Compare worker models on implementation quality using isolated worktrees
---

Run a worker-subagent bakeoff for the task below. Compare the same implementation task across the four candidate worker models, using isolated worktrees and the rubric in `docs/worker-bakeoff/rubric.md`.

Candidate models:

- `mimo/mimo-v2.5-pro`
- `openai-codex/gpt-5.4-mini`
- `minimax/MiniMax-M2.7-highspeed`
- `crofai/glm-5.1-precision`

## Parent protocol

1. Confirm the working tree is clean before launching. If it is not clean, stop and ask what to do.
2. Bind the task to one concrete brief from `docs/worker-bakeoff/tasks/`.
3. Launch the four candidates with identical prompts, `agent: "worker"`, `context: "fresh"`, and `worktree: true`.
4. Do not provide mid-run coaching unless the task is explicitly about clarification behavior.
5. After completion, inspect each output path, run any missing parent-side verification, and score with `docs/worker-bakeoff/rubric.md`.
6. Append one row per candidate to `docs/worker-bakeoff/scorecard.csv`.

## Dispatch shape

Use this shape for one benchmark task. Replace `<TASK-ID>`, `<BOUND-TASK-BRIEF>`, and `<VALIDATION-COMMANDS>` before launching.

```typescript
subagent({
  tasks: [
    {
      agent: "worker",
      model: "mimo/mimo-v2.5-pro",
      task: `<BOUND-TASK-BRIEF>`,
      output: "worker-bakeoff/<TASK-ID>/mimo.md",
      progress: false,
    },
    {
      agent: "worker",
      model: "openai-codex/gpt-5.4-mini",
      task: `<BOUND-TASK-BRIEF>`,
      output: "worker-bakeoff/<TASK-ID>/codex-mini.md",
      progress: false,
    },
    {
      agent: "worker",
      model: "minimax/MiniMax-M2.7-highspeed",
      task: `<BOUND-TASK-BRIEF>`,
      output: "worker-bakeoff/<TASK-ID>/minimax-highspeed.md",
      progress: false,
    },
    {
      agent: "worker",
      model: "crofai/glm-5.1-precision",
      task: `<BOUND-TASK-BRIEF>`,
      output: "worker-bakeoff/<TASK-ID>/glm-precision.md",
      progress: false,
    },
  ],
  concurrency: 4,
  context: "fresh",
  worktree: true,
})
```

## Bound task brief template

```text
Benchmark task: <TASK-ID> / <TASK-NAME>

Goal:
<one sentence>

Approved scope:
<files/symbols/behavior in scope>

Non-goals / forbidden changes:
<protected files, no broad refactors, no config rewrites>

Success criteria:
<what must be true>

Validation to run:
<VALIDATION-COMMANDS>

Final response required:
- Summary of files changed.
- Verification commands and pass/fail output summary.
- Any blockers or assumptions.

If the task is ambiguous or would require touching forbidden files, stop and report the blocker instead of guessing.
```

## Scoring

Score after the run, not during it. Use:

- `docs/worker-bakeoff/rubric.md`
- `docs/worker-bakeoff/scorecard.csv`
- `git diff --stat` and `git diff --name-only` from each worktree
- the worker's verification transcript

Do not choose a winner from one task. One task is a smoke test; six tasks is the minimum useful decision.

$@
