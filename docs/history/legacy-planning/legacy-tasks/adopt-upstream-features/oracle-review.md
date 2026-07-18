# Oracle Review: adopt-upstream-features

**Reviewer:** oracle (opus)
**Date:** 2026-05-28
**Verdict:** SOUND WITH CONDITIONS — 3 concrete issues flagged below

---

## Summary

The plan is well-structured: phased approach, oracle gates between phases, test-first discipline, and a smart "verify soft gaps first" Phase 0. The per-phase version bumps and CHANGELOG hygiene are correct. The Phase 3 constraint to "do the diff FIRST" is the right instinct given the +520/−197 divergence in subagent-executor.ts.

**Three concrete issues need resolution before the plan is safe to hand to a cheap executor.**

---

## Issue 1 — Step 3.1: Diff doesn't produce an artifact

**Severity:** Medium

Step 3.1 says "measure exact divergence, identify conflict zones, write merge strategy" — but produces no output file. A cheap worker reading this plan has no guidance when it reaches Step 3.4.

**Fix:** After the diff in Step 3.1, add:

> Write the merge strategy to `.pi/tasks/adopt-upstream-features/phase3-merge-strategy.md` listing each conflict zone by file and line range with resolution instructions. If no conflicts, write "CLEAN — apply upstream additions verbatim."

Then Step 3.4 reads that file.

---

## Issue 2 — Step 3.3: No verification of how fanout-child.ts registers

**Severity:** Medium

Step 3.3 says "copy verbatim" and "add to package.json exports or contributes if needed" — but doesn't verify what our extension actually requires to register a new feature. Our `src/extension/index.ts` may need to import and register `fanout-child.ts`.

**Fix:** Before Step 3.3, add:

> Read `src/extension/index.ts` to see how `fanout-child.ts` should be registered (import + add to extension setup). Verify against how upstream's index.ts handles it: `git show upstream/main:src/extension/index.ts | grep fanout`.

Then Step 3.3 copies the registration pattern alongside the file.

---

## Issue 3 — Step 3.4: Git-style conflict markers are not executable

**Severity:** High

The plan says "mark conflicts with `<<<<<<< OURS / >>>>>>> UPSTREAM`" — but a worker implementing this literally cannot execute that. Conflict markers are not valid TypeScript.

**Fix:** Replace the conflict-resolution sentence with:

> If a merge conflict is detected (our fork has different logic for same section): STOP. Do not write any code. Report the conflict to the human with the exact file:line and both versions. Await resolution before continuing.

---

## What's sound

- Phase 0 is the right first step — avoid building what already exists
- Phase 1 (prompt files) is genuinely low risk; git-show + copy is safe
- Phase 2 is correctly gated on Phase 0 finding it missing
- Conditional Step 2.3 ("if MultiChildResumeTarget is absent") prevents duplicate work
- Per-phase version bump + CHANGELOG is the right release discipline
- Test command with `--test-force-exit` is correct (activity timers otherwise hang the suite)
- Gotcha about `MUTATING_MANAGEMENT_ACTIONS` is valid — worth watching in the Step 3.4 merge
- result-intercom.ts being +108/−0 purely additive is correctly identified as low risk

---

## Recommendation

Fix Issues 1, 2, and 3 above (additive changes to plan.md), then proceed. No structural redesign needed.
