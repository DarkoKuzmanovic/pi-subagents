# Subagent Hub TUI — Bug Fixes & Improvements Plan

## Status: Ready to implement

Based on a 3-reviewer parallel review (kimi-coding/k3, xai-auth/grok-4.5, openai-codex/gpt-5.6-sol), all findings below are deduplicated, verified against source, and prioritized.

---

## Already Fixed (this session)

- **Bug A: `cycleThinkingLevel` didn't persist companion model** — Tab only wrote `agentThinkingOverrides`, not `agentModelOverrides`. Fixed: now sets `baseModel` when the agent lacks a model override entry. (`subagent-hub.ts:413-418`)
- **Bug B: Settings overrides ignored for user/project agents** — `applyBuiltinOverrides` only ran on builtins; user agents from `~/.agents/` never got settings.json overrides applied. Fixed: `applySettingsOverridesToAgents` applies per-agent overrides to user/project agents, skipping names that shadow builtins. (`agents.ts:546-578`, both `discoverAgents` and `discoverAgentsAll`)

---

## Phase 1 — Critical data-loss bugs (fix first)

### 1.1 Save path full-replaces override entries → silent field wipe
**Severity:** Critical · **Consensus:** 3/3 reviewers
**Location:** `saveBuiltinAgentOverride` (`agents.ts:591`): `agentOverrides[name] = cloneOverrideValue(override)`
**Problem:** The hub passes `{ model, thinking? }` only. Any pre-existing `tools`, `skills`, `fallbackModels`, `disabled`, `memory`, `systemPrompt`, etc. in settings.json for that agent are silently destroyed.
**Fix:** Change `saveBuiltinAgentOverride` to merge into the existing entry rather than replace it. Read the current entry, patch only the keys present in the incoming override, write back. This protects all callers.

### 1.2 No-op open→esc rewrites all agents (no dirty tracking)
**Severity:** Critical · **Consensus:** 3/3 reviewers
**Location:** Constructor seeds `agentModelOverrides` for every agent with `agent.model` (`subagent-hub.ts:29-41`). Esc returns the entire maps (`subagent-hub.ts:114-115`). Save loop writes every seeded name (`slash-commands.ts:802-812`).
**Problem:** Opening `/subagents` and pressing Esc promotes every agent's frontmatter model into `settings.json` as a user override, fires "Subagent overrides saved" toast, and combines with 1.1 to destroy rich override objects.
**Fix:** Introduce dirty tracking. Only add entries to the result maps when the user explicitly changes something (model pick via Enter, thinking cycle via Tab). Seed display-only state separately from save state.

### 1.3 `thinking: "off"` doesn't round-trip
**Severity:** High · **Consensus:** 3/3 reviewers
**Location:** Constructor thinking seed skips `"off"` (`subagent-hub.ts:51`). Save only writes keys present in maps.
**Problem:** User cycles to `off` → saved. Reopen: `off` not seeded → esc produces `{ model }` only → `thinking: "off"` wiped. Next load reverts to unset.
**Fix:** Seed `"off"` when it's an explicit `agent.thinking` value (it's a meaningful override, not an absence). Alternatively, dirty tracking (1.2) solves this — only write what changed.

---

## Phase 2 — High-severity bugs

### 2.1 Tab thinking cycle doesn't trigger re-render
**Severity:** High · **Consensus:** 2/3 reviewers (confirmed by source)
**Location:** `handleInput` Tab branch (`subagent-hub.ts:118-120`) returns without `this.tui.requestRender()`. Every other input path calls it.
**Problem:** Thinking label appears stale after Tab until another key forces redraw.
**Fix:** Add `this.tui.requestRender()` after `this.cycleThinkingLevel()`. One-line fix.

### 2.2 Colon-tagged model IDs corrupted (Ollama `model:tag`)
**Severity:** High · **Consensus:** 3/3 reviewers
**Location:** Hub uses `splitThinkingSuffix` (`model-fallback.ts:14-20`) which splits at *any* trailing colon. The runtime uses `splitKnownThinkingSuffix` (`model-info.ts:44-52`) which only splits on known `THINKING_LEVELS`.
**Problem:** `ollama/llama3.1:70b` → seeded as model `ollama/llama3.1` with `thinking: "70b"`. Tab then pins this corruption. Display shows `thinking: 70b`.
**Fix:** Use `splitKnownThinkingSuffix` semantics everywhere in the hub. Export it from `model-info.ts` if not already exported. Validate thinking values against `THINKING_LEVELS` before seeding/persisting.

### 2.3 Model-less agents get fabricated model; Tab can pin it
**Severity:** High · **Consensus:** 3/3 reviewers
**Location:** `resolveAgentEffectiveModel` returns `availableModels[0].fullId` when agent has no model (`subagent-hub.ts:381-386`). Bug-A fix then persists this on Tab.
**Problem:** Display shows a registry default that's not configured. Runtime actually inherits the host's current model, not registry[0]. Tab converts this into a hard override.
**Fix:** Display `(host default)` for model-less agents. Don't include them in `agentModelOverrides` unless the user explicitly picks a model. The `cycleThinkingLevel` companion-model pin should only fire when the agent actually has a configured model.

### 2.4 Always saves to user scope; project overrides shadow silently
**Severity:** High · **Consensus:** 3/3 reviewers
**Location:** `slash-commands.ts:811` hardcodes `"user"`. Project settings win on load (`agents.ts:524-527`).
**Problem:** Editing a project-overridden builtin writes to user scope. Project override continues to win. Toast says "saved" but change has no effect.
**Fix:** Save to `agent.override?.scope ?? "user"`. Consider showing the target scope/path in the toast notification.

### 2.5 Shadowing agents: save/load identity collision
**Severity:** High · **Consensus:** 2/3 reviewers
**Location:** `applySettingsOverridesToAgents` skips agents whose name matches a builtin (`agents.ts:564-566`). But the hub shows the effective (shadowing) agent and saves by name.
**Problem:** Editing a user-defined `worker` (that shadows the builtin `worker`) writes the override to the same key the builtin reads. The shadowing agent never gets it.
**Fix:** This is a design limitation of name-only override keys. For now: detect in the hub when a user/project agent shadows a builtin and either (a) warn the user, or (b) skip saving and explain why. Longer term: source-qualified keys or post-merge override application.

### 2.6 Selecting a new model can retain unsupported thinking level
**Severity:** High · **Consensus:** 1/3 reviewers (verified)
**Location:** Model selection validates suffix from `currentModel` string (`subagent-hub.ts:311-320`), but `agentThinkingOverrides` is the actual source of truth and is not checked.
**Problem:** If thinking is `high` (set via Tab), then user picks a non-reasoning model, the saved override has `thinking: "high"` for a model that doesn't support it.
**Fix:** On model selection, read the effective thinking from `agentThinkingOverrides`, check against the selected model's `getSupportedThinkingLevels`, and clamp/clear if unsupported.

---

## Phase 3 — Medium-severity improvements

### 3.1 Non-atomic settings writes
**Severity:** Medium · **Consensus:** 2/3 reviewers
**Location:** `writeSettingsFile` (`agents.ts:274-277`) uses direct `writeFileSync`. Save loop does N read/write cycles.
**Fix:** Batch all override changes into one read-modify-write cycle. Use tmp+rename for atomicity. Wrap in try/catch in the slash handler.

### 3.2 No way to clear/reset an override
**Severity:** Medium · **Consensus:** 2/3 reviewers
**Fix:** Add a reset key (e.g. `x` or `backspace`) that removes the agent from dirty maps and, on save, calls `removeBuiltinAgentOverride`.

### 3.3 Override marker `✎` is meaningless
**Severity:** Medium · **Consensus:** 2/3 reviewers
**Location:** `isOverridden` is true for any agent with `agent.model` (`subagent-hub.ts:202`).
**Fix:** Base marker on `agent.override` presence (settings.json override exists) or dirty state (edited this session).

### 3.4 Stale suffix in display after Tab cycling
**Severity:** Medium · **Consensus:** 1/3 reviewers
**Problem:** Model override map may contain `:high`, and after cycling to `xhigh` the row shows conflicting info. Save is correct (buildModelThinkingOverride strips), but display is wrong.
**Fix:** Strip known suffix from displayed model; consult `agentThinkingOverrides` as the source of truth for the thinking column.

### 3.5 One malformed settings entry kills `/subagents`
**Severity:** Medium · **Consensus:** 1/3 reviewers
**Fix:** Wrap `discoverAgents` call in the slash handler with try/catch; notify error with the settings path.

### 3.6 SelectList recreated every render
**Severity:** Medium · **Consensus:** 2/3 reviewers
**Fix:** Create lists once; update selection/items when identity changes. Comment already says "Persisted" — make it true.

---

## Phase 4 — Low-severity polish

### 4.1 Footer/keyboard documentation gaps
- Main footer: add ↑↓ navigation hint
- Model picker footer: add ctrl+c hint
- Model picker: hide "enter select" when filter has no matches
- Main list: document typeahead or disable it

### 4.2 Model picker search: no paste support
`data.length === 1` check rejects multi-char paste. Accept multi-char printable input.

### 4.3 Fallback models invisible
Show `+N fallbacks` in description. Never drop `fallbackModels` on save (handled by merge fix in 1.1).

### 4.4 Dead code / misleading comments
- `cwd` constructor param is unused — remove
- Dead `SelectList.onCancel` callbacks (esc/ctrl+c intercepted before delegation)
- "Persisted SelectList instances" comment is wrong (until 3.6)
- `saveBuiltinAgentOverride` misnamed (used for all agent sources) — rename or add alias

### 4.5 Hub unit tests silently skip
`test/unit/subagent-hub.test.ts` catches import failure → 43 tests skip. Under `--experimental-transform-types`, 2 genuinely fail (stale assertions). Move to transform-types or fix import; fix the 2 stale tests.

---

## Suggested Implementation Order

1. **Phase 1 (1.1 + 1.2 + 1.3)** — These three are deeply interconnected. Dirty tracking + merge-on-save solves all three together. This is the highest-value change.
2. **2.1** — One-line `requestRender()` fix. Do immediately.
3. **2.2** — Switch to `splitKnownThinkingSuffix` in the hub. Small, targeted.
4. **2.3 + 2.6** — Model-less agent display + thinking validation on model change. Related logic.
5. **2.4** — Scope-aware save. Straightforward once dirty tracking exists.
6. **2.5** — Shadowing warning. Design decision needed.
7. **Phase 3** in priority order (3.1, 3.2, 3.3, 3.5, 3.4, 3.6).
8. **Phase 4** as cleanup.

---

## Test Coverage Gaps (add alongside fixes)

- [ ] Open hub → esc with pre-existing multi-field override → verify fields preserved
- [ ] `thinking: "off"` round-trip through save → load → hub display
- [ ] Colon-tagged model ID (`ollama/model:latest`) → no corruption
- [ ] Tab → visible re-render (or at least state change)
- [ ] Project-scoped override → hub save → reload → project still wins (with warning)
- [ ] Model-less agent → Tab → no fabricated model persisted
- [ ] Select non-reasoning model while `thinking: high` → thinking clamped
