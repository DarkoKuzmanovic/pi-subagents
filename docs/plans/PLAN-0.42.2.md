# v0.42.2 — Restore chain-default clarify precedence

**Milestone:** M11
**Status:** implemented — v0.42.2 (2026-07-20)

## Invariant

A chain backgrounds only when `clarify: false` is explicit. User-level `asyncByDefault: true` must not silently bypass the chain-default clarification flow.

## Owning change

Restore only the chain branch of the top-level `effectiveAsync` expression:

```ts
requestedAsync && (hasChain ? clarify === false : clarify !== true)
```

Do not change downstream `executeChain` behavior or the existing single/parallel rule.

## Required regression

Add a routing truth table covering single, top-level parallel, and chain calls with:

- omitted and explicit `async`;
- omitted, `true`, and `false` `clarify`;
- user configuration `asyncByDefault: true`;
- chains containing parallel groups, preserving foreground execution without forcing the clarification TUI when the existing contract says not to show it.

Expected chain behavior:

| Effective async requested | `clarify` | Background |
|---|---|---|
| false | any | no |
| true | omitted | no |
| true | `true` | no |
| true | `false` | yes |

Single and top-level parallel calls retain their existing `clarify !== true` rule.

## Verification

- Focused routing truth-table regression passes.
- Existing chain clarification and async routing tests pass.
- Typecheck and full unit suite pass.
- README/schema claims remain aligned: explicit chain background execution requires `clarify: false`.
