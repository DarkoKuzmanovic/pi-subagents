# TUI Redesign Verification Checklist

## Manual Testing

### Main View (`/subagents`)
- [ ] DynamicBorder renders at top and bottom (Pi-native border style)
- [ ] Title "Subagent Models" rendered in accent+bold
- [ ] Agent list uses SelectList (→ prefix for selected, accent color)
- [ ] Model description shown in muted color
- [ ] Override marker (✎) visible next to overridden models
- [ ] Footer key hints use Pi-native format: "enter confirm • esc cancel • m model • ↑↓ navigate"
- [ ] Width is responsive (not fixed at 84)

### Key Bindings
- [ ] ↑/↓ wraps around (first→last, last→first)
- [ ] Enter confirms and saves overrides
- [ ] Escape/Ctrl+C cancels (returns empty overrides)
- [ ] `m` enters model selector for selected agent

### Model Selector View
- [ ] Title shows agent name: "Select Model (agent-name)"
- [ ] Search input renders with cursor
- [ ] Current model shown in warning color
- [ ] Model list uses SelectList
- [ ] Provider shown in description: "[provider]"
- [ ] Current model marked with "current" in description
- [ ] Type-to-search filters by fullId, id, and provider
- [ ] Backspace removes last char from search
- [ ] Enter selects model and preserves thinking level if supported
- [ ] Escape returns to main view

### Persistence
- [ ] Model overrides saved correctly via saveBuiltinAgentOverride()
- [ ] Thinking level suffix preserved when switching models

### All Subagent Modes
- [ ] Works correctly after async subagent runs
- [ ] Works correctly after chain execution
- [ ] Works correctly after parallel execution

## Automated Tests
- [x] Typecheck passes (no new errors)
- [x] render-helpers dead code removal test passes
- [x] pad utility tests pass
- [x] No regressions in other unit tests
