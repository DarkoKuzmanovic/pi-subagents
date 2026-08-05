---
description: Author an implementation plan an executor can pick up
---

Author an implementation plan from a spec, approved design, or clear intent. The plan must be concrete enough that a worker subagent (or a future me) can execute it without asking new design questions.

Do not start implementation from this command unless I explicitly ask for it.

Workflow:

1. Read the source material directly. If the invocation names a spec file, design doc, issue link, PR, or local path, read or fetch it before drafting. Do not plan against a paraphrase.

2. Decide whether you need a context pass before planning. Launch only what is justified:
   - `recon` with `context: "fresh"` when local file structure, existing patterns, or tests need to be mapped before the plan can name concrete files and contracts.
   - `recon` with `context: "fresh"` and a web-research prompt when external API shape or library behavior must be confirmed before sequencing.
   - Skip both when the spec already names everything.

3. Draft the plan. Use this structure unless the request asks for something different:
   - **Goal** — one sentence.
   - **Non-goals** — what we are deliberately not doing.
   - **Constraints** — invariants, dependencies, compatibility requirements, validation gates.
   - **Tasks** — ordered, each 2 to 10 minutes of work. For each task, name:
     - the file path(s) it touches;
     - the function/type/contract signature where it matters;
     - the validation command that proves the task is done.
   - **Validation** — the full command sequence that proves the whole plan is done (typecheck, tests, lint, manual checks).
   - **Risks and open questions** — what could go wrong, and what we still do not know.

4. Self-review before handoff. Scan your own draft for:
   - placeholders: "TBD", "TODO", "implement later", "appropriate error handling", "as needed";
   - tasks without a file path or validation command;
   - tasks that are actually multiple tasks pretending to be one;
   - validation steps that are vague ("make sure it works") instead of executable.

   Fix these in the draft. Do not hand off a plan with self-review issues unless I explicitly accept them.

5. Decide where the plan lives. If the user did not specify and the request looks throwaway, return the plan inline. If the work is substantial, propose a path under `docs/plans/` or the project's existing plan location and ask before writing.

6. End with a compact menu:

```text
Reply with [1], [2], [3], or further instructions:
[1] Hand off this plan to a worker now.
[2] Revise the plan first — I will say what to change.
[3] Pause — I want to review before any handoff.
```

Hard gate: do not dispatch `worker`, `test-writer`, or any implementation chain until I pick `[1]` or explicitly approve handoff.

Plan target, scope, or spec reference:

$@
