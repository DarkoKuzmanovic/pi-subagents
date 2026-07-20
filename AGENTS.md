# Agent Guidance

## Development invariants

- Runtime dependencies stay limited to Node built-ins, `@earendil-works/*`, and `typebox` unless explicitly approved.
- Use ESM TypeScript with the repository's existing import-specifier convention. New code uses no `any`, no non-null assertions, and type-only imports where appropriate.
- Tests use Node's built-in test runner and the existing support shims. Do not introduce Jest or Vitest.
- Verify the current branch/worktree and shared-checkout ownership before editing. Workers do not commit; the orchestrator owns staging, verification, and close-out.
- Executors stop on ambiguity. The orchestrator or user owns architecture choices, tradeoffs, approvals, and remote actions.
- User-settings writes preserve unrelated fields, reject malformed shapes, use atomic replacement, create the parent directory when needed, and end JSON with a trailing newline.

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

<!-- BEGIN CARTOGRAPHER MANAGED MAP POINTER -->
## Cartographer maps

Cartographer generated project-local maps under `.pi/maps/`.

- Start with `.pi/maps/overview.md` for orientation.
- Use `.pi/maps/file-index.md` to choose source files to inspect.
- Use `.pi/maps/agent-routing.md` for agent workflow hints.
- Check `.pi/maps/metadata.toml` before trusting map freshness.

Generated maps are wayfinding, not source authority. Always verify source files before editing.
<!-- END CARTOGRAPHER MANAGED MAP POINTER -->
