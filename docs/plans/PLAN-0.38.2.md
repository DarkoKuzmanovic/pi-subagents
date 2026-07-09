# Plan: 0.38.2 — cheap-driver envelope tolerance + reconciliation polish

Findings verified against source on 2026-06-12 (post-v0.38.1). Each item below
was traced to code by the reviewer; disproven claims from the original
recon reports are listed at the bottom so they are not re-litigated.

## 1. H2 — stringified-JSON tolerance for `chain` / `tasks` params (MEDIUM, the headline)

**Why:** Cheap drivers (Qwen Flash, Kimi-class) JSON-stringify nested tool
params. This exact defect hit `roux_record` and `ask_user` in production on
2026-06-11. `subagent` is the dispatch tool Roux's cheap driver uses; its
`chain` and `tasks` arrays have no tolerance — only `config` does
(`configObject`, `src/agents/agent-management.ts:45-55`).

**Shape:**
- Pure helper `coerceArrayParam(raw: unknown, name: string)` (suggest
  `src/shared/utils.ts`): string → `JSON.parse` → must be array, else throw a
  driver-readable refusal (`"chain must be an array (got string that parsed
  to object). Pass a literal JSON array."`). Array → pass through.
- Wire at the entry seam in `src/runs/foreground/subagent-executor.ts`
  (~line 807 `hasChain && params.chain`) for `chain` and `tasks`, BEFORE any
  `.length` access. Also coerce nested `parallel` arrays inside chain steps,
  and stringified step objects inside the arrays (drivers stringify at any
  depth — roux saw the leaf-object form).
- Schema: widen `chain`/`tasks` to `Type.Union([array, Type.String()])` with
  description preferring literal arrays (mirror RouxRecordParamsSchema).
- Tests: valid JSON-string array accepted; non-JSON string refused with the
  exact message; object (non-array) refused; pass-through untouched;
  stringified nested step coerced.

## 2. F2 — drain-SIGTERM drops stderr (LOW, verified valid)

`forcedDrainAfterFinalSuccess` (foreground `execution.ts` ~627-631, async
`subagent-runner.ts` ~378-385) deliberately treats our own drain-kill as
success — correct — but silently discards stderr captured before the kill.

**Fix:** keep exitCode 0; attach a `[drain-kill]` note carrying the stderr
tail (last ~10 lines) to the result details/output instead of dropping it.
Do NOT set `error` (would re-fail recovered runs we just fixed in 0.38.1).

## 3. result-watcher: mark-seen-before-delivery (LOW, verified — narrower than reported)

`src/runs/background/result-watcher.ts`: `markSeenWithTtl` runs (~line 94)
BEFORE the `pi.events.emit` + unlink (~147-148). If a subscriber throws
synchronously, the catch leaves the file on disk — but the retry then hits
the dedupe branch and unlinks WITHOUT emitting. Result permanently dropped.

**Fix:** mark seen only after successful emit (or unmark in the catch).
The original "no ack from subscribers" framing was overstated: data is fully
parsed in memory before emit and emit is synchronous.

## 4. Worktree SIGKILL residue (LOW, verified — different from reported)

Partial-failure cleanup EXISTS (`createWorktrees` catch, `worktree.ts:508-515`)
— that half of the claim was wrong. Real residue after SIGKILL: the /tmp dirs
are OS-cleaned eventually, but the repo keeps dangling `.git/worktrees/`
metadata and `pi-worktree-*` branches forever.

**Fix:** opportunistic sweep at extension startup or in the stale-run
reconciler: `git worktree prune` + delete `pi-worktree-<runId>-*` branches
whose runId has a terminal/absent status. Must never touch branches of live
runs — check run liveness first.

## Disproven — do not implement

- **queued→running auto-promotion without status file** (`async-job-tracker.ts`
  ~204): the promotion line is INSIDE `if (status) {}`; it cannot run when no
  status was read. Context-builder misread block structure.
- **`buildSuccessRepair` accepts `exitCode: null` as success**: deliberate and
  guarded — success repair only fires when PID is dead AND every step is
  terminal-complete (`allStepsSucceeded`, `stale-run-reconciler.ts:262-268`).
  A runner dying mid-step leaves status "running" → no success repair.
- **non-atomic `appendJsonl`**, **EPERM→24h stale window**, **per-process
  dedup**, **control-event rotation loss**: examined 2026-06-11, downgraded
  (defensive/deliberate; readers skip partial lines).

## Order & verification

1 (H2) → 2 (F2) → 3 (result-watcher) → 4 (worktree sweep). Each with tests in
the existing suites; full `npm run test:unit` + `test:integration` green
before release; promote CHANGELOG `[Unreleased]` → 0.38.2.
