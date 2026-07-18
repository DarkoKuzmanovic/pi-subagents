# M2 — Lane-editing TUI

**Status:** planned candidate; inactive; no task packet or implementation started
**Originally planned:** 2026-06-08; awaiting explicit reprioritization

## Goal

Provide a first-class editor for user-scope `subagents.modelLanes` while preserving the JSON configuration shortcut as the transparent control plane. The editor manages lane model and thinking values only; it does not change dispatch semantics.

M1 already proved the prerequisite: generic lane resolution and `/subagents config|json|edit` shipped in v0.36.0. An earlier reviewer-specific TUI sketch established the basic interaction, but M2 deliberately widens the product surface to lanes for every role.

## Scope

### Safe lane store

- Read user settings strictly and distinguish absent configuration from malformed `subagents` or `modelLanes` shapes.
- Create, update, and remove a lane while preserving every unrelated settings field.
- Validate lane name, non-blank model string, and thinking against the canonical thinking-level set.
- Write atomically, create the parent directory when needed, and end the JSON file with a trailing newline.
- Keep user-scope and project-scope resolution explicit. Project lanes may be displayed read-only; the TUI must not silently copy or overwrite them.
- Changes made through the TUI and `/subagents config|json|edit` must be mutually visible.

### Lane editor

- Reachable from the existing `/subagents` hub.
- List each role's lanes with model and thinking.
- Add a lane, edit its model/thinking, and remove it with confirmation.
- Reuse existing `SelectList`, `DynamicBorder`, and model/thinking picker behavior rather than introducing a second TUI system.
- Expose a compact, discoverable keybinding/help hint.

## Interaction sketch

```text
Agent list → [Enter] → Model picker for the role default
           → [L]    → Lane view for selected role
                        → [Enter] → Edit lane model/thinking
                        → [N]     → New lane
                        → [D]     → Delete lane with confirmation
                        → [Esc]   → Back to agent list
           → [Tab]  → Cycle role-default thinking
           → [Esc]  → Save and exit
```

The exact keys may change during the design gate if they conflict with current hub navigation. The behavior—not the prototype key letters—is the contract.

## Out of scope

- Editing project-scope lanes; display them read-only when present.
- Changing lane resolution, precedence, dispatch propagation, or model-candidate fallback.
- Automatic task-difficulty classification or routing by task text.
- New lane fields beyond `model` and `thinking`.
- Replacing the JSON editor shortcut.
- Reworking unrelated `/subagents` model-override behavior.

## Invariants

- Preserve unrelated settings and existing `agentOverrides` byte-semantically after parse/serialize.
- Never replace malformed settings with a clean skeleton; report an actionable error instead.
- Unsupported thinking levels must not be persisted for the selected model.
- Existing `/subagents` hub and `/subagents config|json|edit` behavior must continue to work.
- Use ESM TypeScript conventions and the existing Node test runner.
- User-scope persistence is a protected configuration boundary and requires a deep combined review when implemented.

## Acceptance criteria

- Lane store tests cover create, edit, remove, preserve-other-fields, missing file, malformed shape, invalid model, invalid thinking, atomic replacement, parent creation, and trailing newline.
- TUI tests cover entering the lane view, selecting a role/lane, add/edit/remove result state, cancellation, and confirmation behavior where the harness permits.
- Project-scope lanes are visibly read-only and cannot be mutated through the user editor.
- A lane created in the TUI resolves through normal dispatch without any lane-runtime changes.
- Documentation and bundled skill examples explain the editor and retain the JSON fallback.
- Relevant focused tests, typecheck, and the full unit suite pass.

## Open decisions for the design gate

- Filter unsupported thinking levels or show them disabled with an explanation.
- Lane-name rules: the original sketch allowed freeform strings; the persisted API needs a clear normalization/rejection contract.
- How to display a project lane shadowed by a user lane of the same name.
- Whether lane deletion requires typing the name or a simpler explicit confirmation.
- Final keybindings and help text in the current hub layout.

## Planning handoff

This document is design input, not execution authorization. When M2 is explicitly selected, create a transient root `PLAN.md` with canonical outcomes such as `M2.1`, `M2.2`, and so on. Do not recreate PMTI task packets or durable task IDs.
