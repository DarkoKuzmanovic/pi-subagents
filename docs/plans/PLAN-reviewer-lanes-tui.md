# Reviewer Lanes + Lane Management TUI

Created: 2026-07-09

## 1. Add reviewer lanes (config-only, no code changes)

The lane infrastructure (`model-lanes.ts`) is fully generic — any agent can have lanes.
Add to `settings.json` under `subagents.modelLanes`:

```json
"reviewer": {
  "quick": { "model": "umans/umans-flash", "thinking": "high" },
  "deep": { "model": "anthropic/claude-opus-4-8", "thinking": "medium" }
}
```

Dispatch with `lane: "quick"` or `lane: "deep"`. The default (no lane) stays at the
agent override model (`umans/umans-glm-5.2`).

## 2. Lane management TUI

The `/subagents` hub (`src/tui/subagent-hub.ts`) already manages per-agent model + thinking
overrides. Extend it to also manage lanes:

### Current flow
```
Agent list → [Enter] → Model picker → [Enter] → back
           → [Tab]  → Cycle thinking
           → [Esc]  → Save & exit
```

### Proposed flow
```
Agent list → [Enter] → Model picker (for default model)
           → [L]    → Lane view (list lanes for selected agent)
                        → [Enter] → Model picker for that lane
                        → [N]    → New lane (prompt for name)
                        → [D]    → Delete lane
                        → [Esc]  → Back to agent list
           → [Tab]  → Cycle thinking
           → [Esc]  → Save & exit
```

### Implementation notes
- `SubagentHubComponent` needs a third view mode (`editingLane`) alongside `editingAgentIndex`
- Lane CRUD writes to the same `modelLanes` section of settings.json
- Reuse existing `SelectList` + `DynamicBorder` components
- The model picker (already built) handles the model-per-lane selection
- Lane names are freeform strings — user picks the name
