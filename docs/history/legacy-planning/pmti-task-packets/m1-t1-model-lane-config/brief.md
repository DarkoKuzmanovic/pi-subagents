# M1-T1 — Model lane settings and resolution model

## Preflight

- Project: `pi-subagents`
- Milestone: `.pi/pmti/milestones/M1.md`
- Workspace strategy: current-branch
- Expected branch/worktree: current orchestrator-selected branch/worktree; stop on mismatch
- Existing dirty state noted before planning: `CHANGELOG.md`, `package.json`, `src/tui/subagent-hub.ts`, `test/unit/subagent-hub.test.ts`

## Goal

Define and test the settings-layer model for `subagents.modelLanes` so later dispatch code can resolve a requested lane to `{ model?, thinking? }` without duplicating role agents.

## Task hardness

Hardness: high
Rationale: config parsing/validation is a durable boundary that affects model routing and provider safety.
Recommended executor: worker-heavy
Review required: yes
Oracle required: no, unless changing the M1 precedence semantics

## Scope in

- Add typed representation for `subagents.modelLanes`.
- Read user/project settings using the same safety posture as existing `agentOverrides` parsing.
- Validate lane entries: agent name -> lane name -> object with optional string `model` and optional valid `thinking` (`off|minimal|low|medium|high|xhigh`).
- Resolve requested `{ agent, lane }` using user settings plus project settings, with project settings winning where both define the same agent/lane.
- Unknown requested lanes must produce a clear error for the runtime layer to return.
- Unit tests for valid config, invalid config, user/project precedence, missing lane, and partial lane entries.

## Scope out

- No dispatch schema/runtime changes; M1-T2 owns `lane` on requests.
- No `/subagents config` shortcut; M1-T3 owns editor UX.
- No built-in roster disable; M1-T4 owns visible roster/docs.

## Suggested implementation surface

- Prefer a focused new module such as `src/agents/model-lanes.ts` or `src/shared/model-lanes.ts` over bloating `subagent-executor.ts`.
- Reuse or safely expose settings helpers from `src/agents/agents.ts` (`getUserAgentSettingsPath`, `getProjectAgentSettingsPath`, strict JSON read/write) rather than copying fragile path logic.
- Add tests near `test/unit/agent-overrides.test.ts` or a new `test/unit/model-lanes.test.ts`.

## Acceptance criteria

- A settings file like:

```json
{
  "subagents": {
    "modelLanes": {
      "worker": {
        "easy": { "model": "deepseek/deepseek-v4-flash", "thinking": "high" },
        "hard": { "model": "anthropic/claude-sonnet-4-6", "thinking": "medium" }
      }
    }
  }
}
```

can be parsed and resolved for `worker/easy`.
- Invalid `modelLanes` shapes fail with file path + agent/lane context.
- Lane objects may provide only `model` or only `thinking`.
- No product runtime path changes until M1-T2.

## Validation

- `npm run test:unit -- test/unit/model-lanes.test.ts` if a focused test file is added, or the closest exact Node test command for modified unit files.
- `npm run typecheck` only if the executor can separate M1 failures from known pre-existing errors.
