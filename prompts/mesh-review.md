---
description: Parallel multi-model code review with offloaded synthesis
---

Run a partitioned, model-diverse adversarial review of the current diff or specified files, then have a dedicated `synthesizer` subagent fuse the findings so this conversation stays lean. You (the parent) should receive only the synthesis plus file paths — not the raw review briefs.

Use **fresh context**, not forked, unless I explicitly ask otherwise. Child agents inspect the diff and files directly; they do not rely on this conversation's history.

## 1. Partition into reviewer lanes (decompose, don't replicate)

Split the review into 2–4 **distinct** angles — never run identical agents. Give each lane its own angle AND its own model (model diversity > model count; different models have different blind spots). Default angles:

- **Correctness & regressions** → `reviewer` — does it satisfy the request, preserve existing behavior, handle edge cases, avoid hidden failures?
- **Depth & edge cases** → `reviewer` — type safety, null/undefined gaps, hidden runtime failures, complex interactions?
- **Simplicity & maintainability** → `reviewer` — unnecessary complexity, duplicate structure, confusing names, dead code, verbosity?

Suggested model spread (use strongest for hardest angle):
`openai-codex/gpt-5.5` (correctness), `crofai/deepseek-v4-pro-precision` (depth), `minimax/MiniMax-M2.7-highspeed` (simplicity).

## 2. Dispatch the lanes IN PARALLEL, then synthesis — one chain call

Use a single `subagent` chain: a parallel group of reviewers, then a sequential `synthesizer` step. Each reviewer writes findings to its own file; the synthesizer reads those files.

```
subagent({
  chain: [
    { parallel: [
        { agent: "reviewer", model: "openai-codex/gpt-5.5",               output: "mesh-review/findings-correctness.md",   task: "Review the current diff for correctness and regressions. Original request: {task} Check whether the change satisfies the request, preserves existing behavior, handles edge cases, and avoids hidden runtime failures. Read changed files directly. Return concise, evidence-backed findings with exact file:line references. Review-only — do not call edit, write, or any mutating tool." },
        { agent: "reviewer", model: "crofai/deepseek-v4-pro-precision",    output: "mesh-review/findings-depth.md",         task: "Review the current diff for depth and edge cases. Original request: {task} Check for type mismatches, null/undefined gaps, hidden failures, complex interactions, and boundary condition handling. Read changed files directly. Return concise, evidence-backed findings with exact file:line references. Do not edit files." },
        { agent: "reviewer", model: "minimax/MiniMax-M2.7-highspeed",     output: "mesh-review/findings-simplicity.md",   task: "Review the current diff for simplicity and maintainability. Original request: {task} Check for unnecessary complexity, duplicate structure, brittle abstractions, confusing names, excessive verbosity, and cleanup that is clearly worth doing. Read changed files directly. Return concise, evidence-backed findings with exact file:line references. Do not edit files." }
    ] },
    { agent: "synthesizer", model: "openai-codex/gpt-5.5", output: "mesh-review/synthesis.md",
      task: "Read mesh-review/findings-*.md. Fuse into a single consolidated review. Produce: blockers (must fix before proceeding), high-priority fixes, medium improvements, low/nice-to-have, and feedback to ignore (with brief reason). Preserve every file:line reference and reviewer attribution. Surface conflicts — do not smooth them. Then return a compact summary: total findings, blockers, high, medium, low, and a one-line verdict." }
  ],
  context: "fresh"
})
```

Rules for the dispatch:
- Keep review outputs **tight and evidence-dense** — the synthesizer and your context pay for verbosity. Demand file:line citations.
- Use the **strongest** model for the synthesizer (synthesis is harder than review); a cheap model produces mush. `openai-codex/gpt-5.5` is the default.
- Do **not** ask any reviewer to edit files — review is read-only unless I explicitly ask for implementation.

## 3. After the chain returns

You receive the synthesizer's compact summary + `mesh-review/synthesis.md`. Read the synthesis. Then synthesize the findings into:
- **Fixes worth doing now**
- **Optional improvements**
- **Feedback to ignore or defer** (with a short reason)

Do not blindly apply every reviewer suggestion. Ask before applying changes unless I already told you to address review feedback, or unless the invocation contains the word `autofix` (in which case apply only the fixes worth doing now, validate, and summarize).

$@
