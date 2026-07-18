# Worker Output: TUI Style Redesign

## Summary
Replaced hand-rolled TUI components in `SubagentHubComponent` with Pi's built-in component system (DynamicBorder, SelectList, Container, Text, Spacer). The TUI now matches Pi coding agent's visual style and key hint conventions.

## Changes

### 1. `src/tui/subagent-hub.ts` — Complete rewrite
**Before**: 415 lines of manual rendering with fixed width=84, hardcoded borders (`renderHeader`/`renderFooter`), manual selection indicators, hardcoded footer `[Enter] Confirm • [Esc] Cancel • m Model • ↑↓ Navigate`

**After**: 390 lines using Pi components:
- `DynamicBorder` for top/bottom borders (Pi-native border characters)
- `SelectList` for agent list and model selector (→ prefix, accent color, scroll info)
- `Container` + `Text` + `Spacer` for layout composition
- `formatKeyHints()` matching `rawKeyHint` style: `enter confirm • esc cancel • m model • ↑↓ navigate`
- Width-responsive (uses `render(width)` parameter, no fixed 84)
- `getSelectListTheme()` creates theme from local `theme` parameter (testable, no global theme dependency)
- `handleModelSelectorInput` changed from private to public (test compatibility)
- Preserved all public state properties and methods for test compatibility

### 2. `src/tui/render-helpers.ts` — Simplified
**Before**: 48 lines with `renderHeader`, `renderFooter`, `row`, `formatScrollInfo`, `pad`

**After**: 7 lines with only `pad()` — all other functions replaced by `DynamicBorder` + `Container` + `SelectList`

### 3. `src/slash/slash-commands.ts` — Overlay width
**Before**: `overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" }`

**After**: `overlayOptions: { anchor: "center", width: "60%", minWidth: 60, maxWidth: 100, maxHeight: "80%" }` — responsive width

### 4. `test/support/shims/pi-tui.d.ts` — Added type declarations
- Added `SelectItem`, `SelectListTheme`, `SelectList` declarations
- Updated `Text` constructor signature to accept padding params

### 5. `test/support/shims/pi-coding-agent.d.ts` — Added type declarations
- Added `DynamicBorder`, `rawKeyHint`, `getSelectListTheme` declarations

### 6. `test/unit/dead-code-cleanup.test.ts` — Updated assertion
- `pad` still exported, `row`/`renderHeader`/`formatScrollInfo`/`renderFooter` now verified as removed

### 7. `test/unit/render-helpers.test.ts` — Rewritten
- Removed `row` tests, kept `pad` tests with ANSI handling

### 8. `test/unit/subagent-hub.test.ts` — Updated assertions
- Footer text assertions changed from `[Enter] Confirm` to `enter confirm` (lowercase, Pi-native)
- Mock theme now includes `bold()` method

### 9. `.pi/tasks/pi-subagents-tui-fix/VERIFICATION.md` — Created
- Manual verification checklist for all subagent modes

## Validation
- `npm run typecheck`: No new errors (pre-existing render.ts errors unrelated)
- `npm run test:unit`: No new failures (all pre-existing)
- Dead-code removal test: ✔ Pass
- render-helpers pad tests: ✔ Pass
- subagent-hub tests: Skipped (pre-existing — requires Pi packages installed)

## Open Risks
1. **SelectList description is single-color** — Provider badge and "current" marker both use `muted` color. Cannot individually color them (SelectList theme limitation). Acceptable tradeoff for Pi-native look.
2. **rawKeyHint uses global theme** — Our `formatKeyHints()` uses local theme instead, which is correct per Pi docs ("Always use theme from callback"). This avoids jiti module cache issues.
3. **chain-clarify.ts still uses hand-rolled rendering** — Out of scope per brief, but it has the same "tacked-on" appearance. A future task could apply the same treatment.
4. **Subagent hub tests are always skipped** — The dynamic import fails without Pi packages installed. This is a pre-existing limitation.

## Recommended Next Step
Run `/subagents` in Pi to manually verify the visual output matches Pi's native style. Check key bindings work correctly across all modes.
