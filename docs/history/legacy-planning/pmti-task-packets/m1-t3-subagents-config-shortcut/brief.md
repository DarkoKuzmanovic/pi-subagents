# M1-T3 — `/subagents config` JSON editor shortcut

## Preflight

- Project: `pi-subagents`
- Milestone: `.pi/pmti/milestones/M1.md`
- Depends on: M1-T1
- Workspace strategy: current-branch
- Expected branch/worktree: current orchestrator-selected branch/worktree; stop on mismatch

## Goal

Add a simple `/subagents config` shortcut that opens the JSON control plane for model lanes instead of building a lane-editing TUI in M1.

## Task hardness

Hardness: normal
Rationale: Slash command branching plus safe settings-file creation/editor launch; localized but user-facing.
Recommended executor: worker
Review required: yes
Oracle required: no

## Scope in

- Preserve current `/subagents` behavior when no args are provided: open the model override hub.
- When args trim to `config`, `json`, or `edit`, open the user settings JSON at `~/.pi/agent/settings.json`.
- If the settings file/subagents/modelLanes object is missing, create/preserve JSON and seed only missing `subagents.modelLanes` with a small safe skeleton.
- Prefer `$VISUAL`, then `$EDITOR`, then a conservative fallback such as `nano`; if launching is unavailable/fails, notify the exact path and do not corrupt settings.
- Keep implementation in a focused helper module if needed, with testable pure functions for path/seeding/editor command selection.
- Add integration/unit tests for no-arg behavior unchanged and config arg behavior.

## Scope out

- No full lane-editing TUI.
- No dispatch lane runtime changes; M1-T2 owns them.
- No global system config edits; only user Pi settings JSON under `~/.pi/agent/settings.json`.
- No shell command injection via editor strings.

## Suggested implementation surface

- `src/slash/slash-commands.ts`: branch inside the existing `subagents` command handler based on `_args`.
- Consider a new `src/slash/subagents-config.ts` helper to keep editor/config logic isolated.
- Use Node `child_process.spawnSync` or equivalent only for the selected editor command; pass the settings path as an argument array item, not a shell-concatenated string.
- Existing tests: `test/integration/slash-commands.test.ts` and maybe a new focused unit test for config helper.

## Suggested skeleton

Seed only if missing, roughly:

```json
{
  "subagents": {
    "modelLanes": {
      "worker": {
        "easy": { "model": "deepseek/deepseek-v4-flash", "thinking": "high" },
        "medium": { "model": "zai/glm-5.1", "thinking": "high" },
        "hard": { "model": "anthropic/claude-sonnet-4-6", "thinking": "medium" }
      }
    }
  }
}
```

The exact model IDs can be adjusted later during bakeoff; the skeleton is a starter, not a claim that these are winners.

## Acceptance criteria

- `/subagents` still opens the current model hub.
- `/subagents config` ensures JSON exists and attempts to open it.
- Existing settings are preserved, including existing `subagents.agentOverrides`.
- If `modelLanes` already exists, it is not overwritten.
- Failure to launch an editor produces a useful notification with the settings path.

## Validation

- Focused slash command tests for `/subagents` no-arg and `/subagents config`.
- Unit test for seeding behavior if implemented in a helper.
