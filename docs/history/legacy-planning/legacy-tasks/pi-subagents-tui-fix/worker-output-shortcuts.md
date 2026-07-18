# Worker Output: Shortcut + Implementation Fixes

## Changes made

### 1. SelectList delegation (subagent-hub.ts)
- **Added** `agentSelectList` and `modelSelectList` class fields (persisted across renders)
- **Wired** `onSelect` / `onCancel` callbacks on both SelectList instances
- **Removed** manual `matchesKey("up")`, `matchesKey("down")`, `matchesKey("return")` handling in `handleInput()` and `handleModelSelectorInput()`
- **Delegated** all navigation/selection input to `SelectList.handleInput()`
- `handleInput()` now only intercepts `ctrl+c` (hard cancel) and `escape` (done) at the agent-list level, and `escape` (back) / `ctrl+c` (hard cancel) at the model-picker level

### 2. rawKeyHint replacement (subagent-hub.ts)
- **Imported** `rawKeyHint` from `@earendil-works/pi-coding-agent` (line 2)
- **Replaced** `formatKeyHints()` method with `formatFooter()` that calls `rawKeyHint(key, desc)` for each pair
- `rawKeyHint` handles platform-specific formatting (e.g., alt → option on macOS)

### 3. Shortcut scheme change (subagent-hub.ts)
- **Agent list:**
  - `enter` = open model picker (was: confirm/save) — via `SelectList.onSelect`
  - `esc` = done, apply overrides (was: cancel/discard)
  - `ctrl+c` = cancel, discard overrides (unchanged)
  - `m` key = **removed entirely**
- **Model picker:**
  - `enter` = select model, return to agent list (unchanged) — via `SelectList.onSelect`
  - `esc` = cancel model change, return to agent list (was: cancel everything)
  - `ctrl+c` = hard cancel, discard all, close hub (new)
- **Footer hints:**
  - Agent list: `"enter model • esc done • ctrl+c cancel"`
  - Empty agents: `"esc done"`
  - Model picker: `"enter select • esc back • type search"`

### Test updates (subagent-hub.test.ts)
- Renamed "done callback receives overrides on return key" → "done callback receives overrides on esc (done)"
- Renamed "done callback receives empty map on escape" → "ctrl+c cancels with empty overrides map"
- Updated comment about cancel semantics
- Changed "Cancel" text assertion → "done" in render test

## Validation
- Typecheck: 328 errors (3 fewer than before — all pre-existing)
- Unit tests: 596 pass, 11 fail (all failures pre-existing, unrelated to changes)
- Hub tests: all skip (pre-existing — strip-types can't handle parameter properties)

## Lines removed
- Manual up/down/enter/escape handling: ~50 lines removed
- `formatKeyHints()`: ~7 lines removed
- `m` key binding: 3 lines removed
