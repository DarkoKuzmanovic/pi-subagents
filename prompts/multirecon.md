---
description: Multirecon: quick parallel recon research by default; use deep for artifact-backed reviewer synthesis
---

Run a fresh-context multirecon pass on the question or decision below.

Default mode is **simple recon**: use a small set of parallel `recon` subagents with distinct lane prompts, then synthesize their answers in this parent conversation.

Deep mode is enabled when the invocation contains the exact word `deep` or `--deep`. Treat that word as workflow control, not part of the research scope. Deep mode uses partitioned lane artifacts plus a dedicated `reviewer` synthesis step so the parent receives only the synthesis.

Question / scope:

$@

## Simple mode: quick parallel notes

Use simple mode unless deep mode was requested.

Use **fresh context**, not forked, unless I explicitly ask otherwise. Context builders must inspect sources directly instead of relying on the main conversation history.

Use two or three distinct recon lanes. Dispatch by **lane name, never by model ID** — the models behind these lanes live in `subagents.modelLanes.recon` in settings and are user-maintained there as the active model set. Pick only the lanes that fit the question; suggested spread:

1. **External evidence** → `sonnet` — web research: official docs, specs, release notes, benchmarks, issue threads, recent changes, or primary-source explanations.
2. **Local code context** → `luna` — repository files, existing patterns, constraints, tests, likely integration points, and local risks.
3. **Practical tradeoffs** → `m3` — options, risks, edge cases, maintenance cost, validation strategy, and decision implications.

Adapt the lanes when the question calls for it:
- Library/API questions: include official docs and recent examples.
- Architecture decisions: include local module boundaries, dependency direction, and migration cost.
- Debugging questions: include likely failure modes, local call paths, and exact error evidence.
- UI/product questions: include user flow, accessibility, design precedent, and implementation constraints.
- Time-sensitive topics: include recent developments and prefer current sources.

If a lane is missing or its model no longer resolves, fall back to the nearest remaining lane and say so. Inline `model:` overrides are only for deliberate one-off experiments.

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

Use a single `subagent` chain: a parallel group of `recon` lanes, then a sequential `reviewer` step. Each lane writes a tight brief to its own file; the reviewer reads those files.

Split the question into 2–5 distinct lanes — never run identical prompts. Choose lanes that fit the question. Defaults:
- **Local code** → `luna` — repo files, patterns, constraints, integration points, tests.
- **Official sources** → `sonnet` — docs, specs, release notes, primary references.
- **Ecosystem / practice** → `haiku` — benchmarks, issue threads, real-world usage, gotchas.
- **Tradeoffs / alternatives** → `m3` — options, risks, migration cost.

Suggested shape:

```typescript
subagent({
  chain: [
    { parallel: [
        { agent: "recon", lane: "luna", output: "multirecon/lane-1-localcode.md", outputMode: "file-only", task: "Lane: local code. <angle>. Write ≤20 lines with exact file:line citations and no preamble." },
        { agent: "recon", lane: "sonnet", output: "multirecon/lane-2-official.md",  outputMode: "file-only", task: "Lane: official sources. <angle>. Write ≤20 lines with source links, confidence, and gaps." },
        { agent: "recon", lane: "haiku", output: "multirecon/lane-3-practice.md",  outputMode: "file-only", task: "Lane: ecosystem/practice. <angle>. Write ≤20 lines with source links, confidence, and gaps." },
        { agent: "recon", lane: "m3", output: "multirecon/lane-4-risks.md",     outputMode: "file-only", task: "Lane: risks/alternatives. <angle>. Write ≤20 lines with key risks, tradeoffs, migration costs, and no speculation without evidence." }
    ] },
    { agent: "reviewer", lane: "deep", output: "multirecon/synthesis.md", outputMode: "file-only",
      task: "Read multirecon/lane-*.md. Fuse into one decision-ready synthesis: verdict, consensus, conflicts (surface, don't smooth), key evidence with file:line/URLs preserved, gaps. Original question: {task}" }
  ],
  context: "fresh"
})
```

Run the synthesis on the `reviewer` role with its strongest lane (`deep`), the same choice as multireview: fusing research briefs is a reasoning task, not a research task, and the strongest lane owns it. If `deep` is missing, use the next strongest reviewer lane and say so.

Rules for deep mode:
- Keep lane outputs short and evidence-dense.
- Demand file:line for local findings, source links for web findings, plus confidence and gaps.
- Do not ask any lane to edit files.
- Read raw `multirecon/lane-*.md` briefs only when a decision hinges on a precise fact or unresolved conflict.
