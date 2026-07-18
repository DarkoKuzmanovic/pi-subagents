# Phase 0 Verification Report

**Date:** 2026-05-28
**Scope:** 4 items from pre-plan marked as "CHANGELOG-only, git-diff did not confirm"

---

## Item 1 — Async metadata persistence

**Phase 2 needed:** **YES**

**Evidence:**
- `MultiChildResumeTarget` — absent from our codebase entirely
- `perChildSession` / `perChildMetadata` — absent
- `resumeByChildIndex` / `resumeByChildRunId` — absent
- Our `AsyncJobState` (types.ts:341): top-level job fields only (`asyncId`, `status`, `pid`, `sessionId`, `activityState`, etc.) — **no per-child metadata array**
- Our `AsyncResumeTarget` (async-resume.ts:21): `{ kind, runId, asyncDir, state, agent }` — targets the whole job, not individual children
- Our `ForegroundResumeRun` (types.ts:386) has `children: ForegroundResumeChild[]` — but that's foreground-only and not persisted per-child in the async job record
- Upstream's `AsyncJobState` (upstream types.ts:455): `nestedChildren?: NestedRunSummary[]` — per-child run summaries stored on the job record, enabling nested fanout and resume-by-child-index

**Conclusion:** Phase 2 is needed. Our async job tracking has no per-child metadata persistence and no resume-by-child capability.

---

## Item 2 — Parallel-review enhancements (item #5)

**Item #5 present:** **YES**

**Evidence:**
Our `prompts/parallel-review.md` already contains:
- `Autofix mode: if the invocation contains the exact word autofix...` (line 40) — autofix workflow control
- `Reply with [1], [2], or further instructions:` (line 45)
- `[1] Apply only the fixes worth doing now.` (line 46)
- `[2] Apply the fixes worth doing now plus optional improvements.` (line 47)
- `Without autofix mode, ask before applying fixes... end with a compact numbered menu` (line 42)

**Conclusion:** Numbered follow-up choices + autofix are already present. No work needed here. The pre-plan's CHANGELOG reference was a phantom.

---

## Item 3 — Provider model labels (item #6)

**Item #6 confirmed in upstream:** **YES** (but irrelevant — the file doesn't exist in our fork)

**Evidence:**
`git show upstream/main:src/runs/shared/nested-render.ts | grep -i "provider\|model\|label"` returns:
- `import { formatActivityLabel } from "../../shared/status-format.ts"`
- `function nestedRunLabel(run: NestedRunSummary): string`
- `lines.push(\`↳ ${nestedRunLabel(child)} [${child.id}] ${child.state}...\`)`

Upstream's `nested-render.ts` has provider/model labels. Our fork has no `nested-render.ts` at all (it's a Phase 3 new-file).

**Conclusion:** Item #6 is upstream-only fanout scaffolding. It will arrive via Phase 3 when we port `nested-render.ts`. Not independently actionable in Phase 2.

---

## Item 4 — Intercom nested summaries

**Nested summaries already in result-intercom.ts:** **NO** (we have the types, not the functions)

**Evidence — what we have:**
- `SubagentResultIntercomChild` type ✓
- `countStatuses()` ✓
- `resolveGroupedStatus()` ✓

**What we lack (confirmed absent from our result-intercom.ts):**
- `compactNestedRun` — absent
- `nestedRunLabel` — absent
- `attachNestedChildrenToResultChildren` — absent

Upstream's result-intercom.ts has all 3 of these (+108 lines of nested summary logic). They are a **prerequisite for the fanout feature** — fanout child summaries need `compactNestedRun` to serialize into compact intercom payloads.

**Conclusion:** Phase 2 is not the right layer — this arrives in Phase 3 when we merge `result-intercom.ts` (+108/−0 purely additive). The compact nested summaries are fanout-specific, not async-job-specific.

---

## Summary

| Item | Verdict | Phase |
|------|---------|-------|
| Async per-child metadata + resume-by-index | **MISSING — Phase 2 needed** | Phase 2 |
| Parallel-review numbered choices + autofix | **PRESENT — phantom item** | None |
| Provider model labels in nested-render | **Upstream only — fanout file** | Phase 3 |
| Intercom compact nested summaries | **MISSING — arrives in Phase 3** | Phase 3 |

**Recommended scope for Phase 1 + Phase 2:**
- Phase 1: Prompt files only (no change to scope)
- Phase 2: **Proceed** — per-child `nestedChildren: NestedRunSummary[]` on `AsyncJobState` + `resumeByChildIndex` + `resumeByChildRunId`
- Phase 3: Fanout new files + `result-intercom.ts` (+108/−0) will cover the intercom nested summaries
