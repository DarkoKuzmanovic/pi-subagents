---
description: Parallel multi-model recon with offloaded synthesis
---

Run a partitioned, model-diverse recon pass on the question/decision below, then have a dedicated `synthesizer` subagent fuse the findings so this conversation stays lean. You (the parent) should receive only the synthesis plus file paths — not the raw briefs.

Use **fresh context**, not forked, unless I explicitly ask otherwise. Child agents inspect sources directly; they do not rely on this conversation's history.

## 1. Partition into lanes (decompose, don't replicate)

Split the question into 2–5 **distinct** lanes — never run identical agents. Give each lane its own angle AND its own model (model diversity > model count; different models have different blind spots). Pick lanes that fit the question; defaults:

- **Local code** → `scout` — repo files, existing patterns, constraints, integration points, tests.
- **Official sources** → `researcher` — docs, specs, release notes, primary references.
- **Ecosystem / practice** → `researcher` — benchmarks, issue threads, real-world usage, gotchas.
- **Tradeoffs / alternatives** → `researcher` or `scout` — options, risks, migration cost.

Suggested model spread across lanes (use the strongest you have for the hardest lane):
`minimax/MiniMax-M2.7-highspeed`, `crofai/kimi-k2.6-precision`, `mimo/mimo-v2.5-pro`, `crofai/glm-5.1-precision`, `openai-codex/gpt-5.5`.

## 2. Dispatch the lanes IN PARALLEL, then synthesis — one chain call

Use a single `subagent` chain: a parallel group of lanes, then a sequential `synthesizer` step. Each lane writes a **tight** brief to its own file (cap the prose, demand citations); the synthesizer reads those files.

```
subagent({
  chain: [
    { parallel: [
        { agent: "scout",      model: "minimax/MiniMax-M2.7-highspeed", output: "mesh-recon/lane-1-localcode.md",  task: "Lane: local code. <angle>. ≤20 lines, exact file:line citations, no preamble." },
        { agent: "researcher", model: "crofai/kimi-k2.6-precision",               output: "mesh-recon/lane-2-official.md",   task: "Lane: official sources. <angle>. ≤20 lines, source links, confidence + gaps." },
        { agent: "researcher", model: "mimo/mimo-v2.5-pro",           output: "mesh-recon/lane-3-practice.md",   task: "Lane: ecosystem/practice. <angle>. ≤20 lines, source links, confidence + gaps." }
    ] },
    { agent: "synthesizer", model: "openai-codex/gpt-5.5", output: "mesh-recon/synthesis.md",
      task: "Read mesh-recon/lane-*.md. Fuse into one decision-ready synthesis: verdict, consensus, conflicts (surface, don't smooth), key evidence with file:line/URLs preserved, gaps. Original question: {task}" }
  ],
  context: "fresh"
})
```

Rules for the dispatch:
- Keep lane outputs **short and evidence-dense** — the synthesizer (and your context) pay for verbosity. Demand file:line for local findings, source links for web findings, plus confidence + gaps.
- Use the **strongest** available model for the synthesizer (synthesis is harder than recon); a cheap model produces mush. `openai-codex/gpt-5.5` is the default.
- Do **not** ask any lane to edit files — recon is read-only unless I explicitly ask for implementation.

## 3. After the chain returns

You receive the synthesizer's compact summary + `mesh-recon/synthesis.md`. Read the synthesis. **Only** open a raw `mesh-recon/lane-*.md` brief when a decision hinges on a precise fact (exact config, file:line, version) — synthesis is great for breadth, but read the source for load-bearing specifics. If the synthesis flags an unresolved conflict, resolve it (verify the source yourself or ask me) rather than picking arbitrarily.

$@
