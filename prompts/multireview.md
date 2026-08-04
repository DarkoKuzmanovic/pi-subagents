---
description: Parallel multi-model code review with offloaded synthesis
---

Run a partitioned, model-diverse adversarial review of the current diff or specified files, then have a dedicated synthesis step fuse the findings so this conversation stays lean. You (the parent) should receive only the synthesis plus file paths — not the raw review briefs.

Use **fresh context**, not forked, unless I explicitly ask otherwise. Child agents inspect the diff and files directly; they do not rely on this conversation's history.

## 1. Partition into reviewer lanes (decompose, don't replicate)

Split the review into 2–4 **distinct** angles — never run identical agents. Give each lane its own angle AND its own **model lane** (model diversity > model count; different models have different blind spots). Default angles:

- **Correctness & regressions** → `deep` — does it satisfy the request, preserve existing behavior, handle edge cases, avoid hidden failures?
- **Depth & edge cases** → `standard` — type safety, null/undefined gaps, hidden runtime failures, complex interactions?
- **Simplicity & maintainability** → `grok-fast` — unnecessary complexity, duplicate structure, confusing names, dead code, verbosity?
- **Synthesis** → `deep` — strongest reasoning lane; fusing findings is harder than reviewing them

Dispatch by **lane name, never by model ID.** The models behind these lanes live in `subagents.modelLanes.reviewer` in settings and are maintained there as the active model set — that single location is the source of truth. If a lane is missing or its model no longer resolves, fall back to the nearest remaining lane and say so in the summary. Inline `model:` overrides are only for deliberate one-off experiments.

## 2. Dispatch the lanes IN PARALLEL, then synthesis — one chain call

Use a single `subagent` chain: a parallel group of reviewers, then a sequential `reviewer` synthesis step. Each reviewer writes findings to its own file; the synthesis step reads those files. The former `synthesizer` agent is a disabled compatibility role, so use `reviewer` for synthesis.

```
subagent({
  chain: [
    { parallel: [
        { agent: "reviewer", lane: "deep", output: ".pi/tmp/multireview/findings-correctness.md", task: "Review the current diff for correctness and regressions. Original request: {task} Check whether the change satisfies the request, preserves existing behavior, handles edge cases, and avoids hidden runtime failures. Read changed files directly. Return concise, evidence-backed findings using the reviewer output contract below. Review-only — do not call edit, write, or any mutating tool." },
        { agent: "reviewer", lane: "standard", output: ".pi/tmp/multireview/findings-depth.md", task: "Review the current diff for depth and edge cases. Original request: {task} Check for type mismatches, null/undefined gaps, hidden failures, complex interactions, and boundary condition handling. Read changed files directly. Return concise, evidence-backed findings using the reviewer output contract below. Do not edit files." },
        { agent: "reviewer", lane: "grok-fast", output: ".pi/tmp/multireview/findings-simplicity.md", task: "Review the current diff for simplicity and maintainability. Original request: {task} Check for unnecessary complexity, duplicate structure, brittle abstractions, confusing names, excessive verbosity, and cleanup that is clearly worth doing. Read changed files directly. Return concise, evidence-backed findings using the reviewer output contract below. Do not edit files." }
    ] },
    { agent: "reviewer", lane: "deep", output: ".pi/tmp/multireview/synthesis.md",
      task: "Read .pi/tmp/multireview/findings-*.md. Fuse into a single consolidated review using the synthesis contract below. Preserve every file:line reference and reviewer attribution. Surface conflicts — do not smooth them. Then return a compact summary: total findings, blockers, should-fix, notes, disagreements, ignored/deferred, and a one-line verdict." }
  ],
  context: "fresh",
  chainDir: ".pi/tmp"
})
```

Reviewer output contract:

```
# Review: <lane>

## Verdict
approve | comment | request_changes

## Blocking findings
| ID | Severity | Location | Evidence | Risk | Suggested fix |

## Non-blocking findings
| ID | Severity | Location | Evidence | Suggested fix |

## Missing verification
- ...

## Confidence
High | Medium | Low

## Notes
- Include only evidence-backed findings. Cite file paths, diff hunks, commands, tests, docs, or existing behavior. If evidence is unavailable, say so.
```

Synthesis contract:

- Deduplicate overlapping findings across models.
- Classify synthesized items as **BLOCKER**, **SHOULD FIX**, **NOTE**, **DISAGREEMENT**, or **IGNORED / out-of-scope**.
- Preserve model attribution and exact file:line references.
- Explicitly list model disagreements and why you resolved them.
- Identify feedback to ignore or defer with a short reason.
- Include a final verdict and a short fix recommendation.

Rules for the dispatch:

- Keep review outputs **tight and evidence-dense** — the synthesizer and your context pay for verbosity. Demand file:line citations.
- Use the **strongest** lane for the synthesis step (synthesis is harder than review); `deep` is the default, but if a stronger lane exists in the pool, use it.
- Do **not** ask any reviewer to edit files — review is read-only unless I explicitly ask for implementation.

## 3. After the chain returns

You receive the synthesis summary + `.pi/tmp/multireview/synthesis.md`. Read the synthesis. Then synthesize the findings into:

- **Fixes worth doing now**
- **Optional improvements**
- **Feedback to ignore or defer** (with a short reason)

Do not blindly apply every reviewer suggestion. Ask before applying changes unless I already told you to address review feedback, or unless the invocation contains the word `autofix` (in which case apply only the fixes worth doing now, validate, and summarize).

$@
