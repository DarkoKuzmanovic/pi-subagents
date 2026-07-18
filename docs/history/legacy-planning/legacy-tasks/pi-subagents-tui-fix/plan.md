# Implementation Plan: TUI Style Redesign (Revised per Oracle)

## Architecture Decision
**Replace manual TUI components with Pi's built-in component system.** The current code hand-rolls everything Pi already provides. This is component replacement, not styling patches.

## Step 1: Read Pi component references
**Files**: 
- `~/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `~/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/preset.ts` (lines 225-263)
**Action**: Understand canonical patterns for `DynamicBorder`, `SelectList`, `rawKeyHint()`, `ModelSelectorComponent`
**Before**: Using chain-clarify.ts as reference (bad pattern - also hand-rolls everything)
**After**: Using Pi's exported component system as reference

## Step 2: Rewrite SubagentHubComponent with Pi components
**File**: `src/tui/subagent-hub.ts`
**Action**: Complete rewrite using Pi components
**Changes**:
- Import `DynamicBorder`, `rawKeyHint` from `@earendil-works/pi-coding-agent`
- Import `Container`, `SelectList`, `Text`, `SelectItem` from `@earendil-works/pi-tui`
- Replace manual border rendering with `DynamicBorder`
- Replace manual agent list with `SelectList` (agent name as label, model as description)
- Replace hardcoded footer with `rawKeyHint()` calls for proper shortcut formatting
- Remove `readonly width = 84` - let components be width-responsive
**Before**: 415 lines of manual rendering, fixed width, hardcoded shortcuts like `[Enter] Confirm`
**After**: ~150 lines using Pi components, width-responsive, shortcuts like "↑↓ navigate • enter select"

## Step 3: Replace model selector overlay
**File**: `src/tui/subagent-hub.ts`
**Action**: Replace manual model selector with `SelectList` or `ModelSelectorComponent`
**Changes**:
- Use `SelectList` with `enableSearch: true` for model filtering
- Use `getSelectListTheme()` for consistent styling
- Use `rawKeyHint()` for footer hints
- If `ModelSelectorComponent` supports custom filtering, use it instead
**Before**: 180-line manual model selector with custom rendering
**After**: Pi-native model selector with search

## Step 4: Deprecate render-helpers.ts
**File**: `src/tui/render-helpers.ts`
**Action**: Check callers (grep for imports), then either delete or keep only `pad()` if still needed
**Changes**:
- `renderHeader`, `renderFooter`, `row` become unnecessary with `DynamicBorder` + `Container`
- Keep `pad()` only if no Pi equivalent exists
**Before**: Custom rendering primitives
**After**: Either deleted or minimal utility functions

## Step 5: Verify model override persistence
**File**: `src/slash/slash-commands.ts`
**Action**: Ensure `saveBuiltinAgentOverride()` still works after component rewrite
**Changes**: None expected - hub output format should remain compatible
**Before**: Model overrides saved via hub result
**After**: Same persistence, cleaner component

## Step 6: Manual verification checklist
**File**: `.pi/tasks/pi-subagents-tui-fix/VERIFICATION.md`
**Action**: Create checklist for manual TUI testing
**Items**:
- [ ] Run `/subagents` - uses DynamicBorder (visual match)
- [ ] Shortcuts use rawKeyHint format ("↑↓ navigate • enter select")
- [ ] SelectList works in all modes (async, chain, parallel)
- [ ] Model override persistence unchanged
- [ ] Width adapts to container (no fixed 84)
**Before**: No test documentation
**After**: Reproducible verification steps

## Notes for Worker
- **DO NOT** use chain-clarify.ts as reference - it also hand-rolls everything
- **DO** use docs/tui.md Pattern 1 and examples/extensions/preset.ts as reference
- **GLM-5.1**: Be specific with LINE:HASH anchors for all edits
- **Key invariant**: Model override persistence must continue working
- **Out-of-scope**: Don't change agent logic, slash commands, or backend code
