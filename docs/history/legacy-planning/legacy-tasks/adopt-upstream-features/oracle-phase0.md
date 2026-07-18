# Oracle Review: Phase 0 Verification

**Reviewer:** oracle (opus, forked context)
**Date:** 2026-05-28
**Verdict:** SOUND — all 4 items verified, conclusions well-supported

---

## Item 1 — Async per-child metadata: ✅ CORRECT

**Claim:** Our `AsyncJobState` lacks per-child tracking; upstream has `nestedChildren?: NestedRunSummary[]`.

**Verified against:**
- Our `src/shared/types.ts` lines 341–372: `AsyncJobState` has `parallelGroups`, `steps`, `controlEventCursor` — but **no** `nestedChildren`, `NestedRunSummary`, or any per-child metadata field. Grep for `nestedChildren|NestedRunSummary` returns 0 matches across the entire file.
- Upstream `types.ts` lines 454–455 (inside `AsyncJobState`, just before closing `}`): `nestedRoute?: NestedRouteInfo;` and `nestedChildren?: NestedRunSummary[];` — confirmed present.
- Our `AsyncResumeTarget` (async-resume.ts:21–29) targets the whole job (`runId`, `agent`, `index`) — no per-child resolution capability.

**Conclusion holds.** Phase 2 is needed.

---

## Item 2 — Parallel-review enhancements: ✅ CORRECT

**Claim:** Numbered follow-up choices + autofix already present in our `prompts/parallel-review.md`.

**Verified against actual file content:**
- Line 40: `"Autofix mode: if the invocation contains the exact word autofix, treat it as workflow control..."` ✓
- Line 42: `"Without autofix mode, ask before applying fixes... end with a compact numbered menu"` ✓
- Line 45: `"Reply with [1], [2], or further instructions:"` ✓
- Line 46: `"[1] Apply only the fixes worth doing now."` ✓
- Line 47: `"[2] Apply the fixes worth doing now plus optional improvements."` ✓

**Conclusion holds.** This was a phantom item from CHANGELOG-only evidence. No work needed.

---

## Item 3 — Provider model labels: ✅ CORRECT

**Claim:** `nested-render.ts` doesn't exist in our fork; arrives via Phase 3 as a new file.

**Verified:**
- `find src/ -name 'nested-render.ts'` → no results.
- The file exists in upstream (`git ls-tree` confirmed blob `414347c0...`).
- Provider/model labels live inside `nestedRunLabel()` in that file — can't exist without the file.

**Conclusion holds.** Not independently actionable; arrives in Phase 3.

---

## Item 4 — Intercom nested summaries: ✅ CORRECT

**Claim:** Our `result-intercom.ts` lacks `compactNestedRun`, `nestedRunLabel`, `attachNestedChildrenToResultChildren`; these arrive in Phase 3.

**Verified:**
- Grep for all three function names across our `src/intercom/result-intercom.ts` → **0 matches**.
- These are the +108 lines upstream added (purely additive, no modifications to existing functions).
- They serve fanout child summaries specifically — assigning them to Phase 3 (not Phase 2) is correct because they depend on `NestedRunSummary` types and nested-path resolution that also arrive in Phase 3.

**Conclusion holds.** Phase 3 dependency chain is sound.

---

## Item 5 — Recommended scope: ✅ SOUND

| Phase | Scope | Oracle assessment |
|-------|-------|-------------------|
| Phase 1 | Prompt files only (unchanged) | Correct — no new information changes this |
| Phase 2 | Per-child `nestedChildren` on `AsyncJobState` + resume-by-child | Correct — confirmed missing |
| Phase 3 | Fanout files + result-intercom merge + shared-file merges | Correct — intercom nested summaries belong here, not Phase 2 |

**One nuance worth noting:** The report mentions `nestedChildren?: NestedRunSummary[]` as the Phase 2 target for `AsyncJobState`. However, upstream puts this field on `AsyncJobState` as part of the *fanout* feature (v0.25.0), not the async metadata feature (v0.23.1). The `NestedRunSummary` type itself doesn't exist in our fork yet and arrives in Phase 3 with the nested-events/nested-path files. This means **Phase 2 cannot add `nestedChildren` to `AsyncJobState` without Phase 3's types being present first.**

**Recommendation:** Either:
- (a) Reorder: do Phase 3 types-only first (add `NestedRunSummary` and friends to `types.ts`), then Phase 2 can use them, or
- (b) Phase 2 adds a simpler per-child tracking structure that doesn't depend on `NestedRunSummary` (e.g., its own `AsyncChildSession` type as the plan sketches), and Phase 3 later replaces/extends it with the upstream `NestedRunSummary` approach.

Option (b) risks throwaway work. Option (a) is cleaner but means Phase 2 and Phase 3 are partially interleaved. **Flag this for the human** — it's a sequencing decision, not a correctness issue.

---

## Final verdict

**SOUND.** All evidence checks out. One sequencing concern flagged (Phase 2 depends on Phase 3 types). Proceed to Phase 1.
