# Agent Guidance

## Development invariants

- Runtime dependencies stay limited to Node built-ins, `@earendil-works/*`, and `typebox` unless explicitly approved.
- Use ESM TypeScript with the repository's existing import-specifier convention. New code uses no `any`, no non-null assertions, and type-only imports where appropriate.
- Tests use Node's built-in test runner and the existing support shims. Do not introduce Jest or Vitest.
- Verify the current branch/worktree and shared-checkout ownership before editing. Workers do not commit; the orchestrator owns staging, verification, and close-out.
- Executors stop on ambiguity. The orchestrator or user owns architecture choices, tradeoffs, approvals, and remote actions.
- User-settings writes preserve unrelated fields, reject malformed shapes, use atomic replacement, create the parent directory when needed, and end JSON with a trailing newline.
- CodeGraph packaged-role invariant: only `recon`, `worker`, and `reviewer` select `mcp:codegraph/codegraph_explore` (parsed as `mcpDirectTools: ["codegraph/codegraph_explore"]`); keep their builtin tool order and every compatibility role unchanged. Their prompts require the target checkout's own existing database, one optional graph pass, no init or cross-worktree index sharing, native fallback, and deterministic checks only through `$HOME/.pi/agent/bin/codegraph-query.sh`; frontmatter tests must assert this narrow selection and fallback contract.
- `src/runs/shared/mcp-direct-tool-allowlist.ts` duplicates a synchronous, dependency-free subset of optional pi-mcp-adapter logic (`metadata-cache.ts`, `direct-tools.ts`, `types.ts`, `utils.ts`) and must never import it or add a dependency. The cache-hash identity and the direct-name selection rules are a byte-level compatibility contract with a specific adapter version, pinned by the fixed adapter-produced digest in `test/unit/pi-args.test.ts`; that fixture is never recomputed with the implementation under test. Any pi-mcp-adapter upgrade that changes the hashed fields or naming rules must move the duplicated subset, the pinned digest, and the version named in both together, keeping missing/stale/malformed cache entries fail-closed per server.
- Live-control actions (`steer`, `follow-up`, `wrap-up`) report only the durable Pi disposition (`accepted-by-pi` with `started-turn`/`queued-steer`/`queued-follow-up`, `rejected`, `submitted`, `outcome-unknown`) — never claim model delivery, never silently downgrade steer to follow-up, and never replay `outcome-unknown`. `wrap-up` rides the steer path with the canonical `WRAP_UP_DIRECTIVE`; the M12.1 wire protocol in `src/runs/shared/nested-events.ts` is frozen.

### Async integration tests

- A test that detaches or backgrounds an async run must await its terminal result file before resetting shared mocks, removing temporary state, or finishing. Receiving an async ID proves handoff, not completion; otherwise late child calls can leak into later tests.

## Project state

- `ROADMAP.md` is the durable strategic milestone list using `M<n>` IDs.
- Root `PLAN.md` is transient execution state for the current build only, using `M<n>.<k>` outcome IDs. It may be absent when no build is in flight.
- `DECISIONS.md` is append-only; `IDEAS.md` is the uncommitted backlog; design prose belongs under `docs/`.
- Status is derived from Markdown and git history. Do not create a planning state directory, `status.json`, progress ledger, or durable per-task packet.
- Historical planning evidence lives under `docs/history/legacy-planning/` and is never treated as active instructions.

## Prompt constraints do not repair provider tool serialization

A smaller, artifact-first prompt can improve completion and recovery, but it cannot make an unstable model/provider serialize native tool calls correctly. Evaluate recon models on two separate axes: whether they produce a usable grounded artifact, and whether their tool protocol remains clean. Recoverable malformed calls still indicate provider risk and should prevent promotion to the default orchestration model.

### Foreground runs are non-recoverable after extension reload

Foreground subagent runs live entirely in-memory (`SubagentState.foregroundControls`). They have no durable on-disk presence and no standalone process — `process.pid` is the host Pi process, not the run. PID-based liveness checks are useless for the reload recovery scenario: after an extension reload, the in-memory map is empty but `isProcessAlive(process.pid)` returns true (host still alive), so a durable store would falsely resolve a dead foreground run as live. Never use PID liveness to recover foreground handles from a durable store. Foreground runs are only resolvable while in-memory; the durable handle store should refuse to resolve `kind: "foreground"` as live. (Learned 2026-07-22 during M12.3 review — grok-4.5 caught the flaw.)

### Run-handle and attachment persistence

Every foreground and async launch records a durable `RunHandleRecord` (`src/runs/shared/run-handle-store.ts`, under `TEMP_ROOT_DIR/run-handles/`, fsynced, `0700`/`0600`) so a run that started before an extension reload can be found again via `recover`. Handles are deleted on completion/cleanup. The `recover`/`inspect`/`attach`/`detach` tool actions surface this: `recover` reports resolvability (never implying steerable), `inspect` returns a compact state summary for live or completed runs, and `attach` verifies live-control capability (owner epoch + capability token) before steering — distinguishing steering-capable from inspection-only. Nested descendants are not recorded as separate handles; they are rediscovered through their parent's route and the durable nested registry. The foreground non-recoverability invariant above is enforced at the resolver layer (`recoveredHandleToResolved` returns `undefined` for `kind: "foreground"`), not by skipping the record.

<!-- BEGIN CARTOGRAPHER MANAGED MAP POINTER -->
## Cartographer maps

Cartographer generated project-local maps under `.pi/maps/`.

- Start with `.pi/maps/overview.md` for orientation.
- Use `.pi/maps/file-index.md` to choose source files to inspect.
- Use `.pi/maps/agent-routing.md` for agent workflow hints.
- Check `.pi/maps/metadata.toml` before trusting map freshness.

Generated maps are wayfinding, not source authority. Always verify source files before editing.
<!-- END CARTOGRAPHER MANAGED MAP POINTER -->
