---
description: Mesh recon: quick parallel context-builder research by default; use deep for artifact-backed reviewer synthesis
---

Run a fresh-context mesh recon pass on the question or decision below.

Default mode is **simple recon**: use a small set of parallel `context-builder` subagents with distinct lane prompts, then synthesize their answers in this parent conversation.

Deep mode is enabled when the invocation contains the exact word `deep` or `--deep`. Treat that word as workflow control, not part of the research scope. Deep mode uses partitioned lane artifacts plus a dedicated `reviewer` synthesis step so the parent receives only the synthesis.

Question / scope:

$@

## Simple mode: quick parallel notes

Use simple mode unless deep mode was requested.

Use **fresh context**, not forked, unless I explicitly ask otherwise. Context builders must inspect sources directly instead of relying on the main conversation history.

Use two or three strong lanes. Pick only the lanes that fit the question:

1. **External evidence** — `context-builder` with a web-research prompt
   - Official docs, specs, release notes, benchmarks, issue threads, recent changes, or primary-source explanations.

2. **Local code context** — `context-builder` with a local-recon prompt
   - Repository files, existing patterns, constraints, tests, likely integration points, and local risks.

3. **Practical tradeoffs** — `context-builder` with a decision-analysis prompt
   - Options, risks, edge cases, maintenance cost, validation strategy, and decision implications.

Adapt the lanes when the question calls for it:
- Library/API questions: include official docs and recent examples.
- Architecture decisions: include local module boundaries, dependency direction, and migration cost.
- Debugging questions: include likely failure modes, local call paths, and exact error evidence.
- UI/product questions: include user flow, accessibility, design precedent, and implementation constraints.
- Time-sensitive topics: include recent developments and prefer current sources.

Ask each subagent to return concise findings with evidence:
- file paths and line ranges for local findings;
- source links for external findings;
- confidence level and gaps;
- recommended next step or decision implication.

Do not ask subagents to edit files. This is a research pass only unless I explicitly ask for implementation.

After the subagents return, synthesize the answer into:
- what we know;
- what the local codebase implies;
- tradeoffs and risks;
- gaps or assumptions;
- the recommended next move.

If findings disagree, call out the disagreement instead of smoothing it over.

## Deep mode: partitioned lanes plus reviewer synthesis

Use deep mode only when the invocation contains `deep` or `--deep`, or when I explicitly ask for a deep/synthesized recon.

Run a partitioned, model-diverse recon pass, then have a dedicated `reviewer` subagent fuse the findings so this conversation stays lean. The parent should receive only the synthesis plus file paths, not the raw briefs.

Use a single `subagent` chain: a parallel group of `context-builder` lanes, then a sequential `reviewer` step. Each lane writes a tight brief to its own file; the reviewer reads those files.

Split the question into 2–5 distinct lanes — never run identical prompts. Choose lanes that fit the question. Defaults:
- **Local code** → `context-builder` — repo files, patterns, constraints, integration points, tests.
- **Official sources** → `context-builder` — docs, specs, release notes, primary references.
- **Ecosystem / practice** → `context-builder` — benchmarks, issue threads, real-world usage, gotchas.
- **Tradeoffs / alternatives** → `context-builder` — options, risks, migration cost.

Suggested shape:

```typescript
subagent({
  chain: [
    { parallel: [
        { agent: "context-builder", model: "minimax/MiniMax-M2.7-highspeed", output: "mesh-recon/lane-1-localcode.md", outputMode: "file-only", task: "Lane: local code. <angle>. Write ≤20 lines with exact file:line citations and no preamble." },
        { agent: "context-builder", model: "zai/glm-5.1",                    output: "mesh-recon/lane-2-official.md",  outputMode: "file-only", task: "Lane: official sources. <angle>. Write ≤20 lines with source links, confidence, and gaps." },
        { agent: "context-builder", model: "mimo/mimo-v2.5-pro",              output: "mesh-recon/lane-3-practice.md",  outputMode: "file-only", task: "Lane: ecosystem/practice. <angle>. Write ≤20 lines with source links, confidence, and gaps." },
        { agent: "context-builder", model: "openai-codex/gpt-5.5",            output: "mesh-recon/lane-4-risks.md",     outputMode: "file-only", task: "Lane: risks/alternatives. <angle>. Write ≤20 lines with key risks, tradeoffs, migration costs, and no speculation without evidence." }
    ] },
    { agent: "reviewer", model: "minimax/MiniMax-M2.7-highspeed", output: "mesh-recon/synthesis.md", outputMode: "file-only",
      task: "Read mesh-recon/lane-*.md. Fuse into one decision-ready synthesis: verdict, consensus, conflicts (surface, don't smooth), key evidence with file:line/URLs preserved, gaps. Original question: {task}" }
  ],
  context: "fresh"
})
```

Rules for deep mode:
- Keep lane outputs short and evidence-dense.
- Demand file:line for local findings, source links for web findings, plus confidence and gaps.
- Do not ask any lane to edit files.
- Read raw `mesh-recon/lane-*.md` briefs only when a decision hinges on a precise fact or unresolved conflict.
