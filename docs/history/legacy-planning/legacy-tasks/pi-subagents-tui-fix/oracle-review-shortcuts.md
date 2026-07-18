# Oracle Review: Implementation + Shortcut Proposal

## Part 1: Implementation Review

### Verdict: Mostly sound, three concrete issues

**What's correct:**
- ✅ Uses `DynamicBorder`, `Container`, `SelectList`, `Spacer`, `Text` — right components
- ✅ `DynamicBorder` color param is typed: `(s: string) => th.fg("accent", s)` — matches tui.md Rule 2
- ✅ Render caching with `invalidate()` — matches performance pattern from tui.md
- ✅ `tui.requestRender()` called after state changes — matches tui.md Rule 3
- ✅ `SelectList` theme keys (`selectedPrefix`, `selectedText`, `description`, `scrollInfo`, `noMatch`) match Pi's pattern

**Issue 1: SelectList is render-only — input handling is manual and duplicated**

The component creates a `SelectList` in `buildMainView()` and `buildModelSelectorView()`, sets its selected index, renders it — but then handles all keyboard input (up/down/enter/escape) manually in `handleInput()` and `handleModelSelectorInput()`. The `SelectList` is recreated on every render call and immediately discarded.

Pi's canonical pattern (from `preset.ts` line 241-261) is:
```typescript
selectList.onSelect = (item) => done(item.value);
selectList.onCancel = () => done(null);
// ...
handleInput(data) { selectList.handleInput(data); tui.requestRender(); }
```

The `SelectList` component already handles `up`, `down`, `enter`, `escape`, wrapping, scroll, and search internally. The subagent-hub reimplements all of this, which:
- Duplicates ~50 lines of navigation logic
- Bypasses `SelectList`'s own scroll/viewport management
- Creates a render-only decoration that doesn't match its visual promise (it looks like a SelectList but doesn't act like one)

**Recommendation:** Persist the `SelectList` instances as class fields, wire `onSelect`/`onCancel`, delegate `handleInput` to them. This will eliminate the manual up/down/enter/escape handling and reduce code by ~40%.

**Issue 2: `formatKeyHints()` reinvents `rawKeyHint()`**

Lines 242-248 implement a custom key hint formatter that duplicates `rawKeyHint()` from `@earendil-works/pi-coding-agent`:

```typescript
// Current (subagent-hub.ts:242-248)
private formatKeyHints(hints: [string, string][]): string {
    const separator = th.fg("dim", " • ");
    return hints
        .map(([key, desc]) => th.fg("dim", key) + th.fg("muted", ` ${desc}`))
        .join(separator);
}

// Pi's rawKeyHint (keybinding-hints.js:33-35)
export function rawKeyHint(key, description) {
    return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
```

Functionally identical, but `rawKeyHint` also runs through `formatKeyText()` which handles platform-specific formatting (e.g., `alt` → `option` on macOS). The custom version skips this.

**Recommendation:** Replace `formatKeyHints()` with direct `rawKeyHint()` calls joined by `th.fg("dim", " • ")`.

**Issue 3: No `getKeybindings()` / `kb.matches()` usage**

Pi's internal selectors (model-selector.js, scoped-models-selector.js) use `getKeybindings().matches(data, "tui.select.up")` instead of `matchesKey(data, "up")`. The keybindings API respects user-customized keys from `~/.pi/agent/keybindings.json`. Using `matchesKey` directly means the subagent hub won't respond to remapped keys.

From keybindings.md:
- `tui.select.up` → default `up`
- `tui.select.down` → default `down`
- `tui.select.confirm` → default `enter`
- `tui.select.cancel` → default `escape`, `ctrl+c`

**Recommendation:** Import `getKeybindings` from `@earendil-works/pi-tui` and use `kb.matches(data, "tui.select.confirm")` instead of `matchesKey(data, "return")`. This is moot if Issue 1 is fixed (delegate to SelectList), since SelectList already uses the keybindings API internally.

### Minor observations (not bugs)

- The component doesn't implement `Focusable` for the model search. If the user has an IME (CJK input), the cursor position won't be correct. Low priority since model search is ASCII-only in practice.
- `getSelectListTheme()` reimplements what `getSelectListTheme()` from `@earendil-works/pi-coding-agent` already provides. But the Pi export uses the global theme singleton, while this component uses the injected `this.theme`. This is a reasonable divergence — the extension can't rely on the global theme being the same instance.

---

## Part 2: Shortcut Proposal Review

### Proposed scheme

| View | Current | Proposed |
|------|---------|----------|
| Agent list | `enter` = confirm & close | `enter` = open model picker |
| Agent list | `m` = open model picker | **removed** |
| Agent list | — | `ctrl+s` = confirm & close |
| Model picker | `enter` = select model | unchanged |
| Model picker | `esc` = cancel & close entirely | `esc` = back to agent list |

### Verdict: Direction is right. Two problems to fix.

**What's sound:**
- ✅ `enter` = select/drill into the current item — matches Pi's universal convention (`tui.select.confirm` = enter in all selectors)
- ✅ Removing `m` — arbitrary single-letter shortcuts have no precedent in Pi's selector components
- ✅ `esc` in model picker = back to parent — correct; Pi's model-selector uses `esc` to close back to caller, and here the "caller" is the agent list, not the shell

**Problem 1: `ctrl+s` is already bound to `app.session.toggleSort` in Pi**

From keybindings.md line 101:
```
| app.session.toggleSort | ctrl+s | Toggle sort mode |
```

And from scoped-models-selector.js line 260:
```
| app.models.save | ctrl+s | Save current model selection to settings |
```

Both use `ctrl+s` in specific contexts (session tree, scoped models). Since the subagent hub is a custom `ctx.ui.custom()` component, it receives raw input and Pi's global shortcuts don't fire. So there's no **technical** conflict — the component intercepts all input before Pi's command system sees it.

However, there's a **semantic** conflict. In Pi's convention:
- `ctrl+s` = **persist to disk** (scoped-models-selector saves to settings.json)
- The subagent hub's "confirm" doesn't persist to disk — it returns in-memory overrides that the slash command handler then persists

Using `ctrl+s` for "confirm and return results" (which may or may not persist) creates a subtle expectation mismatch. The user might think "I saved" when they only confirmed.

**Better alternative:** Don't add a separate "confirm" key at all. The subagent hub is a **list of agents where each has a model**. The natural flow is:
1. Navigate to an agent → `enter` to drill in and pick a model
2. After picking a model, `esc` returns to agent list with the change applied
3. When done configuring, `esc` from the agent list closes the hub (since changes are already applied in-memory)

This matches how Pi's scoped-models-selector works: enter toggles, esc closes. There's no separate "confirm" step. Changes apply immediately. The `ctrl+s` there is for an *additional* action (persist to disk), not for "confirm and close."

If you still want an explicit "done" action (because returning from agent list via esc feels like "cancel"), use `ctrl+enter` or keep `ctrl+s` but label it "save" not "confirm." But I'd recommend the simpler esc-to-close pattern.

**Problem 2: Ambiguity — what does esc do from agent list?**

Current: `esc` = cancel (returns empty overrides, discarding everything)

If `esc` in model picker now means "back to agent list" (good), then what does `esc` from agent list mean?

Options:
- **A) Cancel (discard all overrides)** — current behavior. But then "esc" means different things at different levels (back vs discard). This is confusing.
- **B) Close and apply overrides** — makes esc consistent ("exit this level"). Model picker: esc = exit model picker. Agent list: esc = exit hub. Both preserve changes.
- **C) Close and apply, with ctrl+c = cancel (discard)** — most natural. `esc` = done (save), `ctrl+c` = abort (discard). Pi's own convention: `tui.select.cancel` binds to BOTH `escape` and `ctrl+c`, but for a multi-level component with accumulated state, splitting them makes sense.

**Recommendation: Option C.** This matches the UX expectation that `esc` closes and keeps changes, while `ctrl+c` is the hard abort. It also removes the need for a `ctrl+s` "confirm" key entirely.

### Revised shortcut scheme

| View | Key | Action |
|------|-----|--------|
| Agent list | `↑↓` | Navigate agents |
| Agent list | `enter` | Open model picker for selected agent |
| Agent list | `esc` | Close hub, apply all overrides |
| Agent list | `ctrl+c` | Cancel hub, discard all overrides |
| Model picker | `↑↓` | Navigate models |
| Model picker | `enter` | Select model, return to agent list |
| Model picker | `esc` | Cancel model change, return to agent list |
| Model picker | `type` | Search/filter models |

Footer hints:
- Agent list: `↑↓ navigate • enter model • esc done • ctrl+c cancel`
- Model picker: `↑↓ navigate • enter select • esc back • type search`

### Why this is better than the original proposal

1. **No `ctrl+s` conflict** — doesn't reuse a Pi-bound key
2. **Consistent esc behavior** — always means "go up one level" or "done" (not "discard")
3. **ctrl+c is the hard abort** — universal terminal convention
4. **No new modifier keys** — simpler muscle memory
5. **Matches Pi's own patterns** — model-selector.js uses enter=select, esc=cancel; scoped-models uses enter=toggle, esc=cancel. This hub adapts the same vocabulary for its two-level structure.

---

## Summary

| Item | Verdict |
|------|---------|
| Component usage (DynamicBorder, SelectList, etc.) | ✅ Correct components, but SelectList is render-only — should delegate input |
| Key hint formatting | ⚠️ Should use rawKeyHint() instead of custom formatKeyHints() |
| Keybinding API | ⚠️ Should use getKeybindings().matches() — moot if SelectList delegation is fixed |
| Shortcut proposal direction | ✅ Right direction (enter=select, remove m) |
| ctrl+s for confirm | ❌ Semantic conflict — don't add it |
| Revised scheme | ✅ esc=done, ctrl+c=cancel, enter=drill — consistent and Pi-native |
