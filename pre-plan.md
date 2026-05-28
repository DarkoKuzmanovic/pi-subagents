# pre-plan.md — Adopt missing upstream features into pi-subagents fork

> Scratch pre-planning doc. Source: a `/recon` pass (2026-05-28) comparing our fork
> (`DarkoKuzmanovic/pi-subagents`, v0.31.1) against `upstream` (`nicobailon/pi-subagents`,
> `upstream/main` @ `86326d7`). Full synthesis was at `/tmp/recon-upstream/synthesis.md`
> (auto-cleaned after 24h — essentials embedded below).

## Goal

Adopt the genuinely-missing upstream capabilities, cheapest-first, big-and-risky last.
~60% of upstream's recent additions we **already have** (parallel fan-out, async/background
runs, worktrees, `maxSubagentDepth`, plus our own synthesizer agent + `/recon`). Do **not**
re-implement those.

---

## ⚠️ Execution rules for THIS repo (read before editing — non-obvious)

1. **`tsc --noEmit` / `npm run typecheck` is KNOWN-NOISY here.** This standalone extension dir
   has no installed `@types/node` and no `@earendil-works/*` peer deps, so typecheck emits
   hundreds of `Cannot find name 'process'` / host-type-resolution errors. **These are not your
   bug.** Do not chase them, do not loop on them, do not treat a clean typecheck as the gate.
2. **The real gate is the unit suite.** Run it SAFELY (it hangs without force-exit because the
   codebase uses activity timers that keep the event loop alive):
   ```
   cd /home/quzma/.pi/agent/extensions/pi-subagents
   timeout 180 node --experimental-strip-types --test --test-force-exit test/unit/*.test.ts
   ```
   Baseline as of v0.31.1: ~560 tests, ~4 pre-existing environmental failures (subagent child
   mode ×2 needing host deps, `~/.agents/skills` path resolution, worktree git timeouts).
   **Your changes must not add new failures beyond that baseline.**
3. **No hot-reload.** Editing extension source does NOT take effect in a running Pi session.
   To test runtime behavior (e.g. new prompt registration, fanout) you must **restart Pi**.
4. **Per-phase release hygiene** (see `AGENTS.md` › Versioning & releases): each shippable phase
   = version bump in `package.json` + roll `CHANGELOG.md` `[Unreleased]` into a dated section +
   commit. Don't batch unrelated phases into one commit.
5. **Inspect upstream's implementation directly** — the `upstream` remote is configured and
   fetched. Use `git show upstream/main:<path>` or `git diff HEAD upstream/main -- <path>`.
   Do NOT re-fetch unless stale.
6. **Oracle gates are USER-driven.** Your model-prompt forbids self-dispatching subagents (correct).
   After each phase, STOP and report; the user invokes `oracle` to review your diff before you
   proceed to the next phase.

---

## Ranked work items

### Phase 0 — VERIFY the soft gaps (cheap, de-risks the whole list)

Three items below came from upstream's CHANGELOG only; the authoritative git-diff lane did **not**
corroborate them. Confirm presence/absence in our code BEFORE building, so we don't duplicate or
chase phantoms:

- **Async per-child metadata persistence** (item #2) — read our `src/runs/background/async-execution.ts`
  and `async-job-tracker.ts`; compare to `git show upstream/main:` equivalents. Do we already persist
  per-child session metadata + support multi-child async resume-by-index?
- **Compact parallel-review enhancements** (item #5) — diff our `prompts/parallel-review.md` and
  `prompts/parallel-cleanup.md` vs upstream's. Do we lack the "numbered follow-up choices + autofix"?
- **Provider model labels** (item #6) — check upstream async-widget TUI rendering vs ours.
- **Intercom nested summaries** — read our `src/intercom/result-intercom.ts`; upstream modified it for
  compact nested-child summaries (dependency of the fanout feature).

→ **Oracle gate:** confirm the verified scope before any building.

### Phase 1 — Port the cheap prompt files (low risk, tiny effort)

- **`prompts/review-loop.md`** (item #3, MEDIUM) — upstream v0.24.3, commit `f653f09`. Parent-controlled
  worker→reviewer→worker cycle, stops when no fixes or cap reached. Copy file; confirm it auto-registers
  as a slash command (host reads the `prompts` contribution in `package.json`). Restart to verify `/review-loop`.
- **`prompts/gather-context-and-clarify.md`** + **`prompts/parallel-context-build.md`** (item #4, MEDIUM) —
  from upstream tree diff. Copy both. Verify registration.

  Get each via `git show upstream/main:prompts/<file>` — adapt model handles to our fleet if they hardcode any.

→ **Oracle gate** (quick). Ship as one minor version bump.

### Phase 2 — Async per-child metadata persistence (item #2, MED-HIGH) — only if Phase 0 confirms it's missing

Multi-child async resume-by-index + safer lifecycle status. Likely touches our existing async modules
(medium merge risk). Source: upstream v0.23.1.

→ **Oracle gate** before and after.

### Phase 3 — Nested child-safe fan-out (item #1, HIGH value, HIGH risk) — the big one, do last

Child agents get the `subagent` tool with **parent-visible status trees** + **by-run-id control** +
compact intercom child-summaries. **Our `maxSubagentDepth` is NOT a substitute** — it only prevents
runaway recursion; it gives no parent-visible status or control.

- **Upstream evidence:** v0.25.0, commits `8e02b1c` (fanout logic) + `86326d7` (release).
- **New files in upstream, absent from our tree:**
  - `src/extension/fanout-child.ts` — child agent fanout extension
  - `src/runs/shared/nested-events.ts` — nested run event types
  - `src/runs/shared/nested-path.ts` — nested run path resolution
  - `src/runs/shared/nested-render.ts` — nested run TUI rendering
  - `src/runs/background/run-id-resolver.ts` — by-run-id routing
  - `src/intercom/result-intercom.ts` — modified for compact nested child summaries
  - Upstream also ships tests for all of these: `test/unit/{nested-events,result-intercom,run-id-resolver,widget-nested-render}.test.ts` — port them alongside the source.
- **Verified divergence (2026-05-28, good news):** the 5 new source files are absent from our `src/` entirely (clean adds, no conflict). `src/intercom/result-intercom.ts` we already have as a base file; upstream's is **+108/−0** (purely additive nested-summary logic), so that file is low-risk to merge. The real divergence risk is concentrated in the shared files below, not these.
- **DO THIS FIRST (before writing any code):** line-level diff of the *shared* files upstream's fanout
  touches, which our fork has diverged on — `subagent-executor.ts`, `src/shared/types.ts`,
  `src/runs/shared/pi-args.ts`:
  ```
  git diff HEAD upstream/main -- src/runs/foreground/subagent-executor.ts src/shared/types.ts src/runs/shared/pi-args.ts
  ```
  Measure divergence, write the merge plan, THEN implement. This is the phase most likely to exceed a
  cheap worker's scope — if the divergence is large, STOP and hand the merge plan to the user/oracle
  rather than plowing ahead.

→ **Oracle gate** before implementation (review merge plan) AND after.

---

## Provenance / confidence

- Phase 1 + the fanout file list: **HIGH confidence** — triangulated across git-diff (authoritative),
  upstream CHANGELOG, and our inventory.
- Phase 0 / Phase 2 / items #5 #6: **MEDIUM/LOW** — CHANGELOG-only, git-diff did not confirm. Hence the
  verify-first phase.
- None of the recon lanes did a code-level merge-conflict analysis — that's Phase 3's first task.
