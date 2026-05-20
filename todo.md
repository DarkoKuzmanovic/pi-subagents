# pi-subagents — TODO

Follow-up items from the review of commits 3ae405a, 6271a88, 849d466.
Full review: [`review-3-commits.md`](./review-3-commits.md). Fixes already shipped: 956b905, 6abf540.

## Done

- [x] BLOCKER 1 — `serializeAgent` drops `disallowedTools` and `memory` (956b905)
- [x] BLOCKER 2 — `cloneOverrideValue` drops the same fields (956b905)
- [x] MAJOR 1 — `formatAgentDetail` doesn't display these fields (956b905)
- [x] MAJOR 2 — CHANGELOG entries for the three features (6abf540)
- [x] NEW — Round-trip regression test for serializer (956b905)
- [x] MINOR 1 — TOCTOU race in symlink check on `readMemoryIndex` (1884b2f)
- [x] MINOR 2 — No write-time 200-line cap enforcement: extracted `enforceLineCap` (358af3d)
- [x] MINOR 3 — Confusing assertion in line-cap test (4f98fa3)
- [x] NIT 4 — No Unicode normalization guard in `isUnsafeName` (da0f86c)
- [x] NIT 5 — `resolveMemoryDir` switch has no default case (4b95bb6)
- [x] NIT 7 — Weak first assertion in skill-preload test (889cade)

## Intentionally Skipped

- [ ] NIT 6 — Type-only import for `MemoryScope` **skipped**: `MemoryScope` is still a pure type (`export type MemoryScope = "project"`). Changing to non-type import would cause a runtime error. Defer until it gains a runtime value.

## Ideas to port from tintinweb/pi-subagents

From comparison of [github.com/tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents). Ranked by value-to-effort. Already shipped: persistent memory, tool denylist, skill preloading.

### High value

- [ ] **Mid-run steering** — inject a message into a running subagent without killing it. Theirs exposes `steer_subagent({ agent_id, message })`; the message interrupts after the current tool call. Game-changer for long-running workers going off-track. Requires: child-process IPC channel (stdin pipe or signal+file), parent-side `subagent` action `steer`, and a way for the child `pi` session to receive an injected user message mid-turn. Architectural — needs design before code.

- [ ] **Live above-editor widget** — persistent widget showing active agents, spinners, tool activity, token %/context utilization, status icons. Currently `/subagents` is modal — must open to see status. Ours has the TUI hub (`src/tui/`) — extend or add a widget renderer that registers via Pi's widget API (check `docs/tui.md`). Async runner already tracks progress; this is mostly a rendering surface.

- [ ] **Lifecycle events on `pi.events`** — emit `subagents:created/started/completed/failed/steered/compacted` so other extensions can react. Standardize a reply envelope (`{ success: true, data }` / `{ success: false, error }`). Low-effort, high-leverage: enables ecosystem integration. Add to `subagent-executor.ts` / `async-execution.ts` completion paths.

- [ ] **Cross-extension RPC** — `subagents:rpc:spawn|stop|ping` event handlers with `requestId`-scoped reply channels and protocol versioning. Lets other extensions delegate without importing pi-subagents directly. Builds on lifecycle events above.

### Medium value

- [ ] **Conversation viewer overlay** — live-scrolling overlay for any running/completed agent's transcript. Auto-follow new content, pause on scroll-up. Pairs with the widget — select an agent in the widget, open viewer. Currently you wait for the result file or tail JSONL manually.

- [ ] **Cron/interval/one-shot scheduling** — `schedule: "0 0 9 * * 1"` or `"5m"` or `"+10m"`. Session-scoped jobs with PID-locked persistence under `.pi/subagent-schedules/<sessionId>.json`. Useful for recurring research/status agents. Restrictions: incompatible with `inherit_context`/`resume`, forces background. Significant surface area — only do if there's real demand.

- [ ] **Graceful turn limits with steering-based wrap-up** — at `max_turns`, send wrap-up steering message, allow N grace turns, hard-abort only after. Produces clean partial results instead of mid-tool cutoff. Depends on steering primitive landing first.

### Low value / probably won't port

- [ ] **In-process sessions instead of child `pi` processes** — theirs runs agents as sessions in the same pi process. Faster startup, no spawn cost, but loses crash isolation. Major architectural rewrite of `subagent-executor.ts`. Trade-off doesn't clearly favor either direction for our orchestration-pipeline use case.

- [ ] **Claude Code-style API alias** — register `Agent` / `get_subagent_result` as aliases that map to our `subagent` modes. Familiarity for CC users, but adds surface area and two mental models. Skip unless users ask.

## Ideas from Claude Code changelog (May 2026, v2.1.126–2.1.145)

Scan of [code.claude.com/docs/en/changelog](https://code.claude.com/docs/en/changelog) since 2026-05-01. Filtered to subagent-orchestration relevance only.

### High value

- [ ] **`/goal` — completion-condition-driven loops** (CC 2.1.139). Set a condition ("until tests pass", "until diff matches spec") and the agent auto-continues across turns until met. Different shape from chains: not "do N steps" but "loop until verified." Pairs naturally with `worker`. Implementation: (a) goal evaluator (LLM call or hook) after each turn, (b) turn-budget cap to prevent runaway, (c) live progress overlay (elapsed/turns/tokens). Probably a `worker-goal` agent variant rather than a flag on every agent. Highest-novelty idea in the entire changelog.

- [ ] **Attach/detach UX for background subagents** (CC 2.1.139–2.1.145, `claude agents` + `claude --bg` + `←`-detach). Today our async runs are poll-only: `subagent { action: "status" }`. CC lets you *join* a running background session, watch live output, optionally steer, detach again. Big UX leap on infrastructure we already have (async runner, job tracker). Pairs with the conversation-viewer overlay already in this todo.

- [ ] **Pending-work-aware completion semantics** (CC 2.1.143–2.1.145). `Stop` / `SubagentStop` hook input now includes `background_tasks` and `session_crons` fields, and the `/goal` evaluator waits for background shells / delegated subagents to finish before firing. Pattern: a parent agent that dispatched N background children should not be allowed to declare "done" while any child is still running. Audit our completion paths in `subagent-executor.ts` / `async-execution.ts` for this guard.

### Defensive patterns (small, adopt when touching the area)

- [ ] **Consecutive-block cap for completion guards** (CC 2.1.143: stop hooks blocking repeatedly now end the turn with a warning after 8 consecutive blocks, env-overrideable). Audit `src/runs/shared/completion-guard.ts` and `long-running-guard.ts` for equivalent: a subagent bounced by hook/condition that never terminates. Add `PI_SUBAGENT_STOP_HOOK_BLOCK_CAP` env override.

- [ ] **Recursive self-dispatch guard** (CC 2.1.145: skill with `context: fork` could re-invoke itself infinitely). Verify `maxSubagentDepth` enforcement actually fires when a chain or skill recursively dispatches itself — not just at config level but at runtime. Add depth counter test.

- [ ] **Graceful truncation instead of hard failure on oversized output** (CC 2.1.145: Read tool returns truncated first page with "PARTIAL view" notice when whole-file read exceeds token limit). Apply to subagent result delivery: a chain step producing a 200K-token result should return `PARTIAL — full output at <path>` instead of failing the whole chain. Result already streams to file; just need a truncation envelope.

### Quality-of-life polish

- [ ] **Projected context cost in `subagent { action: "list" }`** (CC 2.1.143: per-turn and per-invocation token estimates in plugin marketplace browse pane). Show estimated tokens per dispatch per agent based on historical run length. Helps the orchestrator (Opus) pick the right agent for budget.

- [ ] **Time-warmed spinner colors** (CC 2.1.141: spinner warms to amber after 10s to signal still working). In `/subagents` TUI: green <30s, amber 30–120s, red >120s. Visual cue that a subagent might be stuck without opening details.

- [ ] **`--json` output for `subagent { action: "list" }`** (CC 2.1.145: `claude agents --json` for scripting, tmux-resurrect, status bars). Cheap to add. Enables external tooling (status bars, dashboards, automation) to read what's running without parsing TUI output.

- [ ] **Awaiting-input count in terminal tab title** (CC 2.1.145). Becomes essential *if* mid-run steering lands — terminal title shows `[2!]` when 2 subagents are blocked waiting for parent decision. Skip until steering is in.

- [ ] **"Summarize up to here" for chain runs** (CC 2.1.144 rewind menu). For long-running chains where intermediate outputs balloon, allow compressing earlier step outputs while keeping the most recent ones intact. Probably needs `chainDir` artifact rewriting — nontrivial. Defer until chains routinely overflow.