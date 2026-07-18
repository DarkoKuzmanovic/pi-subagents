# Plan: adopt-upstream-features

## Phase 0 — Verify soft gaps (inline, no code changes)

**Goal:** Confirm what's actually missing vs what we already have. Report to oracle before any building.

### Step 0.1 — Inspect async metadata persistence
- Read `src/runs/background/async-job-tracker.ts`
- Search for `MultiChildResumeTarget`, `childMetadata`, `perChildSession`, or resume-by-index patterns
- Read `src/runs/background/async-execution.ts` for same
- `git show upstream/main:src/runs/background/async-job-tracker.ts | head -80` — compare
- **Deliverable:** one line: "Phase 2 needed: YES/NO + reason"

### Step 0.2 — Inspect parallel-review enhancements
- `git show upstream/main:prompts/parallel-review.md | grep -A5 "numbered\|follow-up\|autofix\|choice"` — check if we have numbered follow-up choices
- Compare with our `prompts/parallel-review.md`
- **Deliverable:** one line: "item #5 present: YES/NO"

### Step 0.3 — Inspect provider model labels
- `git show upstream/main:src/runs/shared/nested-render.ts | grep -i "provider\|model\|label"` — check upstream TUI rendering
- **Deliverable:** one line: "item #6 confirmed in upstream: YES/NO"

### Step 0.4 — Inspect intercom nested summaries
- `git show upstream/main:src/intercom/result-intercom.ts | grep -i "nested\|compact\|child"` — compare to ours
- **Deliverable:** one line: "nested summaries already in result-intercom.ts: YES/NO"

→ **Oracle gate:** confirm Phase 0 verified scope before Phase 1. [DONE: oracle approved 2026-05-28]

---

## Phase 1 — Port cheap prompt files

### Step 1.1 — Copy review-loop.md
```
git show upstream/main:prompts/review-loop.md > prompts/review-loop.md
```
- Verify it auto-registers as slash command (host reads `prompts` from `package.json` contributions)
- After Pi restart: confirm `/review-loop` is available

### Step 1.2 — Copy gather-context-and-clarify.md
```
git show upstream/main:prompts/gather-context-and-clarify.md > prompts/gather-context-and-clarify.md
```
- Verify registration after restart

### Step 1.3 — Copy parallel-context-build.md
```
git show upstream/main:prompts/parallel-context-build.md > prompts/parallel-context-build.md
```
- Verify registration after restart

### Step 1.4 — Version bump + CHANGELOG
- `package.json`: bump patch version
- `CHANGELOG.md`: roll `[Unreleased]` into `## [x.y.z]` with today's date

### Step 1.5 — Test
```
timeout 180 node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-force-exit test/unit/*.test.ts
```
- Must not add new failures beyond baseline (~4 environmental)

→ **Oracle gate:** review diff of Phase 1 before Phase 2.
→ **Oracle gate:** review diff of Phase 1 before Phase 2 (types).

---

## Phase 2 — Pre-requisite: add Nested* types (unblocks Phase 3)

**Why:** Phase 3 (async per-child metadata) needs `NestedRunSummary`, `NestedRouteInfo`, `NestedRunResolutionScope` — none exist in our fork yet. Upstream added them in v0.25.0 as part of fanout. We extract them as a pure-additive, low-risk first step so Phase 3 can use them.

### Step 2.1 — Add Nested* types to types.ts
- Read `src/shared/types.ts`
- `git show upstream/main:src/shared/types.ts | grep -A5 "NestedRunSummary\|NestedRouteInfo\|NestedRunResolutionScope"`
- Add each type verbatim: `NestedRouteInfo`, `NestedRunSummary`, `NestedRunMatch`, `NestedRunResolutionScope`
- Verify no name collisions with our existing types

### Step 2.2 — Add Nested* env vars to pi-args.ts
- Read `src/runs/shared/pi-args.ts`
- `git show upstream/main:src/runs/shared/pi-args.ts | grep -B2 -A5 "NestedAsyncDir\|NestedRouteInfo"`
- Add upstream's `NestedAsyncDir` and any `NestedRouteInfo` env vars to `BuildPiArgsInput`

### Step 2.3 — Version bump + CHANGELOG
- Patch bump + CHANGELOG roll (Phase 2 entry)

### Step 2.4 — Test
```
timeout 180 node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-force-exit test/unit/*.test.ts
```

→ **Oracle gate:** review Phase 2 types diff before Phase 3.

---

## Phase 3 — Async per-child metadata persistence

**Phase 0 confirmed this is needed.** Now uses types from Phase 2.

### Step 3.1 — Read existing async modules
- `src/runs/background/async-job-tracker.ts`: find where jobs are persisted (JSON file path, schema)
- `src/runs/background/async-execution.ts`: find how child runs are tracked

### Step 3.2 — Read upstream equivalent
```
git show upstream/main:src/runs/background/async-job-tracker.ts
git show upstream/main:src/runs/background/async-execution.ts
```
- Find the per-child metadata pattern (search for `childId`, `childIndex`, `metadata`)

### Step 3.3 — Add per-child session metadata
- Add `nestedChildren: NestedRunSummary[]` to `AsyncJobState` (now possible with Phase 2 types)
- Each child session in the array: `{ id, agentName, startedAt, state }`
- Persist in same JSON job file

### Step 3.4 — Add resume-by-child-index
- In `async-resume.ts` or `async-job-tracker.ts`: add `resumeByChildIndex(index: number)` targeting specific child
- Add `resumeByChildRunId(runId: string)` as well

### Step 3.5 — Version bump + CHANGELOG
- Patch bump + CHANGELOG roll (Phase 3 entry)

### Step 3.6 — Test
```
timeout 180 node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-force-exit test/unit/*.test.ts
```
- Also run: `node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-force-exit test/unit/async-resume.test.ts`

→ **Oracle gate:** review Phase 3 diff before Phase 4.

---

## Phase 4 — Nested child-safe fan-out (HIGH risk)



### Step 3.1 — Line-level diff of shared files (DO FIRST)
```
git diff HEAD upstream/main -- src/runs/foreground/subagent-executor.ts
git diff HEAD upstream/main -- src/shared/types.ts
git diff HEAD upstream/main -- src/runs/shared/pi-args.ts
```
- Measure exact divergence
- Identify conflict zones (renamed exports, changed signatures, removed imports)

### Step 4.1b — Write merge strategy artifact
Write to `.pi/tasks/adopt-upstream-features/phase3-merge-strategy.md`:
- Per file: conflict zones by line range with resolution instructions
- Per file: "CLEAN — apply upstream additions verbatim" if no conflicts
- List of new exports to add, grouped by file
- If any conflict zones found: mark as "NEEDS HUMAN REVIEW" with both versions

Then Step 4.4 reads `phase3-merge-strategy.md` before touching any code.

### Step 4.2 — Merge result-intercom.ts (+108/−0, low risk)
```
git show upstream/main:src/intercom/result-intercom.ts
```
- Apply upstream additions as new exported functions/handlers for nested child summaries
- No existing code modified

### Step 4.2b — Verify fanout-child.ts registration pattern
- Read `src/extension/index.ts` — find how our extension registers new features
- `git show upstream/main:src/extension/index.ts | grep -A10 fanout` — get upstream's registration pattern
- Compare: does our index.ts need to import and call `fanout-child`?
- **If yes:** note the exact import + call to add in Step 3.3, not after
- **If no:** document why (auto-registration via package.json or no-op in our fork)

### Step 4.3 — Port new fanout files (all absent, clean adds)
```
git show upstream/main:src/extension/fanout-child.ts
git show upstream/main:src/runs/shared/nested-events.ts
git show upstream/main:src/runs/shared/nested-path.ts
git show upstream/main:src/runs/shared/nested-render.ts
git show upstream/main:src/runs/background/run-id-resolver.ts
```
- Copy each file verbatim
- Add to `package.json` `exports` or `contributes` if needed (check how our extension/index.ts registers new features)

### Step 4.4 — Merge subagent-executor.ts (+520/−197, HIGH RISK)
- Apply upstream changes in phases:
  1. New imports (NestedRouteInfo, NestedRunSummary, nested-path functions, nested-render functions, run-id-resolver)
  2. New `MUTATING_MANAGEMENT_ACTIONS` constant
  3. `attachNestedChildrenToResultChildren` import from result-intercom
  4. Nested route resolution in spawn args
  5. Nested status line formatting in TUI output
- **Conflict rule:** if our fork has different logic for the same section: STOP. Do not write any code. Report the exact file:line and both versions to the human. Await resolution before continuing.

### Step 4.5 — Merge types.ts (+118/−0, additive)
- Add upstream type definitions: `NestedRouteInfo`, `NestedRunSummary`, `NestedRunResolutionScope`
- Verify no name collisions with our existing types

### Step 4.6 — Merge pi-args.ts (+78/−0, additive)
- Add upstream's `NestedRouteInfo` or `NestedAsyncDir` env vars to `BuildPiArgsInput`
- Verify existing args unchanged

### Step 4.7 — Port upstream fanout tests (Phase 4 only) (Phase 3 only)
```
git show upstream/main:test/unit/nested-events.test.ts
git show upstream/main:test/unit/result-intercom.test.ts
git show upstream/main:test/unit/run-id-resolver.test.ts
git show upstream/main:test/unit/widget-nested-render.test.ts
```
- Copy each to our `test/unit/`
- Run tests to check compatibility

### Step 4.8 — Version bump + CHANGELOG
- Minor bump (fanout is a feature addition) + CHANGELOG roll

### Step 4.9 — Test
```
timeout 180 node --experimental-strip-types --import ./test/support/register-loader.mjs --test --test-force-exit test/unit/*.test.ts
```

→ **Oracle gate:** review full Phase 4 diff before declaring done.
