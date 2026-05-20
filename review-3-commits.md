# Review: Three Commits on pi-subagents

**Reviewer:** DeepSeek V4 Pro (read-only review)
**Reviewed against:** HEAD of current branch (849d466, 6271a88, 3ae405a)
**Date:** 2026-05-19

---

## Verdict: REQUEST-CHANGES

Two BLOCKER-level serialization bugs and one MAJOR visibility gap need fixing before merge. No regressions in unit tests, but typecheck is pervasively broken (pre-existing, unrelated to these commits).

---

## Findings by Severity

### BLOCKER 1: `serializeAgent` silently drops `disallowedTools` and `memory` fields

**File:** `src/agents/agent-serializer.ts:33-86`
**Evidence:** `serializeAgent()` iterates over every field it knows how to serialize (name, description, tools, model, etc.) but has **no clause** for `disallowedTools` or `memory`. Both are in `KNOWN_FIELDS` (lines 24-25), so they won't leak through `extraFields` either — they're simply dropped on every write.

**Impact:** Create an agent with `handleCreate({ config: { name: "test", description: "x", disallowedTools: ["bash"], memory: "project" } })`. The agent file is written, but `disallowedTools` and `memory` are omitted from the frontmatter. On the next `discoverAgents()` load, the agent has neither. The denylist and memory features are **invisible after the first save cycle**.

**Fix:** Add serialization blocks to `serializeAgent()`:

```typescript
if (config.disallowedTools?.length) {
  lines.push(`disallowedTools: ${config.disallowedTools.join(", ")}`);
}
if (config.memory) {
  lines.push(`memory: ${config.memory}`);
}
```

---

### BLOCKER 2: `cloneOverrideValue` doesn't propagate `disallowedTools` or `memory`

**File:** `src/agents/agents.ts:198-213`
**Evidence:** `cloneOverrideValue()` (used by `saveBuiltinAgentOverride()`) spreads model, fallbackModels, thinking, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, disabled, systemPrompt, skills, and tools — but **not** `disallowedTools` or `memory`. Meanwhile, `cloneOverrideBase()` (line 179-196) **does** include both, so the base is captured but the override delta is lost.

**Impact:** `saveBuiltinAgentOverride()` strips `disallowedTools` and `memory` from the persisted override config. A user who runs `pi agents save <name> --config.disallowedTools=bash` will get a saved override that silently ignores the disallowedTools field.

**Fix:** Add the missing fields:

```typescript
...(override.disallowedTools !== undefined
  ? { disallowedTools: override.disallowedTools === false ? false : [...override.disallowedTools] }
  : {}),
...(override.memory !== undefined ? { memory: override.memory } : {}),
```

---

### MAJOR 1: `formatAgentDetail` doesn't display `disallowedTools` or `memory`

**File:** `src/agents/agent-management.ts:359-383`
**Evidence:** The `formatAgentDetail` function constructs a human-readable display of an agent's config (name, model, tools, skills, systemPromptMode, etc.) but has no line for `disallowedTools` or `memory`.

**Impact:** `pi subagents get <agent>` cannot show these fields. Users have no way to verify their denylist or memory config was applied.

**Fix:** Add display lines:

```typescript
if (agent.disallowedTools?.length) lines.push(`Disallowed tools: ${agent.disallowedTools.join(", ")}`);
if (agent.memory) lines.push(`Memory: ${agent.memory}`);
```

---

### MAJOR 2: No CHANGELOG entries for any of the three features

**File:** `CHANGELOG.md`
**Evidence:** Grep for `memory`, `disallowed`, `preload`, `MEMORY`, `skill.*preload` — zero matches in the `## [Unreleased]` section (the only false hit is "in-memory" in a different context on line 302).

**Impact:** Features are invisible to consumers reading the changelog. This is a project convention violation.

**Fix:** Add entries under `## [Unreleased]`:
```
- Added `disallowedTools` denylist for built-in tools on agent frontmatter.
- Added persistent agent memory (project scope) with MEMORY.md index for reviewer, scout, and other agents.
- Added tests for skill preloading from agent frontmatter.
```

---

### MINOR 1: TOCTOU race in symlink check on `readMemoryIndex`

**File:** `src/shared/memory.ts:34-40`
**Evidence:** The function checks `isSymlink(memoryDir)` at line 36 → `existsSync`, then later calls `readFileSync(memoryFile)` at line 43. Between the stat and the open, an attacker with filesystem write access could replace `memoryDir` with a symlink.

```typescript
if (isSymlink(memoryDir)) return undefined;   // Line 36 — check
const memoryFile = join(memoryDir, "MEMORY.md"); // Line 38 — TOCTOU window
if (isSymlink(memoryFile)) return undefined;   // Line 40 — separate check on leaf
// ...
readFileSync(memoryFile, "utf-8");             // Line 43 — open
```

**Impact:** Low in practice (requires filesystem access + precise timing), but if someone else controls `memoryDir` and can swap it for a symlink to `/etc/passwd` between lines 36 and 43, the content leaks into the agent's system prompt.

**Fix (belt-and-suspenders):** Open the file with `O_NOFOLLOW` flag. On Node.js, use `fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)` and `fs.readFileSync` on the fd. This atomically rejects symlinks at open time.

---

### MINOR 2: No write-time 200-line cap enforcement

**File:** `src/shared/memory.ts`
**Evidence:** The `MAX_MEMORY_LINES = 200` cap is enforced on **read** (`readMemoryIndex`, line 45-47) — if the file on disk is longer than 200 lines, it's truncated on read. There is no write path in this codebase, so there's no enforcement on write.

**Impact:** Forward risk only. If a future write path is added (e.g., in an `updateMemoryIndex` function), the 200-line cap must be enforced there too. The current code has no such enforcement, so an unwitting future implementer could write unlimited-length files.

**Fix:** Add a note in the file header or add a `writeMemoryIndex` stub that enforces the cap, making the enforcement boundary obvious:

```typescript
export function enforceLineCap(content: string, maxLines = MAX_MEMORY_LINES): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + "\n\n[MEMORY.md truncated at 200 lines]";
}
```

---

### MINOR 3: Assertion in line-cap test is confusing

**File:** `test/unit/memory.test.ts:61`
**Evidence:**
```typescript
assert.ok(contentLines.length <= 202, `expected <=202 lines (200 + truncation notice), got ${contentLines.length}`);
```
The test feeds 300 lines, reads back, and asserts `<= 202`. The comment says "200 + truncation notice" but the notice itself has 3 lines (`[MEMORY.md truncated at 200 lines]\n` prepended by the `\n\n` in the join), which creates ambiguity. The actual result is 200 content lines + 2 lines for the truncation notice (one empty + one message) = 202. This is technically correct but fragile — if the truncation notice format changes, the assertion breaks silently.

**Fix:** A more self-documenting assertion:
```typescript
assert.equal(contentLines.length, 202, `expected 200 content lines + 2 truncation notice lines`);
```

---

### NIT 1: No guard against Unicode normalization in `isUnsafeName`

**File:** `src/shared/memory.ts:18-20`
**Evidence:** `isUnsafeName` checks for `".."`, `"/"`, `"\\"`, and `"\0"`. On certain filesystems (e.g., HFS+, APFS with Unicode normalization), `\u2024\u2024` (two ONE DOT LEADER characters) or `\uFE52` (SMALL FULL STOP) could be normalized to `..` or `.` at the filesystem layer. A project named `project\u2024\u2024agent` would pass `isUnsafeName` but resolve to `project..agent` on disk.

**Impact:** Exotic, unlikely in practice (requires HFS+ or custom normalization), but the function's name implies comprehensive safety.

**Fix:** Use `path.normalize()` on the resolved path and compare against the expected prefix to catch unexpected normalization results. Or document the limitation.

---

### NIT 2: `resolveMemoryDir` switch has no default case

**File:** `src/shared/memory.ts:27-31`
**Evidence:**
```typescript
switch (scope) {
  case "project":
    return join(cwd, ".pi", "agent-memory", agentName);
}
```
If `MemoryScope` ever gains a second member (e.g., `"user"`, `"global"`), this switch falls through silently and returns `undefined`. TypeScript may not catch this if the function return type is `string`.

**Fix:** Add a default clause:
```typescript
default:
  throw new Error(`Unknown memory scope: "${scope}"`);
```

---

### NIT 3: `memory` import in `agents.ts` line 10 is `type`-import but used as `const` import

**File:** `src/agents/agents.ts:10`
**Evidence:** `import type { MemoryScope } from "../shared/memory.ts";` — this imports only the type, which is correct. But if `MemoryScope` ever gains a runtime value (like a lookup map), this import becomes insufficient. Minor, not a bug today.

---

## Per-commit notes

### 849d466 (memory) — Additional notes beyond blockers above

- **Symlink guards are good** (both `memoryDir` and `MEMORY.md` checked), but the TOCTOU gap remains.
- **Path traversal guards are correct** for ASCII paths. The `isUnsafeName` check paired with `join(cwd, ".pi", "agent-memory", agentName)` means the final path is constrained to `.pi/agent-memory/<agentName>/`. No way to escape above `.pi/` unless `isUnsafeName` misses something.
- **200-line cap test passes** (confirmed via `npm test`).
- **`isReadOnlyAgent` function** (execution.ts:914-918) correctly identifies write-tool agents — the memory block is injected with `readOnly: true` or regular instructions based on this. This is correct.
- **Project root detection** via `findNearestProjectRoot` (agents.ts:216-227) walks up from cwd looking for `.pi/` or `.agents/`. This is consistent with the rest of the codebase.

### 3ae405a (denylist) — Additional notes

- **Allowlist vs denylist interaction is correct**: `disallowedTools` filters the already-allowlisted `builtinTools` array. If a tool is not in `tools:`, it's never in the builtin list, so the denylist can't re-add it. Correct.
- **No hardcoded builtin list** — the code separates tools by heuristic (path-like vs not). This is future-proof: any new Pi builtins are automatically subject to the denylist.
- **MCP tools and extension tools unaffected** — they're kept in separate arrays. Correct by design.
- **Empty `[]` vs missing `undefined`**: Both are handled correctly. `[]` creates an empty `Set`, filter passes everything. `undefined` skips the filter entirely.
- **Recursive delegation**: A child can be denied `subagent` via `disallowedTools: ["subagent"]`, but only if `subagent` is in its `tools:` list. Most builtin agents don't include `subagent` in their tools, so for them the denylist entry would be a no-op. This is correct behavior.

### 6271a88 (skill preloading tests) — Additional notes

- **Tests are meaningful** — they verify `resolveSkillsWithFallback` returns consistent results (input length = resolved + missing), `buildSkillInjection` actually produces content with skill XML tags, and missing skills are reported. Not tautological.
- **Tests are non-flaky** — they use `process.cwd()` which is deterministic. Though the first test ("returns consistent results") is weak: it asserts `total === 1` but doesn't assert anything about *which side* the result ends up on. This could pass even if `pi-subagents` isn't actually discoverable.
- **The test file is `.ts`, imports via `../../src/agents/skills.ts`** — the `.ts` extension over the .js convention. This is consistent with the project's test convention (the register-loader rewrites `.js` → `.ts`).

---

## Test Results

| Test suite | Pass | Notes |
|-----------|------|-------|
| `test/unit/memory.test.ts` | ✅ All 11 pass | 4 describe blocks, 11 tests, all green |
| `test/unit/pi-args-denylist.test.ts` | ✅ All 5 pass | 5 tests, all green |
| `test/unit/skill-preload.test.ts` | ✅ All 4 pass | 4 tests, all green |
| `npm run test:unit` | ❌ 1 pre-existing failure | The `skill-preload`-style test tries to mkdir `~/.agents/skills` — pre-existing, unrelated |
| `npm run test:integration` | ❌ Pre-existing failures | Pre-existing, unrelated to these commits |
| `npm run typecheck` | ❌ Hundreds of errors | Pre-existing (`@types/node` missing, Pi package type mismatches), unrelated to these commits |

---

## Summary

| Severity | Count | Must fix before merge? |
|----------|-------|----------------------|
| BLOCKER | 2 | Yes |
| MAJOR | 2 | Yes (change discipline) |
| MINOR | 3 | Recommended |
| NIT | 3 | Optional |

The functional logic is sound: memory reads work, denylist filtering works, skill preloading tests pass. But the serialization bugs (BLOCKER 1 + 2) mean `disallowedTools` and `memory` are **silently lost** every time an agent is saved or an override is persisted. These must be fixed before the feature is usable by end users.
