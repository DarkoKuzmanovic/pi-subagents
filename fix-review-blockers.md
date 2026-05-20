## Fix applied: review blockers for disallowedTools + memory serialization

### Summary

Applied 4 fixes from code review + 1 regression test to `/home/quzma/.pi/agent/extensions/pi-subagents`.

### Files changed (5 files, +? -0)

| File | Change | Lines |
|------|--------|-------|
| `src/agents/agent-serializer.ts:58-61` | Fix 1 — Added serialization of `disallowedTools` (comma-joined, like `tools`) and `memory` (emitted when truthy) after the `skills:` block | +4 |
| `src/agents/agents.ts:213-216` | Fix 2 — Added `disallowedTools` and `memory` propagation to `cloneOverrideValue`, matching the pattern in `cloneOverrideBase` and handling the `false` sentinel for `disallowedTools` | +4 |
| `src/agents/agent-management.ts:370-371` | Fix 3 — Added `Disallowed tools:` and `Memory:` display lines in `formatAgentDetail` after the `Skills:` line | +2 |
| `CHANGELOG.md:9-11` | Fix 4 — Added 3 bullets under `## [Unreleased]` (denylist, memory, skill-preload tests) | +3 |
| `test/unit/agent-serializer.test.ts` | Fix 5 — New regression test (3 cases: round-trip preserves fields, omits when not set, empty array → undefined) | +73 |

### Verification

- `node --test test/unit/agent-serializer.test.ts` — ✅ 3/3 pass
- `node --test` all unit tests for affected modules (memory, denylist, skill-preload) — ✅ All pass
- `npm run test:unit` — ✅ 474 pass, 2 fail (both pre-existing in `package-manifest.test.ts`, unrelated)
- Typecheck — No new errors. All errors are pre-existing (`exports not declared` warnings in several source files, TUI render arg-count mismatches)
- `git diff --stat` — Clean: only the 4 tracked files modified, plus 1 untracked test file

### Edge cases covered by tests

1. `disallowedTools: ["bash", "write"]` + `memory: "project"` → serialize → parseFrontmatter → raw values match, splitting round-trips to original array
2. Config without these fields → no frontmatter lines emitted
3. `disallowedTools: []` → no frontmatter line (empty arrays are omitted, same as `tools: []`)

### Notes

- `cloneOverrideValue` fix handles the `false` sentinel for `disallowedTools` (same pattern as `tools`) — important because the override type allows `string[] | false`.
- The `memory` field uses a different type (`MemoryScope`, currently `"project"`) with no `false` sentinel in the override type, so the fix is simpler (just `memory: override.memory`).
- No test was added for `cloneOverrideValue` directly because it would require setting up a full builtin agent override environment. Left a TODO comment suggestion in the serializer test for future readers.
