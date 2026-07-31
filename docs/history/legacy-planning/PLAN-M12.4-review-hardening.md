# PLAN — M12.4 review-hardening

Follow-on fixes from the M12 review (grok-4.5 reviewer, findings verified against source). Three independent outcomes; ship together as a patch bump.

## Scope decision

- **Tier:** Light
- **Risk:** contained ordinary — file-mode consistency, a truthful status label, and mechanical assertion removal. No new behavior surface, no protocol changes, no durable-state migration.
- **Delivery:** local, inline (no subagent dispatch needed — all three are small and surgical).
- **Evidence:** each fix verifiable by typecheck + existing tests + one targeted read of the changed line.

## Outcomes

### M12.4.1 — async-cfg file uses owner-only permissions

**Problem.** `spawnRunner` (`src/runs/background/async-execution.ts:224-226`) writes the async-runner config to `TEMP_ROOT_DIR` with default modes. The config carries `nestedRoute.capabilityToken`. Comparable stores (`run-handle-store.ts:180/237`, `nested-events.ts:125-127/561/1041`) all use `0o700` dirs + `0o600` files; this handoff file is the outlier.

**Fix.** Match the run-handle-store pattern:
- `mkdirSync(TEMP_ROOT_DIR, { recursive: true, mode: 0o700 })`
- chmod-if-pre-existing to `0o700` (mkdir mode doesn't apply when dir exists)
- `writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 })`

**Verify.** Read the changed lines; `test:unit` (no regression); spot-check that an async dispatch still launches (manual or existing integration test).

### M12.4.2 — `recover` reports truthful state instead of hardcoded "live"

**Problem.** `subagent-executor.ts:2604` returns `state: live` for every resolved run, including completed ones. Operators/models then attempt steer on dead work.

**Fix.** Derive the actual state from the same sources `inspectRun` uses:
- For async: read `status.json` (`state` field: running/complete/failed/paused).
- For nested: read the nested run summary state.
- For foreground (in-memory only): `live` is correct.
- Emit `live | completed | failed | paused | unknown` instead of hardcoding `live`.

Keep the existing disclaimer sentence ("Recovering a handle does not itself grant steering — use `attach` to verify").

**Verify.** `test:unit`; add or extend a recover test to assert a completed async run reports `completed`, not `live`.

### M12.4.3 — Remove non-null assertions (23 sites)

**Problem.** AGENTS.md bans `!.`; 23 remain in production `src/` (excluding `node-shims.d.ts`). Concentrated in array-index access in chain/parallel/worktree paths — masks empty-array as mid-run TypeError.

**Fix.** Mechanical sweep: replace each `x!` with an explicit guard. Two patterns:
- Array index after a length check: keep the access, drop `!` (TS narrows after `.length > 0` in many cases; otherwise assign to a typed const with a guard).
- Truly possibly-undefined: throw an actionable error (`throw new Error(\`<context>: expected <X>, got undefined\`)`).

No behavior change in the normal case. In the edge case, a clear error instead of a TypeError crash.

**Verify.** `grep -rnE '\!\.' src --include='*.ts' | grep -v node-shims` → 0. `typecheck`. `test:all` (the 23 sites are in hot paths — run the full suite).

## Out of scope (noted from the review, deferred)

- **M12 review Major #3 (FG/async spawn duplication):** overstated — both files already import shared `completion-guard`/`stream-budget`/`model-fallback` modules. Only the orchestration glue is duplicated; that's a `safe-refactoring` exercise, not a correctness fix. Park.
- **M12 review Major #4 (3065-line executor):** real but a structural refactor, high regression risk. Needs its own `crew`/`safe-refactoring` planning pass. Park.
- **Minors (inspectRun ambiguity, resetJobs handles, env filter):** bundle into a later housekeeping pass.

## Run metrics

(filled in as outcomes complete)

- dispatches: 0/0
- completed-outcomes: 0
- child-runtime-minutes: 0

## Close-out

M12.4.1 is done: owner-only directory and file modes are enforced at `src/runs/background/async-execution.ts:227-237`.

M12.4.2 is done through `inspectRun` delegation at `src/runs/foreground/subagent-executor.ts:2614-2627`. The plan's `live` / `completed` wording was superseded by the canonical `running` / `complete` vocabulary, and this close-out added a regression test.

M12.4.3 satisfied its stated acceptance check: `!.` dot-access sites are at 0. However, 139 broader-form non-null assertions remain repo-wide as separate pre-existing debt.