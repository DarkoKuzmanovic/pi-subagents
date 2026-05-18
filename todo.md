# pi-subagents — TODO

Follow-up items from the review of commits 3ae405a, 6271a88, 849d466.
Full review: [`review-3-commits.md`](./review-3-commits.md). Fixes already shipped: 956b905, 6abf540.

## Done

- [x] BLOCKER 1 — `serializeAgent` drops `disallowedTools` and `memory` (956b905)
- [x] BLOCKER 2 — `cloneOverrideValue` drops the same fields (956b905)
- [x] MAJOR 1 — `formatAgentDetail` doesn't display these fields (956b905)
- [x] MAJOR 2 — CHANGELOG entries for the three features (6abf540)
- [x] NEW — Round-trip regression test for serializer (956b905)
- [x] MINOR 1 — TOCTOU race in symlink check on `readMemoryIndex` (1884b2f)
- [x] MINOR 2 — No write-time 200-line cap enforcement: extracted `enforceLineCap` (358af3d)
- [x] MINOR 3 — Confusing assertion in line-cap test (4f98fa3)
- [x] NIT 4 — No Unicode normalization guard in `isUnsafeName` (da0f86c)
- [x] NIT 5 — `resolveMemoryDir` switch has no default case (4b95bb6)
- [x] NIT 7 — Weak first assertion in skill-preload test (889cade)

## Intentionally Skipped

- [ ] NIT 6 — Type-only import for `MemoryScope` **skipped**: `MemoryScope` is still a pure type (`export type MemoryScope = "project"`). Changing to non-type import would cause a runtime error. Defer until it gains a runtime value.

