# Oracle Review: TUI Style Redesign Plan

## Verdict: **Plan is unsound — wrong layer, wrong approach**

The plan treats this as a cosmetic color/spacing tweak when the actual problem is architectural: the component hand-rolls everything that Pi provides as ready-made components.

---

## Critical Issues

### 1. Plan ignores Pi's built-in component system (wrong layer)

The plan says "update render-helpers.ts to match Pi's border drawing characters" — but **Pi doesn't use box-drawing characters for borders**. Pi provides:

- **`DynamicBorder`** (`@earendil-works/pi-coding-agent`) — adaptive, theme-aware border component
- **`SelectList`** (`@earendil-works/pi-tui`) — interactive list with built-in scrolling, selection prefix, description, search
- **`Container`** / **`Text`** / **`Spacer`** — layout primitives
- **`getSelectListTheme()`** — pre-built theme for SelectList
- **`ModelSelectorComponent`** — Pi's own model selector, exported for extension use

The current `subagent-hub.ts` manually reimplements all of this in ~415 lines. The fix is **replace with Pi components**, not "tweak the manual rendering to look more like Pi."

### 2. `chain-clarify.ts` is a bad reference

The plan and scout report recommend `chain-clarify.ts` (1334 lines) as a "pattern reference." But chain-clarify.ts **also hand-rolls everything** — it predates or ignores Pi's exported component system. Using it as reference perpetuates the exact problem the user complained about.

**Correct references:**
- `docs/tui.md` Pattern 1 (SelectList + DynamicBorder)
- `examples/extensions/preset.ts` lines 225-263 (canonical selector pattern)
- `docs/tui.md` Key Rule #5: "Use existing components — SelectList, SettingsList, BorderedLoader cover 90% of cases. Don't rebuild them."

### 3. Shortcut format: `keyHint()`/`rawKeyHint()` not mentioned

The user specifically complained about "weird shortcuts." The current footer is:
```
[Enter] Confirm • [Esc] Cancel • m Model • ↑↓ Navigate
```

Pi's canonical format (from preset.ts and tui.md examples):
```
↑↓ navigate • enter select • esc cancel
```

Pi also exports **`keyHint(keybindingId, description)`** and **`rawKeyHint(key, description)`** for proper shortcut formatting that respects user keybinding customization. The plan should use these instead of hardcoded strings.

### 4. Fixed width (84) should be removed, not preserved

The plan says "Width constant (84) should be preserved unless Pi uses different standard." Pi's components are **width-responsive** — they accept `width` from `render(width)` and adapt. The hardcoded 84 IS part of the "tacked-on" feeling. Pi's `DynamicBorder` fills available width; `SelectList` renders to given width.

### 5. Model selector could use `ModelSelectorComponent`

Pi exports `ModelSelectorComponent` — its own built-in model selector. The plan doesn't investigate whether this can replace the 180-line manual model selector in `subagent-hub.ts`. At minimum, the model list should use `SelectList` with search enabled.

---

## What the revised plan should do

### Step 1: Rewrite `SubagentHubComponent` using Pi components

Replace the manual rendering with:
```typescript
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
```

Main view structure:
```
DynamicBorder (top)
Text (title: "Subagent Models")
SelectList (agent list with model as description)
Text (help: rawKeyHint("m", "model") + " • " + rawKeyHint("enter", "confirm") + ...)
DynamicBorder (bottom)
```

### Step 2: Replace model selector with SelectList or ModelSelectorComponent

The model selector overlay should use `SelectList` with:
- `enableSearch: true` (if available on SelectList) or manual search input + filtered SelectList
- Pi's `getSelectListTheme()` for consistent styling
- `rawKeyHint()` for footer hints

### Step 3: Remove fixed width

Remove `readonly width = 84`. Let components respect the `width` parameter from `render(width)`.

### Step 4: Deprecate `render-helpers.ts`

`renderHeader`, `renderFooter`, `row` become unnecessary when using `DynamicBorder` + `Container`. Either delete or keep only `pad`/`formatScrollInfo` if still needed.

### Step 5: Verify against acceptance criteria

- [ ] Uses DynamicBorder (visual match) ✓
- [ ] Uses rawKeyHint/keyHint (shortcuts display correctly) ✓
- [ ] SelectList works without mode dependencies (all modes) ✓
- [ ] Model override persistence unchanged (no regression) ✓

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `ModelSelectorComponent` may not support custom filter logic (thinking suffix, provider badge) | Fall back to `SelectList` with manual items |
| `SelectList` may not support inline search for model selector | Use separate `Input` component + filtered `SelectList` |
| `render-helpers.ts` may be imported by other files | Check callers before removal (grep for imports) |
| `chain-clarify.ts` also needs fixing but is out of scope | Confirm out-of-scope — brief says only `/subagents` TUI |
| Width removal may break fixed-width assumptions in slash-commands.ts | Verify slash-commands.ts only passes width from ctx.ui.custom() |

---

## Summary

The plan as written will produce a **slightly-less-weird-looking manual TUI** rather than a **native-feeling Pi TUI**. The user complained about it looking "tacked on" — the fix is to stop tacking and use the component system. This is a component replacement, not a styling patch.

Recommend: **Revise the plan with the corrected approach above before dispatching worker.**
