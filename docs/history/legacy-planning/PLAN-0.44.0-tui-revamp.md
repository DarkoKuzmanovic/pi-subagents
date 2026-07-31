# Implementation Plan

## Goal
Revamp the registered `/subagents` model-configuration overlay into a Pi-style, theme-correct TUI while preserving `SubagentHubResult`, dirty-only persistence, scope-aware saving, and cancel semantics.

## Non-goals
Do not change model resolution, settings file ownership/serialization, agent discovery, fallback execution, or the result shape; do not add dependencies or create a new slash-command alias without a separate decision.

## Attributes
- Language/framework: ESM TypeScript, Pi `ctx.ui.custom`, `@earendil-works/pi-tui`, Node built-in test runner with project loader shims
- Blast radius: medium — one stateful TUI, its slash-command constructor call, and shared test shims; changes are reversible by phase commit
- Safety sensitivity: medium — the UI stages model/thinking writes and override removals, although disk persistence remains owned by the existing slash-command save boundary

## Implementation constraint (verified during Phase 1)

`@earendil-works/pi-tui` `SelectList` has **no `setItems`/`updateItems`** — once constructed, its row content is fixed. Any content change (edited model/thinking, `✎`/reset markers, filtered results) requires a NEW `SelectList` instance. So "stable component instance" means "not rebuilt during pure up/down navigation," NOT "the same object forever." Recreate each `SelectList` inside its view-builder on every genuine rebuild (view/data/theme/filter transition) and preserve selection by re-applying `setSelectedIndex(<tracked index>)` (or by agent/model identity). Pure navigation must NOT set the rebuild flag, so the active `Container` is reused wholesale and the view-builder is not re-entered. Phases 2–4 build more `SelectList`-backed views — apply this pattern consistently, and test the render → edit → re-render path (a test that only stages state before the first render will not catch a frozen list).

**Shim ≠ production API.** A test passing against a shim method the real component lacks is a production crash, not coverage. Before adding any method to `test/support/ts-loader.mjs` or the `.d.ts` shims that `src/` code calls, confirm it exists on the real `@earendil-works/pi-tui` / `pi-coding-agent` component using installed `docs/` + shipped `examples/` only (never `dist`). Do not assume a method by analogy with a sibling component (`SelectList.setSelectedIndex` existing does NOT prove `SettingsList` has it) — if a needed method is undocumented, stop and report, or refactor production to confirmed API. (Seen in Phase 3: unconfirmed `SettingsList.getSelected`/`setSelectedIndex` built into production, green only because the shim had them.)
## Tasks

1. **Phase 1 — Stabilize component structure, theming, and width behavior**
   - Files: `src/tui/subagent-hub.ts`, `src/slash/slash-commands.ts`, `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`, `test/support/ts-loader.mjs`, `test/support/shims/pi-tui.d.ts`
   - Changes:
     - Refactor `SubagentHubComponent` to own one active `Container` tree and rebuild it only on view/data transitions, not inside every `render(width)` call. Create each `SelectList` once per stable item set; preserve its selected item by model/agent identity when a rebuild is required.
     - Prefer the documented `Container` rebuild-on-invalidate pattern: `invalidate()` must invalidate the existing tree, then rebuild all `Text` children that contain pre-baked `theme.fg()`/`theme.bold()` strings. A theme invalidation may recreate lists; ordinary navigation/rendering must not.
     - Keep `DynamicBorder((s: string) => theme.fg("accent", s))` at the top and bottom, the five-function `SelectList` theme, and injected `tui.requestRender()` calls after state changes.
     - Replace the loose `editingAgentIndex` mode convention with a private discriminated view state (`main`, `model`, later `thinking`/`reset-confirm`) so subsequent phases do not accumulate conflicting booleans. Preserve explicit enter/exit helpers as test seams rather than exposing storage internals.
     - Remove `_cwd` from the constructor and remove only the corresponding `cwd` argument at the `ctx.ui.custom` call site and test constructors. Keep `overlay: true` and the existing `overlayOptions` unchanged.
     - Remove the manual top-level render cache; rely on stable child components and their own invalidation. Make the top-level `render(width)` apply `truncateToWidth(line, width, "")` as a final invariant guard, including very narrow widths and ANSI/wide-character content.
     - Fix the indentation defect around the model `SelectList` selection setup and remove touched non-null assertions/casts by narrowing indices and selected agents before use.
     - Extend the loader/runtime shim only as required for the new lifecycle (`Container.clear()`, `Container.invalidate()`, child invalidation). Keep the declaration shim aligned. Do not broadly rewrite global key matching in this phase.
   - Pi pattern: `Container`, `DynamicBorder`, `Text`, `Spacer`, stable `SelectList`, rebuild-on-invalidate.
   - Risks: Rebuilding on theme invalidation can lose selection; final-line truncation can hide footer text; changing global shims can affect unrelated tests.
   - Acceptance:
     - Unit tests prove repeated renders do not replace the active list, selection survives data/theme rebuilds by identity, and a mutable test theme produces new themed output after `invalidate()`.
     - Add width assertions using `visibleWidth` at narrow and normal widths, including long agent/model names and a wide Unicode character.
     - Run `npx tsc --noEmit`, `npm test`, and `npm run test:integration`.
     - Manual TUI check: open `/subagents`, navigate repeatedly, resize from below 60 columns through the overlay range, change Pi theme while open, and confirm no stale colors, clipped border overflow, or selection jumps.
   - Phase commit: `refactor(tui): stabilize subagent hub component tree`.

2. **Phase 2 — Fuzzy model search (hub-owned query)**
   - Files: `src/tui/subagent-hub.ts`, `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`, `test/support/ts-loader.mjs`, `test/support/shims/pi-tui.d.ts`
   - Changes:
     - Keep the hub owning the search query string and intercepting printable keystrokes itself (as today). Do NOT adopt the `Input` component: it exposes only `setValue`/`onSubmit`/`onEscape` with no documented live value-change surface, so it cannot drive filter-as-you-type; Pi's live filtering lives in the editor's `AutocompleteProvider`, which does not fit a modal overlay list. Model IDs are ASCII, so IME composition is a non-issue here.
     - Replace the substring filter with `fuzzyFilter(availableModels, query, (model) => `${model.provider} ${model.id} ${model.fullId}`)`. Empty query returns the deterministic source order established by the display phase; non-empty query preserves fuzzy ranking.
     - Preserve the selected model by `fullId` across query changes when it remains in the fuzzy results. If it disappears, select the first result; if no results remain, clear the list selection without fabricating a model.
     - Rebuild the model `SelectList` only when the filtered item set changes, not on every keystroke. Ensure every query change invalidates/rebuilds the relevant view and requests a render.
     - Update runtime and declaration shims with a behaviorally useful `fuzzyFilter` surface so tests execute rather than silently skip after imports change.
   - Pi pattern: `fuzzyFilter` (as used by `github-issue-autocomplete.ts`), stable `SelectList`.
   - Risks: None API-blocking. The earlier idea of embedding `Input` for IME was evaluated and rejected — `Input` has no live-value callback in the documented public surface (only `setValue`/`onSubmit`/`onEscape`), and Pi's filter-as-you-type lives in the editor's `AutocompleteProvider`, which does not fit a modal. The hub-owned query plus `fuzzyFilter` gets the real win without an unsupported live-filter combo. Residual risk: fuzzy ranking may surface surprising orders for very short queries — mitigate by keeping deterministic provider/id order on empty query and testing short-query behavior.
   - Acceptance:
     - Unit tests cover fuzzy provider/model/full-ID matching, fuzzy rather than substring-only matching, no results, empty query, paste, and selection preservation/fallback.
     - Integration tests drive keystrokes through the hub's model view and verify the rendered query/results change; assert the query is cleared and selection reset on enter/exit of the model view.
     - Run `npx tsc --noEmit`, `npm test`, and `npm run test:integration`.
     - Manual TUI check: type, paste, move within, delete from, and clear a query; verify the current model stays selected while still matched.
   - Phase commit: `feat(tui): add fuzzy model search`.

3. **Phase 3 — Add an idiomatic thinking-level settings view**
   - Files: `src/tui/subagent-hub.ts`, `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`, `test/support/ts-loader.mjs`, `test/support/shims/pi-tui.d.ts`, `test/support/shims/pi-coding-agent.d.ts`
   - Changes:
     - Add a `thinking` view framed with the same Pi border/title/footer pattern and backed by one `SettingsList` containing all agents. Each `SettingItem` uses `id = agent.name`, a label containing the effective base model, and `values = getSupportedThinkingLevels(findModelInfo(...))` for that agent's current model.
     - Use `getSettingsListTheme()` from `@earendil-works/pi-coding-agent` and `{ enableSearch: true }`. The `onChange(id, newValue)` callback updates only that agent, marks it dirty, removes it from pending resets, and pins the resolved model only when the agent already has a configured model, preserving the current thinking-only persistence invariant.
     - Recommended interaction: `tab` from the main list opens the thinking view and `escape`/`SettingsList.onClose` returns to the main list; it no longer changes configuration immediately. Keep `ctrl+c` as hard cancel from every view. Remove the old direct `cycleThinkingLevel()` UI path after equivalent SettingsList behavior is covered.
     - For an unset value, the main view will later display `inherit`, but `SettingsList.currentValue` must still be one of its legal values: use `off` when supported, otherwise the first supported value, without dirtying the agent until `onChange` fires. Do not persist a synthetic `inherit` string because `SubagentHubResult` has no clear-thinking-only operation.
     - When model selection changes, retain a current thinking override only if the new model supports it; otherwise set it to supported `off` (or the first supported level if `off` is absent), mark the agent dirty, and show the change before exit.
     - Add `SettingsList`, `SettingItem`, and `getSettingsListTheme()` to both test shim layers with enough cycling/onChange/onClose behavior to test real wiring.
   - Pi pattern: `SettingsList`, `SettingItem`, `getSettingsListTheme()`, `getSupportedThinkingLevels()`.
   - Risks: A whole-roster SettingsList is a new navigation mode; mapping unset display state to a legal SettingsList value must not create a dirty write; model changes can invalidate a previously selected level.
   - Acceptance:
     - Unit tests extend the current supported-level regression: unset remains absent on no-touch close, DeepSeek-style sparse levels expose/cycle only `off/high/xhigh`, off-only models remain unchanged, and a model change clamps an unsupported level.
     - Integration tests open the thinking view, exercise the shimmed SettingsList callback, return to main view, and verify dirty-only `thinkingOverrides` plus companion model behavior.
     - Run `npx tsc --noEmit`, `npm test`, and `npm run test:integration`.
     - Manual TUI check: edit multiple agents, use SettingsList search, verify Esc returns to the hub rather than saving/closing, and confirm Ctrl+C discards all staged changes.
   - Phase commit: `feat(tui): add thinking settings view`.

4. **Phase 4 — Apply display polish and scalable model ordering**
   - Files: `src/tui/subagent-hub.ts`, `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`
   - Changes:
     - Render `Subagent Models (<agent count> agents · <modified count> modified)`, where modified is the union of dirty and pending-reset agent names.
     - Use distinct, documented semantics and a compact legend: persisted override `●` in accent/dim, session edit `✎` in warning, and staged reset `↺` in warning. If states overlap, show both persisted and session markers; a staged reset replaces the edit marker. Treat `agent.override` as a persisted agent override, not specifically a model override, because `AgentConfig` does not retain which settings keys created the override metadata.
     - Distinguish unset thinking from explicit `off`: show dim `inherit` when no separate/suffix/base thinking exists; color explicit levels with `thinkingOff`, `thinkingMinimal`, `thinkingLow`, `thinkingMedium`, `thinkingHigh`, `thinkingXhigh`, or `thinkingMax` via an exhaustive `ThinkingLevel` helper.
     - In the model picker, change `Current:` to include both base model and active thinking (`inherit` when unset). Add each model's supported thinking levels to its row description along with provider/current state.
     - Sort the empty-query model list deterministically by provider then model ID, while keeping `preferredProvider` first if desired and explicitly tested. Preserve fuzzy relevance order for non-empty queries. Do not add selectable fake provider-header rows to `SelectList`; true grouping would require a custom list and conflicts with the “prefer existing components” rule.
     - Split each crowded footer into at most two short `Text` rows: primary navigation/action hints and secondary close/cancel or marker legend. Continue using `rawKeyHint`; rely on width truncation for narrow overlays.
   - Pi pattern: Pi thinking theme colors, `Text`, `rawKeyHint`, `truncateToWidth`, `visibleWidth`.
   - Risks: ANSI colors inside `SelectItem` labels/descriptions may interact with selection theming; provider-first sorting must not fight fuzzy rank; glyph widths vary by terminal.
   - Acceptance:
     - Unit tests assert persisted/session/reset markers separately, explicit `off` versus `inherit`, modified count transitions, all thinking-color keys through a recording theme, supported-level text, current model+thinking, deterministic provider ordering, and line widths.
     - Integration tests verify the complete main/model renders at 60, 84, and 100 columns without relying on exact ANSI sequences.
     - Run `npx tsc --noEmit`, `npm test`, and `npm run test:integration`.
     - Manual TUI check: inspect Tokyo Night plus one contrasting theme, long provider/model names, 12+ agents, many models, and wide-character terminal content.
   - Phase commit: `style(tui): polish subagent model hub`.

5. **Phase 5 — Add safe single/bulk reset with undo**
   - Files: `src/tui/subagent-hub.ts`, `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`
   - Changes:
     - Keep lowercase `x` as “stage reset for selected persisted override,” but make it reversible with `u` until the hub closes. Store a typed snapshot of the affected agents' model/thinking map entries and dirty/reset membership so undo restores the exact pre-reset staged state.
     - Reserve uppercase `X` for bulk reset. It targets only agents with `agent.override` metadata, opens a Pi-framed confirmation `SelectList` (`Reset N persisted overrides` / `Cancel`), and stages resets only after explicit confirmation. Escape cancels confirmation and returns to the main view; Ctrl+C still hard-cancels the entire hub.
     - Bulk reset clears conflicting session edits for targeted persisted agents, adds their names to `resetAgents`, and records one undo transaction. Agents without persisted override metadata are never added to `resetAgents` by bulk reset.
     - Preserve last-write-wins: editing a reset agent removes it from `resetAgents`; resetting an edited persisted agent removes it from dirty maps; `buildDirtyResult()` remains the single result boundary and keeps the existing shape.
     - Update footers/header counts for staged resets and undo availability. Do not write settings from the component; actual removal remains in `slash-commands.ts` after `done()`.
   - Pi pattern: `SelectList` confirmation, staged local state, existing `done()` lifecycle.
   - Risks: Snapshot/undo bugs can restore stale model/thinking state; overlapping single and bulk reset transactions need a clear “undo last transaction only” rule; closing with Esc intentionally commits staged resets.
   - Acceptance:
     - Unit tests cover selected reset, no-op on non-persisted agents, undo, bulk target count, confirm/cancel, edit-after-reset, reset-after-edit, reset then Ctrl+C, and the exact dirty-only `SubagentHubResult` maps/sets.
     - Integration tests drive main → confirmation → main and verify rendered count/markers plus unchanged slash-command persistence contract.
     - Run `npx tsc --noEmit`, `npm test`, `npm run test:integration`, and final `npm run test:all`.
     - Manual TUI check: stage/undo single reset, cancel/confirm bulk reset, edit after reset, exit with Esc, reopen to confirm persistence, and separately verify Ctrl+C leaves settings untouched.
   - Phase commit: `feat(tui): add safe bulk override reset`.

## Decision Points

1. **Thinking interaction — recommendation: replace direct Tab cycling with a roster-wide `SettingsList`.** This uses Pi's idiomatic component, exposes sparse model-supported values, supports search, and avoids accidental one-keystroke writes. Alternative: keep Tab cycling and add `t` for SettingsList; this is faster but duplicates mutation paths and footer hints.
2. **Provider organization — recommendation: deterministic provider/model sorting, not fake group headers.** It scales the unfiltered list without making headers selectable or replacing `SelectList`. Alternative: a custom grouped list, justified only if Pi later ships grouped/non-selectable `SelectList` rows.
3. **Reset safety — recommendation: immediate staged single reset with one-step undo, explicit confirmation for bulk reset.** Single reset is already non-durable until exit; bulk scope merits confirmation. Alternative: confirmation for every `x`, which is safer but adds friction.
4. **Unset thinking — recommendation: display `inherit`, but never persist it.** In SettingsList, map unset to a legal supported value for display only and do not dirty until change. Alternative: add a clear-thinking sentinel, which would require changing `SubagentHubResult` and is out of scope.
5. **Overlay sizing — recommendation: retain current centered 60%/60–100 column/80% height options.** Do not add `visible()` because hiding an input-owning modal on narrow resize can strand the command. Revisit only with an explicit narrow-terminal fallback design.
6. **Command naming — recommendation: revamp the actual registered `/subagents` overlay only.** The task and current changelog call it `/subagent models`, but `src/slash/slash-commands.ts` registers `subagents` and has no `subagent` command. Adding an alias is a separate product/API decision.
7. **Search box approach — RESOLVED: keep hub-owned query + `fuzzyFilter`, do NOT embed `Input`.** The consulted public docs/examples confirm `Input` exposes only `setValue`/`onSubmit`/`onEscape` with no live value-change callback/getter, and Pi's filter-as-you-type lives in the editor's `AutocompleteProvider` (`CombinedAutocompleteProvider` + `fuzzyFilter`), which does not fit a modal overlay list. Model IDs are ASCII so IME is a non-issue. The hub keeps owning the query string (as today) and swaps the substring match for `fuzzyFilter`.

## Test Plan

- `test/unit/subagent-hub.test.ts`: replace manual state-manipulation “navigation” checks with behavior-driven component/helper checks where the shims support them; extend dirty tracking, no-touch results, selected/bulk reset and undo, fuzzy filtering and selection preservation, supported thinking transitions, unset versus explicit off, theme invalidation, and `visibleWidth <= width`. Add no new `any`; use `unknown` plus narrow test interfaces for private test seams.
- `test/integration/subagent-hub.test.ts`: exercise complete view transitions and rendered output using `tryImport`, including fuzzy search keystroke flow, SettingsList callbacks, main/model/thinking/reset-confirm views, current model+thinking, marker/count updates, and cancellation. Assert outcomes rather than exact ANSI formatting.
- `test/support/ts-loader.mjs`: add minimal behaviorally accurate runtime shims for only the newly imported Pi surfaces. Ensure missing exports fail loudly instead of causing all hub tests to skip silently.
- `test/support/shims/pi-tui.d.ts` and `test/support/shims/pi-coding-agent.d.ts`: mirror only the public APIs used by the hub (`fuzzyFilter`, `SettingItem`, `SettingsList`, `getSettingsListTheme`) and keep test types narrow.
- Baseline/final gates: record the pre-change skipped/passed counts; after each phase run `npx tsc --noEmit`, `npm test`, and `npm run test:integration`; after Phase 5 run `npm run test:all`. A green suite with all hub tests skipped is not acceptance.

## Files to Modify

- `src/tui/subagent-hub.ts` - component lifecycle, fuzzy search, SettingsList thinking view, display polish, reset/undo state, width guarantees
- `src/slash/slash-commands.ts` - remove the dead constructor argument only; preserve overlay options and persistence logic
- `test/unit/subagent-hub.test.ts` - state/result/filter/theme/width/reset regressions using Node test
- `test/integration/subagent-hub.test.ts` - end-to-end component view and input wiring coverage
- `test/support/ts-loader.mjs` - runtime Pi component shims needed by the existing test harness
- `test/support/shims/pi-tui.d.ts` - declarations for newly used public TUI components/utilities
- `test/support/shims/pi-coding-agent.d.ts` - declaration for `getSettingsListTheme()`

## New Files

- None. Extend the existing source and test files; do not create duplicate TUI or test modules.

## Dependencies

- Phase 1 is the structural prerequisite for every later phase.
- Phase 2 depends on Phase 1's stable view/list lifecycle.
- Phase 3 depends on Phase 1's explicit view state; it can proceed independently of Phase 2 only if commits are kept separable, but the preferred execution order is 1 → 2 → 3.
- Phase 4 depends on the final search and thinking state semantics from Phases 2–3.
- Phase 5 depends on Phase 4's marker/count vocabulary and must preserve the dirty-result boundary established in Phase 1.
- The orchestrator, not a worker, should create each phase commit after its verification gate.

## Risks

1. **Material — persistence regression:** dirty/reset overlap could accidentally save untouched agents or remove the wrong scoped override.
2. **Material — theme invalidation:** pre-baked text can remain stale, while over-rebuilding can lose list/input selection.
3. **Material — weak/skipping harness:** current dynamic imports and incomplete shims can report green while hub tests are skipped; several current tests manipulate state instead of driving behavior.
4. **Width/ANSI behavior:** colored glyphs, wide characters, and long rows can exceed the overlay width unless checked after composition.
5. **SettingsList unset semantics:** `inherit` is not a persisted `ThinkingLevel`, so a display-only mapping must not create writes.
6. **Fuzzy ordering versus grouping:** re-sorting fuzzy results would erase relevance; fake group rows would be selectable.
7. **Reset UX/state complexity:** undo-last semantics and edit-after-reset ordering must be explicit and tested.

The first three risks are release-blocking; the remaining four are contained by width/state tests and manual TUI verification.

## Rollback

- Keep one verified commit per phase with the subjects listed above. Preferred rollback on branch `tui-revamp`: `git revert <phase-commit>` in reverse dependency order (Phase 5 back to Phase 1), followed by `npx tsc --noEmit && npm run test:all`.
- If a phase is uncommitted, restore only files touched by that phase with explicit paths, for example `git restore -- src/tui/subagent-hub.ts test/unit/subagent-hub.test.ts`; never use broad restore/reset commands in the shared checkout.
- Phase 5 rollback removes bulk confirmation/undo while retaining polished single-reset behavior from earlier phases.
- Phase 4 rollback removes visual/order changes without changing state or persistence contracts.
- Phase 3 rollback restores the prior thinking interaction; if Tab cycling was removed in the same phase, revert the whole phase so there is always one complete thinking-edit path.
- Phase 2 rollback restores the prior substring-based model search implementation and associated shims.
- Phase 1 rollback must include the constructor call-site/test argument changes together so source and callers remain type-compatible.

## Documentation and Examples Consulted

- Installed Pi documentation: `/home/quzma/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md` (read in full)
- Shipped selection overlay example: `/home/quzma/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/preset.ts`
- Shipped SettingsList example: `/home/quzma/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/tools.ts`
- Shipped Input/focus examples (consulted while evaluating, then rejecting, the `Input` search-box approach): `/home/quzma/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/rpc-extension-ui.ts` and `examples/extensions/overlay-qa-tests.ts`
- Shipped fuzzy matching example: `/home/quzma/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/github-issue-autocomplete.ts`

Noted disagreements/gaps: the repository registers `/subagents`, not `/subagent models`; `docs/tui.md` requires an explicitly typed `DynamicBorder` callback while the current shipped `preset.ts` relies on inference in that callback; and `Input` exposes no live value-change surface, so the hub retains its own query string and uses `fuzzyFilter` for matching rather than embedding `Input`.
