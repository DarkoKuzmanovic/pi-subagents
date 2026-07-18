# M0-T3 — `/subagents` TUI thinking selector

**Milestone:** M0 — Thinking level dispatch controls
**Status:** Prepared
**Depends on:** M0-T1
**Blocks:** M0-T4
**Can run in parallel with:** M0-T2 after M0-T1 lands
**Workspace strategy:** current-branch

## Goal

Expose thinking-level override in the interactive `/subagents` hub before launch, showing the current effective level and passing the selected override into dispatch.

## Scope in

- Add thinking state to `/subagents` TUI launch result.
- Display effective thinking level from agent/frontmatter/override/model suffix where available.
- Add a selector or cycling control similar in spirit to existing model/thinking controls elsewhere in the extension.
- Respect `thinkingLevelMap` via existing helpers (`getSupportedThinkingLevels`, suffix parsing) so unsupported levels are not silently launched.
- Preserve existing model selector behavior that carries supported thinking suffixes across model changes.

## Out of scope

- Chain clarify UI changes unless a helper is safely reused.
- Runtime precedence implementation beyond passing the selected field through to M0-T2's API surface.
- New visual design system.

## Likely files

- `src/tui/subagent-hub.ts`
- `src/shared/model-info.ts` only if a small exported helper is needed
- `src/runs/foreground/subagent-executor.ts` where hub result is converted to dispatch input
- Integration tests for `/subagents` if existing harness supports it

## Acceptance criteria

- `/subagents` shows an understandable thinking level indicator for the selected agent.
- User can override the launch thinking level before dispatch.
- Changing model drops or adjusts unsupported thinking choices safely.
- Launch result includes the chosen thinking override and does not persist it to the agent definition.
- Existing hub navigation and model selection still work.

## Risks

- Existing `chain-clarify` has thinking selector logic; duplicating it blindly may diverge.
- The hub may encode thinking as model suffix today; normalize deliberately to avoid double suffixes.
- TUI tests can be brittle; prefer testing state/result behavior over snapshots when possible.
