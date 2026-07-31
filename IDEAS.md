# Ideas

Uncommitted candidates. Pick and choose; a roadmap or design-doc entry is still not implementation authorization.

## Close-out agent suite

These are user-scoped subagents under `~/.agents/`, not packaged pi-subagents features. They are kept here because this repository is where the fleet is developed.

Source: 2026-07-14 gap analysis over 521 sessions. The recurring friction was that doing work is well staffed, while verifying, documenting, committing, and keeping state honest remained manual.

### Shared recipe

Narrow scope · tools restricted to what the job needs · `worktree: true` for anything that writes · mandatory review/verification · never trust an agent's own “done” without evidence.

### Built

- [x] **verifier** (`~/.agents/verifier.md`) — read-only QA gate that discovers and runs the repository's real checks, returning minimal failure evidence. Verified on pi-agy. — 2026-07-14
- [x] **docs-freshener** (`~/.agents/docs-freshener.md`) — reconciles README/AGENTS/docs against source and returns a reviewable documentation-only diff. Caveat: historical provider abort rate requires a bounded retry. — 2026-07-14
- [x] **commit-engineer** (`~/.agents/commit-engineer.md`) — explicit-path staging, pre-staged/ambiguous-work refusal, repository checks, local commits, and exact authorization for remote actions. Verified in isolated Git fixtures. — 2026-07-14

### Planned

- [ ] **state-keeper** — reconcile project-state documents and enforce canonical `M<n>` / `M<n>.<k>` IDs instead of mixed version labels, `Outcome 1`, `S<x>`, or task-ledger IDs. Sibling to docs-freshener: docs-freshener checks docs↔code; state-keeper checks state↔state and convention. Tools: `read,grep,find,ls,edit` (no `bash`). — effort:M
- [ ] **session-forensicist** — mine session history for handoffs, cross-session drift, and usage patterns at close-out. Lower priority; overlaps `inspect_session`. — effort:M

## pi-subagents product backlog

### Keep

- [ ] **Persistent/warm child workers** — reuse a small pool of separate child `pi` processes to reduce startup and extension-load latency while preserving crash isolation. Requires explicit worker identity, idle timeout, context reset, session ownership, cancellation, and leak cleanup. Do not replace child processes with in-process sessions.
- [ ] **Mechanical non-null assertion sweep** — 139 non-null assertions remain on 132 lines across 22 production files. AGENTS.md broadly bans them, while M12.4 covered only the 24 `!.` dot-access sites. Concentrations are `src/runs/foreground/chain-clarify.ts`, `src/runs/foreground/chain-execution.ts`, `src/runs/foreground/subagent-executor.ts`, `src/tui/render.ts`, and `src/agents/agent-management.ts`; treat a future mechanical sweep as medium-high regression risk.
- [ ] **Graceful oversized-output truncation** — return a stable `PARTIAL — full output at <path>` envelope instead of failing or flooding the parent. Reuse existing result files and preserve failed-run diagnostics.
- [ ] **Pending-work-aware completion semantics** — prevent a parent or chain from claiming completion while delegated children, background shells, or session jobs remain live. This may graduate into M12 after its transport/ownership spike.
- [ ] **Recursive self-dispatch guard test** — prove `maxSubagentDepth` blocks recursive chain/skill self-dispatch at runtime, not only in configuration.
- [ ] **Consecutive completion-guard block cap** — stop repeated hook/guard blocks after a bounded limit with an actionable warning and optional environment override.
- [ ] **Structured list output** — add a JSON/structured form of `subagent({ action: "list" })` for dashboards and scripts without human-text parsing.
- [ ] **Compact glyph/live-detail regression** — re-verify the historical integration-test failures before scheduling; the old report identified key-text/render-state drift rather than a runtime failure.
- [ ] **Time-warmed status colors** — indicate elapsed-time bands in `/subagents` or the future M12 live-status surface, subject to accessibility and theme checks.

### Park until demand is concrete

- [ ] **`/goal` completion-condition loops** — bounded “work until condition passes” behavior, likely as a dedicated agent or chain rather than a flag on every dispatch.
- [ ] **Cron/interval/one-shot scheduling** — session-scoped scheduled agents; large safety surface and no current recurring-job requirement.
- [ ] **Projected context cost in list output** — estimate token/cost from historical runs.
- [ ] **Summarize up to here for chains** — compact earlier chain artifacts while retaining recent outputs; defer until chains routinely overflow.

### Historical tuning questions — revalidate before acting

These came from the 2026-05-29 mesh review and contain stale model-era assumptions. They are preserved as questions, not current recommendations.

- [ ] **Worker context: fork vs fresh** — current packaged behavior favors fork for implementation nuance; re-evaluate only with measured context cost and task-quality evidence.
- [ ] **Worker model/lane quality** — replace historical direct-model proposals with a current lane bakeoff before changing defaults.
- [ ] **Research compatibility-agent model** — researcher is disabled by default; reconsider only if the role is re-enabled with a distinct product need.
- [ ] **Scout/recon thinking level** — scout is a compatibility role and recon is canonical; tune the active recon lane rather than reviving stale role defaults without evidence.

## Graduated design candidates

- [x] **Live run handles cluster** — steering, attach/detach, transcript viewing, live status, lifecycle events, and possible RPC inputs graduated to `ROADMAP.md` M12 and `docs/plans/PLAN-live-run-handles.md`.
- [x] **Acceptance gates/rubric loops** — graduated to M13 and `docs/plans/PLAN-acceptance-gates.md`.
- [x] **Lane-editing TUI** — retained under its original M2 identity in `docs/plans/PLAN-lane-editing-tui.md`.
