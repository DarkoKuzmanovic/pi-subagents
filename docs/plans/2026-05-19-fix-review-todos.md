# Fix Review TODOs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address 7 follow-up items from code review (3 MINOR bugs + 4 NIT improvements) in the pi-subagents extension.

**Architecture:** Fix security race conditions and defensive coding issues in memory subsystem and test assertions, maintaining TDD discipline with minimal, focused changes.

**Tech Stack:** TypeScript, Node.js `fs` module, Node.js test runner

---

## File Structure

- Modify: `src/shared/memory.ts` (symlink check, line cap, Unicode normalization, switch default)
- Modify: `test/unit/memory.test.ts` (line cap assertion)
- Modify: `test/unit/skill-preload.test.ts` (skill preload assertion)
- Modify: `src/agents/agents.ts` (remove type-only import)

---

## Task 1: Fix TOCTOU race in symlink check

**Files:**
- Modify: `src/shared/memory.ts:34-40`

**Step 1:** Read the current implementation

Run: `read src/shared/memory.ts 34-40`

**Step 2:** Add `O_NOFOLLOW` flag to atomic symlink rejection

```typescript
import { openSync, readFileSync, closeSync, constants } from "node:fs";

// Replace lines 34-40:
const fd = openSync(memoryFile, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  return readFileSync(fd, "utf-8");
} finally {
  closeSync(fd);
}
```

**Step 3:** Run tests to verify no regressions

Run: `npm test` (should pass)

**Step 4:** Commit

```bash
git add src/shared/memory.ts
git commit -m "fix: add O_NOFOLLOW to atomic symlink check in readMemoryIndex"
```

---

## Task 2: Extract enforceLineCap helper for reuse

**Files:**
- Modify: `src/shared/memory.ts` (add helper function)

**Step 1:** Read the file to understand context

Run: `read src/shared/memory.ts`

**Step 2:** Add enforceLineCap helper at top of file (after imports, before other functions)

```typescript
export function enforceLineCap(content: string, maxLines = MAX_MEMORY_LINES): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join("\n") + "\n\n[MEMORY.md truncated at 200 lines]";
}
```

**Step 3:** Update readMemoryIndex to use helper

Run: `grep -n "split\(\"\\n\"\)" src/shared/memory.ts`

Find the line where content is split in readMemoryIndex, replace with:

```typescript
const content = enforceLineCap(fileContent);
```

**Step 4:** Run tests

Run: `npm test` (should pass)

**Step 5:** Commit

```bash
git add src/shared/memory.ts
git commit -m "refactor: extract enforceLineCap for reusable line cap enforcement"
```

---

## Task 3: Fix line-cap test assertion

**Files:**
- Modify: `test/unit/memory.test.ts:61`

**Step 1:** Read the test file

Run: `read test/unit/memory.test.ts 55-70`

**Step 2:** Replace confusing assertion

Find line 57:
```typescript
assert.ok(contentLines.length <= 202, `expected <=202 lines (200 + truncation notice), got ${contentLines.length}`);
```

Replace with:
```typescript
assert.equal(contentLines.length, 202, "expected 200 content lines + 2 truncation notice lines");
```

**Step 3:** Run tests

Run: `npm test` (should pass with exact 202-line check)

**Step 4:** Commit

```bash
git add test/unit/memory.test.ts
git commit -m "fix: make line-cap test assertion explicit (<= vs ==)"
```

---

## Task 4: Add Unicode normalization guard

**Files:**
- Modify: `src/shared/memory.ts:18-20` (isUnsafeName function)

**Step 1:** Read the function

Run: `read src/shared/memory.ts 15-30`

**Step 2:** Add path resolution check

Find `isUnsafeName` function, replace the existing checks with:

```typescript
export function isUnsafeName(name: string, cwd: string, memoryDir: string): boolean {
  // Resolve to check path stays within expected root
  const resolved = resolve(memoryDir, name);
  const expectedRoot = resolve(cwd, ".pi", "agent-memory");
  if (!resolved.startsWith(expectedRoot + path.sep)) return true;

  // ASCII safety checks
  if (name === ".." || name === "/" || name === "\\" || name === "\0") return true;
  return false;
}
```

**Step 3:** Update callers to pass cwd and memoryDir

Run: `grep -n "isUnsafeName" src/shared/memory.ts`

Find all calls, add `cwd` and `memoryDir` arguments:
```typescript
isUnsafeName(entry, cwd, memoryDir)
```

**Step 4:** Run tests

Run: `npm test` (should pass)

**Step 5:** Commit

```bash
git add src/shared/memory.ts
git commit -m "fix: add Unicode normalization guard in isUnsafeName via path resolution"
```

---

## Task 5: Add default case to resolveMemoryDir switch

**Files:**
- Modify: `src/shared/memory.ts:27-31`

**Step 1:** Read the switch

Run: `read src/shared/memory.ts 27-35`

**Step 2:** Add default throws

Replace:
```typescript
switch (scope) {
  case "project":
    return join(cwd, ".pi", "agent-memory", agentName);
}
```

With:
```typescript
switch (scope) {
  case "project":
    return join(cwd, ".pi", "agent-memory", agentName);
  default:
    const _exhaustive: never = scope;
    throw new Error(`Unknown memory scope: "${_exhaustive}"`);
}
```

**Step 3:** Run tests

Run: `npm test` (should pass)

**Step 4:** Commit

```bash
git add src/shared/memory.ts
git commit -m "fix: add exhaustive switch default to resolveMemoryDir"
```

---

## Task 6: Remove type-only import for MemoryScope

**Files:**
- Modify: `src/agents/agents.ts:10`

**Step 1:** Read the import

Run: `read src/agents/agents.ts 8-15`

**Step 2:** Change import to non-type

Replace:
```typescript
import type { MemoryScope } from "../shared/memory.ts";
```

With:
```typescript
import { MemoryScope } from "../shared/memory.ts";
```

**Step 3:** Run tests

Run: `npm test` (should pass)

**Step 4:** Commit

```bash
git add src/agents/agents.ts
git commit -m "refactor: remove type-only import for MemoryScope (document as runtime value)"
```

---

## Task 7: Strengthen skill-preload test assertion

**Files:**
- Modify: `test/unit/skill-preload.test.ts`

**Step 1:** Read the test file

Run: `read test/unit/skill-preload.test.ts`

**Step 2:** Find the weak assertion

Search for `total === 1` assertion, find the first test that checks preload

**Step 3:** Make assertion specific

Replace generic `total === 1` with:
```typescript
assert.equal(total, 1, "expected exactly one skill to be resolved");
assert.equal(resolved.length, 1, "expected exactly one resolved skill");
assert.equal(missing.length, 0, "expected no missing skills");
```

**Step 4:** Run tests

Run: `npm test` (should pass and fail if skill loading regresses)

**Step 5:** Commit

```bash
git add test/unit/skill-preload.test.ts
git commit -m "test: strengthen skill-preload assertion to verify resolved vs missing"
```

---

## Final Verification

**Step 1:** Run all tests once more

Run: `npm test -- --reporter verbose`

**Step 2:** Typecheck

Run: `npm run typecheck`

**Step 3:** Format

Run: `npx biome check --write src/ test/`

**Step 4:** Review changes

Run: `git diff --stat`

**Step 5:** Update todo.md

Run: `edit todo.md` to move completed items to "Done" section

**Step 6:** Final commit

```bash
git add -A
git commit -m "chore: complete review TODOs - fix TOCTOU race, add defensive guards, strengthen tests"
```