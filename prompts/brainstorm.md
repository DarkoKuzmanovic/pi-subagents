---
description: Design-first exploration before implementation
---

Stay design-first. Do not implement anything from this command unless I explicitly approve a direction.

Use the `brainstorming` skill. The goal is to widen the option space, surface tradeoffs, and converge on a direction we both agree on before any code is written.

Workflow:

1. Restate what you understood from the request in one or two sentences. If anything is ambiguous, do not guess.

2. Decide whether you need outside context before discussing. Launch only what is justified:
   - `scout` with `context: "fresh"` when local files, existing patterns, or constraints would shape the choice.
   - `researcher` with `context: "fresh"` when external docs, ecosystem norms, or primary sources would meaningfully change the recommendation.
   - Skip both when the question is small enough to discuss directly.

   Do not run more than two parallel agents for brainstorming. This is design conversation, not a context-gathering chain.

3. Ask clarifying questions one at a time with `ask_user`. Do not dump a survey. Focus on the question whose answer most narrows the option space (purpose, user, constraints, success signal, non-goals). Stop asking when you have enough to compare approaches.

4. Compare two or three concrete approaches. For each, name:
   - what it does, in one sentence;
   - the main tradeoff against the others;
   - the smallest first step;
   - the failure mode I should fear most.

   Disagree with yourself. If one approach has a real fail mode, lead with the fail mode, not with validation of my idea.

5. Propose a recommended direction with a short reason. Surface open questions and assumptions instead of smoothing them over.

6. Stop and wait. End with a compact menu so I can pick a direction or push back:

```text
Reply with [1], [2], [3], or further instructions:
[1] Go with the recommended approach.
[2] Go with a different approach (say which).
[3] Keep brainstorming — answer follow-up questions first.
```

Hard gate: do not invoke `planner`, `worker`, `delegate`, or any implementation skill until I pick a direction. If the user wants a plan written for the chosen direction, use `/write-plan` next.

Topic, target, or focus for this brainstorm:

$@
