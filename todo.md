# pi-subagents — TODO

This file is the long-lived product backlog for the local `pi-subagents` fork. It is intentionally opinionated: items are grouped by what to build next, what to keep warm, and what to reject unless a real user asks for it.

## Now / next

- [ ] **Async runner-death / stale-reconciliation data-loss** — the background runner process repeatedly exits before writing its consolidated result; runs are then marked failed (or "reconstructed") by stale-run reconciliation even though every child step completed and per-step `output-N.log` artifacts are intact. Observed **3× in a single session** (parallel reviewer run, the qwen/minimax compaction benchmark `8d0ce5b7`, and the deepseek/gpt-5.5 audit `deb83f54`). Impact grew after `c567660` routed more chains through async (see below). Fix direction: make the orchestrator reconstruct the final result from completed per-step artifacts instead of marking the run failed when the runner dies post-completion; investigate why the runner process exits early (signal/exit-drain/post-exit-stdio-guard interaction in `subagent-runner.ts`). High priority — it silently loses otherwise-valid work.
- [ ] **Revisit async-by-default routing for recon chains (`c567660`)** — `c567660` changed chain `effectiveAsync` from `requestedAsync && (hasChain ? clarify === false : clarify !== true)` to `requestedAsync && clarify !== true`. With user config `asyncByDefault: true`, chains that omit `clarify` now route to the background runner, exposing the runner-death + (now-fixed) completion-guard paths far more often. This is the real reason guard/dispatch failures "started yesterday." Decide whether short read-only recon chains (e.g. scout-led) should prefer foreground, or whether the async path just needs the reconciliation fix above. Not a bug in `c567660` itself — it surfaced latent async-path fragility.
- [ ] **Persistent / warm subagent workers** — keep a small pool of child `pi` worker processes/session shells alive so dispatch can reuse an already-loaded agent instead of paying full Pi startup/extension-load cost every task. Targets the user pain point: latency waiting for fresh child Pi sessions. Different from true in-process sessions: still separate processes for crash isolation, but warmed and reusable. Needs design for worker identity, idle timeout, context reset between tasks, session attachment/resume semantics, cancellation, and safe tool/extension reconfiguration.
- [ ] **Mid-run steering** — inject a message into a running subagent without killing it. This is the primitive that unlocks better long-running-worker UX: course-correct, ask for wrap-up, or answer a child’s question. Requires: child-process IPC channel or intercom delivery, parent-side `subagent` action `steer`, and a way for a child `pi` session to receive an injected user message mid-turn.

## Keep — high-leverage backlog

- [ ] **Attach/detach UX for background subagents** — let the parent join a running async child, watch live output, steer if supported, then detach again. Builds on async runner, status/revive, and the conversation-viewer idea.
- [ ] **Pending-work-aware completion semantics** — prevent parent/chain completion from claiming done while delegated children, background shells, or session jobs are still running. Audit `subagent-executor.ts`, `async-execution.ts`, and completion guards.
- [ ] **Graceful truncation for oversized subagent output** — return `PARTIAL — full output at <path>` instead of failing or flooding the parent when a child produces huge output. Result files already exist; add a consistent envelope.
- [ ] **Live status surface** — replace “open `/subagents` to check status” with an always-visible widget or compact status line showing active agents, elapsed time, activity, and attention state. Pair with the conversation viewer.
- [ ] **Conversation viewer overlay** — live-scroll any running/completed child transcript with auto-follow and pause-on-scroll. Useful before full attach/detach exists.
- [ ] **Lifecycle events on `pi.events`** — emit `subagents:created/started/completed/failed/steered/compacted` with stable envelopes so other extensions can react.
- [ ] **Cross-extension RPC** — after lifecycle events exist, add `subagents:rpc:spawn|stop|ping` with `requestId` reply channels and protocol versioning.

## Keep — defensive polish when touching nearby code

- [ ] **Fix compact glyph / live-detail render regression** — `test/integration/render-fork-badge.test.ts` has 2 pre-existing failures (`uses glyph-first compact rendering for completed subagents`, `shows live detail hints for running subagents`). Unrelated to lineage; surfaced during 0.34.0. Unit suite is green; only `test:integration` is affected. **Verified root cause (per MiniMax-M2.7 review of d3ac9a9):** the `live detail` failure is a key-text mismatch — the test asserts `Press Ctrl+O for live detail` but `render.ts` emits `Press app.tools.expand for live detail`, i.e. `keyText("app.tools.expand")` returns the raw action id instead of the bound key glyph under the test theme/keymap mock. Fix is either (a) resolve the keybinding to `Ctrl+O` in the render path, or (b) update the test mock to bind `app.tools.expand` so `keyText` resolves. The `glyph-first` failure is a separate expected-glyph drift (checkmark/turn glyphs) in the same file — confirm whether it shares the same theme-mock gap before changing render logic. Earlier hypothesis (`ProgressSummary`/`AgentProgress` type mismatch / wrong-arity call at render.ts ~950/1055) is unconfirmed and likely a red herring for these two assertions.

- [ ] **Recursive self-dispatch guard test** — verify `maxSubagentDepth` prevents recursive chain/skill self-dispatch at runtime, not just in config.
- [ ] **Consecutive-block cap for completion guards** — if hook/guard blocks repeatedly, stop after a bounded cap with a warning. Add `PI_SUBAGENT_STOP_HOOK_BLOCK_CAP` override.
- [ ] **`--json` / structured output for `subagent { action: "list" }`** — enables status bars, dashboards, and scripting without parsing human text.
- [ ] **Time-warmed spinner/status colors** — green <30s, amber 30–120s, red >120s in `/subagents` or the future live status surface.

## Park / needs stronger demand

- [ ] **`/goal` completion-condition loops** — “keep working until tests pass / condition is true.” Powerful but broad; probably a dedicated `worker-goal` agent or chain, not a flag on every agent.
- [ ] **Cron/interval/one-shot scheduling** — session-scoped scheduled agents. Useful, but large surface area and safety implications; defer until there is a real recurring-job use case.
- [ ] **Projected context cost in `subagent { action: "list" }`** — estimate per-agent token/cost from historical runs. Nice for budgeting, not essential.
- [ ] **Awaiting-input count in terminal tab title** — useful only after steering/blocking-child UX exists.
- [ ] **"Summarize up to here" for chain runs** — compress earlier chain artifacts while keeping recent outputs intact. Defer until chains routinely overflow.

## Ditch unless requirements change

- [ ] **In-process sessions instead of child `pi` processes** — faster startup, but loses crash isolation and would require a major rewrite. Prefer warm separate workers first.
- [ ] **Claude Code-style API aliases** — `Agent` / `get_subagent_result` aliases would add surface area and two mental models. Keep the native `subagent` API.
- [ ] **Type-only import for `MemoryScope`** — intentionally skipped because `MemoryScope` is still a pure type. Changing to a runtime import would break.

## Done archive

- [x] **Lineage-only subagent context** — `context: "lineage"` clean child sessions linked to the parent session tree without copying the parent transcript; resolver, executor wiring, schema/types/agent-config, `[lineage]` render badge, README, tests. Shipped in 0.34.0. Plan: [`docs/plans/2026-05-29-lineage-only-subagent-context.md`](./docs/plans/2026-05-29-lineage-only-subagent-context.md).

- [x] `serializeAgent` preserves `disallowedTools` and `memory` (956b905)
- [x] `cloneOverrideValue` preserves `disallowedTools` and `memory` (956b905)
- [x] `formatAgentDetail` displays `disallowedTools` and `memory` (956b905)
- [x] CHANGELOG entries for shipped review fixes (6abf540)
- [x] Round-trip regression test for serializer (956b905)
- [x] `readMemoryIndex` symlink TOCTOU race fix (1884b2f)
- [x] Write-time 200-line cap enforcement via `enforceLineCap` (358af3d)
- [x] Line-cap assertion cleanup (4f98fa3)
- [x] Unicode normalization guard in `isUnsafeName` (da0f86c)
- [x] `resolveMemoryDir` switch default case (4b95bb6)
- [x] Skill-preload assertion strengthening (889cade)
