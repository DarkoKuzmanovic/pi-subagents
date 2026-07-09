# PR #4 — Synthesized Review & Implementation Plan

**PR:** docs(plan): scope v0.40.0 — async parity & cost control
**Head:** `dfb2379`  ·  **Base:** `main`
**Feature under review:** async/detached dynamic-fanout parity (lift the v0.39.0 foreground-only guard)
**Reviewers:** claude-opus-4-8, MiniMax-M3, gpt-5.5, glm-5.2 (+ Codex inline)
**Unified verdict:** ❌ Request changes — 4 blocking issues, all in the *parity* surface. Core materialize→splice→collect execution path is sound; no execution or collected-output corruption found.

> Line refs are against PR head `dfb2379`. **All findings below independently re-verified against the PR source** (read, not trusted). One reviewer claim was found *backwards* and corrected — see S4. Minor reviewer citation error: the `flatToLogicalStepIndex`/`normalizeParallelGroups` file is `runs/background/parallel-groups.ts`, not `runs/shared/`. Two polish items (P2 identical-operands, P4 item-key format) remain unverified and are marked as such.

---

## Synthesized review (deduplicated, agreement-weighted)

### What's correct (confirmed by multiple reviewers)
- **Splice alignment.** On a `RunnerDynamicStep`, all six per-flat-index arrays (`statusPayload.steps`, `flatSteps`, `stepEscalationStartedAt`, `mutatingFailureStates`, `pendingToolResults`, mutable `childIntercomTargets`) are spliced at the same `flatIndex` (`subagent-runner.ts:1717-1722`), and `flatIndex` is deliberately not advanced before `continue`, so the injected group runs at `groupStartFlatIndex === flatIndex`.
- **Collect ordering.** `mapConcurrent` returns in `taskIdx` order; `collectDynamicResults` maps `items[i]→results[i]` positionally. `hardFailure` gate correctly excludes fail-fast skips (-1) while aborting on genuine item failure.
- **Documented async-only caveats** (no per-item session files/intercom; `context:"fork"` does not fork per item) are accurate and match the code.

### BLOCKING defects

**B1 — Progress-suppression parity gap** *(opus, minimax, glm: required)*
`buildDynamicStep` builds the per-item template with `task: DYNAMIC_ITEM_TASK_SENTINEL` (`async-execution.ts:421`) and runs it through `buildSeqStep`, which computes `suppressProgressForReadOnlyTask(…, s.task, originalTask)` against the literal sentinel (`async-execution.ts:366,432`). The real per-item text is only substituted later, at runtime (`subagent-runner.ts:1701`). The foreground path recomputes against the actual task (`chain-execution.ts:816`). ⇒ async fanout emits progress instructions for read-only per-item tasks that foreground would suppress — a genuine behavioral divergence, not cosmetic.

**B2 — Stale `parallelGroups` / `chainStepCount` after materialization** *(all 4 + Codex inline: required)*
Pre-loop builds `statusPayload.parallelGroups` skipping dynamic steps (`subagent-runner.ts:932-942`) and sets `chainStepCount = steps.length` (`:964`). The materialize branch only *pushes* the new group (`:1723`) and never (a) bumps the `start` of already-recorded trailing groups by `count`, nor (b) updates `chainStepCount` post-splice. Consequences:
- `[…, dynamic, static-parallel]`: the trailing static group's `start` is undercounted by `count` → mislabeled/lost parallel progress.
- Final fanout: `stepIndex+1 == chainStepCount` → `normalizeParallelGroups()` drops the fanout group entirely (Codex).
- Even `[seq, dynamic, seq]` mislabels the step counter in the status renderer (`async-status.ts:249-260`) (gpt-5.5).

**B3 — `parallel.lane` on a dynamic-fanout template is silently ignored** *(gpt-5.5: required; re-verified)*
`DynamicParallelTemplate` retains `ParallelTaskItem.lane`, and the schema/helper accept it (`dynamic-fanout.ts:45`), but `applyResolvedLaneToChainStep` only resolves static parallel arrays and `SequentialStep`s (`subagent-executor.ts:1073-1095`) — a `DynamicParallelStep` matches neither. `buildDynamicStep` copies `model`/`thinking` from the template but not `lane` (`async-execution.ts:428-429`). ⇒ a user-facing typed field is dropped for both foreground and async dynamic fanout.

**B4 — Dynamic materialize/collect failures fail the run without marking any status step** *(gpt-5.5: required; re-verified)*
Final `statusPayload.error` is derived only from `steps.find(s => s.status === "failed")` (`subagent-runner.ts:2015-2019`). The materialize catch (`:1677-1681`) and collect-schema catch (`:1688-1691`) push a failed *result* and `break`, but never set a `steps[].status = "failed"` or `statusPayload.error`. ⇒ `onEmpty:"fail"`, `maxItems` violation, unknown source output, and collect-schema mismatch all produce a failed run whose `status.json` gives no reason.

### SHOULD-FIX (high-value, non-blocking)

**S1 — NUL-byte sentinel makes `async-execution.ts` a binary file** *(glm; corroborated: `gh` reports `0+/0-` = binary patch for this file).* `DYNAMIC_ITEM_TASK_SENTINEL = "\u0000@@…@@\u0000"` (`async-execution.ts:24`). `main` has zero NUL bytes; no `.gitattributes`. ⇒ GitHub renders the guard-removal diff as opaque binary; file is no longer greppable without `-a`. Replace with a printable, collision-unlikely token — fully substituted out before dispatch (`:1701`), so zero behavior change.

**S2 — `onEmpty:"skip"` path never emits `subagent.fanout.materialized`** *(minimax).* `:1684-1696` writes outputs and `continue`s without the event that CHANGELOG advertises as the fanout signal. Emit with `count: 0`, or document the omission.

**S3 — Stale tool-schema description.** `schemas.ts:99` says `maxItems` is required unless `config.chain.dynamicFanout.maxItems` is set, but the implemented key is the flat `dynamicFanoutMaxItems` (`types.ts:565`, `README.md:943`) *(gpt-5.5, minimax).*

**S4 — `dynamicFanoutMaxItems` is effectively required-but-undocumented.** ⚠️ *Reviewer framing corrected.* MiniMax/others framed this as an "unbounded fork" risk — that is **backwards and refuted by the code**: `resolveDynamicFanoutItems` throws `requires an effective maxItems` (`dynamic-fanout.ts:185,216`) when both `expand.maxItems` and `config.dynamicFanoutMaxItems` are undefined, and there is **no numeric default anywhere**. So there is no unbounded path; the actual defect is the opposite — dynamic fanout is **unusable out-of-the-box**: a user who omits per-call `expand.maxItems` and doesn't know the undocumented flat config key hits a hard error. Fix = **add a sane finite default at `config.ts` load** (so fanout works without ceremony) *and/or* document the key; not "add a cap." `config.ts` (16 lines) returns `{}` with no default; key defined at `types.ts:565`.

### POLISH

- **P1** — Materialize-failure event emits `stepIndex: flatIndex` (unspliced slot, `:1680`); success path emits against the spliced/logical slot. Use `dynStepIndex` for consistency *(minimax, opus, glm).*
- **P2** — Dead `?? config.dynamicFanoutMaxItems` fallback (`:1676`): both operands are `params.dynamicFanoutMaxItems` *(glm).*
- **P3** — Extract the 3–4× duplicated `DynamicFanoutError ? … : Error ? … : String(error)` idiom into `formatMaterializationError(err: unknown): string` (`:1678,1689` + collect epilogue) *(opus, minimax, glm).*
- **P4** — Async hard-failure results drop the expanded-item `key`; foreground stamps `Item K (agent, key X)` (`chain-execution.ts:897-900`). Stamp the key on pushed per-item results (`:1603-1617`) *(glm).*

### Test gaps (unanimous)
`onEmpty:"fail"` · `collect.outputSchema` mismatch (validation-break) · per-item hard-failure chain abort · `maxItems` exceeded · **`[…, dynamic, static-parallel]`** (the B2 shape) · parent interrupt mid-fanout · `context:"fork"` template · `parallel.lane` (B3). The current harness covers only happy-path + `onEmpty:"skip"`.

### Doc gaps
- Progress-suppression divergence (B1) undocumented — add a third async-only caveat if B1 is deferred rather than fixed.
- `dynamicFanoutMaxItems` missing from README config docs / CHANGELOG Added (S4).
- PLAN-0.40.0 Tier-1 acceptance mentions a "live async run" test — verify it was performed or downgrade the criterion.

---

## Implementation plan

Ordered to unblock merge first, then harden. Each phase ends green (`npm run check && npm test`).

### Phase 0 — Cleanup that de-risks the diff (do first)
- [ ] **S1** Replace the NUL-byte sentinel with a printable token, e.g.
      `const DYNAMIC_ITEM_TASK_SENTINEL = "\uE000PI_SUBAGENTS_DYNAMIC_ITEM_TASK\uE000";`
      (PUA char — printable, effectively collision-proof, keeps file text). File: `async-execution.ts:24`. Verify `git show dfb2379:…` no longer reports binary and diff renders as text.
- [ ] **P2** Drop the dead `?? config.dynamicFanoutMaxItems` at `subagent-runner.ts:1676`.
- [ ] **P3** Add `formatMaterializationError(err: unknown): string` and replace the 3–4 duplicated ternaries.

### Phase 1 — Blocking correctness
- [ ] **B2** In the materialize splice (`subagent-runner.ts:1717-1726`): (a) bump `start` of every existing `statusPayload.parallelGroups` entry with `start >= flatIndex` by `count`; (b) **fix the pushed group's own `stepIndex`** — it is currently `stepIndex + 1`, which mislabels even `[seq,dynamic,seq]` (the fanout shows as "step 3/3" instead of 2/3); it should be the dynamic step's *logical* index, not the post-splice array position. Note: for shapes where the dynamic step is not followed by a static parallel group, `chainStepCount` likely does **not** change (the fanout occupies the dynamic step's single logical slot) — verify per shape rather than blindly setting it to the flat length. File: `src/runs/background/parallel-groups.ts` (NOT `shared/`) holds `flatToLogicalStepIndex` (:26) + `normalizeParallelGroups` (:19); renderer at `async-status.ts:249-267`. Pin with both the `[…, dynamic, static-parallel]` and `[seq, dynamic, seq]` tests.
- [ ] **B1** Recompute `suppressProgressForReadOnlyTask` against the *resolved* per-item task at materialization time (`subagent-runner.ts` around the sentinel substitution, `:1699-1702`), matching the foreground contract (`chain-execution.ts:816`). *If explicitly deferred instead:* add a third async-only caveat in `README.md:673` + `CHANGELOG.md` (Phase 4).
- [ ] **B3** Resolve `parallel.lane` → concrete `model`/`thinking` before both foreground and async execution. Extend `applyResolvedLaneToChainStep` (`subagent-executor.ts:1073-1095`) to handle the dynamic-fanout template, and/or carry the resolved lane through `buildDynamicStep` (`async-execution.ts:428-429`). Refs: `settings.ts:69-84,108,663-666`.
- [ ] **B4** In the materialize catch (`:1677-1681`) and collect-schema catch (`:1688-1691`), set `statusPayload.error` (and/or mark an appropriate `steps[]` entry `failed`) so `status.json` explains dynamic setup/collect failures — matching the final-error derivation at `:2015-2019`.

### Phase 2 — Status/event consistency (polish)
- [ ] **P1 / S2** Emit `subagent.fanout.materialized` with `count: 0` on the `onEmpty:"skip"` path (`:1684-1696`); emit the materialize-*failure* event against `dynStepIndex` rather than the unspliced `flatIndex` (`:1680`).
- [ ] **P4** Stamp the expanded-item `key` onto pushed per-item results in the async hard-failure path (`:1603-1617`) to match foreground diagnostics.

### Phase 3 — Tests (extend `test/integration/async-dynamic-fanout.test.ts`; unit where noted)
- [ ] **`[…, dynamic, static-parallel]`** — asserts B2 (status `parallelGroups.start` / `chainStepCount` / renderer labels). *Highest priority — it's the most likely real-world shape.*
- [ ] `onEmpty:"fail"` → `DynamicFanoutError`, and status carries the reason (B4).
- [ ] `collect.outputSchema` mismatch → validation-break, status carries the reason (B4).
- [ ] per-item hard failure aborts chain (`:1661-1663`) — currently asserted only by comment.
- [ ] `maxItems` exceeded → rejection (`dynamic-fanout.ts:217`).
- [ ] `parallel.lane` resolves to concrete model/thinking (B3).
- [ ] `context:"fork"` template (verifies the documented caveat).
- [ ] parent interrupt/abort mid-fanout (childInterrupts on materialized items).

### Phase 4 — Docs & config
- [ ] **S3** Fix `schemas.ts:99` to name the flat `dynamicFanoutMaxItems`.
- [ ] **S4** Add a **finite default** for `dynamicFanoutMaxItems` at `config.ts` load (fanout currently hard-errors without a per-call `expand.maxItems` — see corrected S4 above; this is a usability fix, not an unbounded-fork guard), and document the key in `README.md` + CHANGELOG Added. Do NOT frame as "add a cap to prevent runaway fork" — the mandatory cap already exists.
- [ ] If B1 was deferred, add the third async-only caveat (`README.md:673` + CHANGELOG).
- [ ] Verify PLAN-0.40.0 Tier-1 "live async run" acceptance was performed, or downgrade the criterion.

### Sequencing note
Phase 0 + Phase 1 are the merge gate (all four blocking issues + the binary-file hygiene). Phase 3's `[…, dynamic, static-parallel]` test should land in the same commit as B2 so the fix has a regression guard. Phases 2/4 can follow in the same PR or a fast follow-up.
