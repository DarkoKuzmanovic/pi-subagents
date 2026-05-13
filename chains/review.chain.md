---
name: review
description: Sequential model-diverse reviewers → synthesis. Use when you want adversarial review from multiple perspectives and models before implementation.
---

## correctness
agent: reviewer
task: |
  Review the current diff or repository for **correctness and regressions**.

  Check whether the change satisfies the request, preserves existing behavior,
  handles edge cases, avoids hidden runtime failures, and doesn't introduce
  type mismatches, null/undefined gaps, or broken imports.

  Read changed files directly. Return concise, evidence-backed findings with
  exact file:line references. Suggest the smallest safe fix when a bug is
  clear. Do not edit files.
model: openai-codex/gpt-5.5
output: review/findings-correctness.md

## tests
agent: reviewer
task: |
  Review the current diff or repository for **tests and validation quality**.

  Check whether tests were added or updated at the right layer, whether
  assertions are meaningful, whether edge cases and error paths are covered,
  and whether the chosen verification commands are sufficient to catch
  regressions.

  Read changed files and nearby test files directly. Return concise,
  evidence-backed findings with exact file:line references. Do not edit files.
model: crofai/kimi-k2.6
output: review/findings-tests.md

## simplicity
agent: reviewer
task: |
  Review the current diff or repository for **simplicity and maintainability**.

  Check for unnecessary complexity, duplicate structure, single-use wrappers,
  brittle abstractions, confusing names, excessive verbosity, and cleanup
  that is clearly worth doing. Flag anything that would confuse a future
  maintainer.

  Read changed files directly. Return concise, evidence-backed findings with
  exact file:line references. Do not edit files.
model: wafer/Qwen3.5-397B-A17B
output: review/findings-simplicity.md

## synthesis
agent: context-builder
task: |
  Read the review findings from {previous} and synthesize them into a single
  consolidated review. Produce:

  ## Review Synthesis

  ### Blockers (must fix before proceeding)
  ### High-priority fixes (fix now)
  ### Medium improvements (fix soon)
  ### Low / nice-to-have (defer)
  ### Feedback to ignore (with brief reason)

  For each finding, preserve the original file:line reference and reviewer
  attribution. Do not re-evaluate or second-guess the reviewers — just
  categorize and merge their findings.

  Write the synthesis to review/synthesis.md. Then return a compact summary:
  total findings, blockers, high, medium, low, and a one-line verdict
  (e.g. "3 blockers — must fix before landing" or "No blockers, 2 high-priority
  improvements").
output: review/synthesis.md
model: wafer/GLM-5.1
