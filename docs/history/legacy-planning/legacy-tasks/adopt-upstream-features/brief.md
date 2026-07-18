# Task: adopt-upstream-features

**Created:** 2026-05-28
**Status:** scaffolded
**Test-first:** true — rich unit/integration test suite exists; `npm run test:unit` with `--test-force-exit` is the regression gate

## Goal

Adopt upstream features into the pi-subagents fork across 5 ranked phases: verify soft gaps (Phase 0), port cheap prompt files (Phase 1), add Nested* types needed by async metadata (Phase 2), implement async per-child metadata persistence (Phase 3), and implement nested child-safe fan-out (Phase 4).

## In-scope files

**Phase 1 — Prompt files (all absent from fork, all confirmed in upstream):**
- `prompts/review-loop.md` — parent-controlled worker→reviewer→worker loop with stop-on-clean or cap
- `prompts/gather-context-and-clarify.md` — subagent context gathering then clarifying questions
- `prompts/parallel-context-build.md` — parallel fresh-context `recon` agents for handoff

**Phase 2 — Nested* types (pre-requisite for Phase 3 and Phase 4):**
- `src/shared/types.ts` — add `NestedRunSummary`, `NestedRouteInfo`, `NestedRunMatch`, `NestedRunResolutionScope` from upstream (purely additive, no name collisions)
- `src/runs/shared/pi-args.ts` — add `NestedAsyncDir` and `NestedRouteInfo` env vars to `BuildPiArgsInput`

**Phase 3 — Async per-child metadata (Phase 0 confirmed needed):**
- `src/runs/background/async-execution.ts` — already exists; add `nestedChildren: NestedRunSummary[]` to `AsyncJobState`
- `src/runs/background/async-job-tracker.ts` — already exists; add per-child session metadata + resume-by-child-index

**Phase 4 — Fanout (5 new files absent, clean adds; 3 shared files need divergence merge):**
- `src/extension/fanout-child.ts` — new, absent — child agent fanout extension
- `src/runs/shared/nested-events.ts` — new, absent — nested run event types
- `src/runs/shared/nested-path.ts` — new, absent — nested run path resolution
- `src/runs/shared/nested-render.ts` — new, absent — nested run TUI rendering
- `src/runs/background/run-id-resolver.ts` — new, absent — by-run-id routing
- `src/intercom/result-intercom.ts` — already exists; upstream is +108/−0 purely additive
- `src/runs/foreground/subagent-executor.ts` — existing; upstream diverges by +520/−197 lines
- `src/shared/types.ts` — existing; upstream diverges by +118/−0 lines
- `src/runs/shared/pi-args.ts` — existing; upstream diverges by +78/−0 lines

## Out-of-scope

- Do not re-implement existing parallel fan-out, async runs, worktrees, `maxSubagentDepth`, synthesizer agent, or `/recon` slash command
- Do not touch `src/extension/control-notices.ts`, `src/extension/doctor.ts`, `src/extension/schemas.ts` — not involved
- Do not add new test files unless Phase 4 ports upstream tests alongside source

## Acceptance criteria

- [ ] Phase 1: `/review-loop`, `/gather-context-and-clarify`, `/parallel-context-build` slash commands register after restart
- [ ] Phase 1: `npm run test:unit -- --test-force-exit` passes with no new failures
- [ ] Phase 2: `src/shared/types.ts` has `NestedRunSummary`, `NestedRouteInfo`, `NestedRunMatch`, `NestedRunResolutionScope`; `pi-args.ts` has `NestedAsyncDir` env var
- [ ] Phase 2: `npm run test:unit -- --test-force-exit` passes with no new failures
- [ ] Phase 3: `async-job-tracker.ts` persists per-child session metadata via `nestedChildren: NestedRunSummary[]`; async resume works by child index
- [ ] Phase 3: `npm run test:unit -- --test-force-exit` passes with no new failures
- [ ] Phase 4: fanout new files added (`fanout-child.ts`, `nested-events.ts`, `nested-path.ts`, `nested-render.ts`, `run-id-resolver.ts`)
- [ ] Phase 4: `subagent-executor.ts` merged cleanly with upstream divergence
- [ ] Phase 4: `npm run test:unit -- --test-force-exit` passes with no new failures
- [ ] Each phase: version bump in `package.json` + CHANGELOG `[Unreleased]` rolled into dated section

## Constraints

- **Test gate only**: `tsc --noEmit` is noisy (no `@types/node`, no peer deps installed) — ignore it; unit tests are the real gate
- Run tests with: `timeout 180 node --experimental-strip-types --test --test-force-exit test/unit/*.test.ts`
- No hot-reload: restart Pi to test runtime behavior (slash command registration, fanout TUI)
- Per-phase releases: each shippable phase = version bump + CHANGELOG roll
- Oracle gates: stop after each phase, await oracle review before proceeding to next phase

## Gotchas

- Phase 4 `subagent-executor.ts` has massive divergence (+520/−197): do line-level diff BEFORE writing merge plan
- `result-intercom.ts` is +108 lines purely additive — low-risk merge
- Upstream tests for fanout: port `test/unit/{nested-events,result-intercom,run-id-resolver,widget-nested-render}.test.ts` alongside source
- `MUTATING_MANAGEMENT_ACTIONS = new Set(["create","update","delete"])` appears in upstream's subagent-executor — verify it doesn't conflict with existing management logic
- Existing unit test baseline: ~560 tests, ~4 pre-existing environmental failures (subagent child mode ×2, `~/.agents/skills` path, worktree git timeouts)
