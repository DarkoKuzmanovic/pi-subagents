# TODO

## Expose `thinking` level in /subagents TUI and inline dispatch

**Status:** Implemented in PMTI M0 (pending broader project typecheck cleanup)
**Requested:** 2026-06-01

### Problem

Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) is currently only configurable through:

1. `agentOverrides` in `settings.json` (persistent per-agent)
2. Agent file frontmatter (`thinking: high`)
3. `subagent({ action: "create/update", config: { thinking: "high" } })`

It is **not** available as an inline per-dispatch parameter. Chain steps and parallel tasks accept `model`, `skill`, `progress`, `output`, `reads` — but not `thinking`. This means you can't do a one-off dispatch with a different thinking level without pre-configuring a separate agent definition.

### What to add

1. **Inline dispatch support** — Add `thinking` as an optional field on:
   - `subagent({ agent, task, thinking, ... })` (single dispatch)
   - Chain step objects: `{ agent, task, thinking, ... }`
   - Parallel task objects: `{ agent, task, thinking, ... }`

2. **/subagents TUI** — When the interactive `/subagents` UI lets users pick an agent to dispatch, expose a thinking level selector (similar to how `Shift+Tab` cycles thinking in the main editor). This should:
   - Show the current effective thinking level (from agent definition or override)
   - Allow overriding it before launch
   - Pass the override through to the spawned session

3. **Precedence** — Inline dispatch `thinking` > `agentOverrides.thinking` > agent file `thinking` > session default.

### References

- Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- SDK: `createAgentSession({ thinkingLevel: "medium" })` already works
- Settings: `defaultThinkingLevel`, `thinkingBudgets` already exist
- Models: `thinkingLevelMap` on model definitions controls which levels are available per model
