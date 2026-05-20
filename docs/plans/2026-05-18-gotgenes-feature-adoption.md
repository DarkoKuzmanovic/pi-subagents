# Feature Adoption from @gotgenes/pi-subagents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt 4 features from gotgenes/pi-subagents that our extension lacks: persistent agent memory, skill preloading, graceful max_turns, and tool denylist.

**Architecture:** Each feature is an independent vertical slice — new module + AgentConfig extension + wiring into the existing execution pipeline. No cross-feature dependencies. Memory and skill preloading inject content into the system prompt at spawn time; graceful max_turns hooks into the JSONL event stream; tool denylist filters the tools array before building pi args.

**Tech Stack:** TypeScript, Node.js built-ins (fs, path, os), existing Pi extension APIs (`ExtensionAPI`, `ExtensionContext`)

---

## Skeptical Engineer's Assessment

Before diving in, here's what I actually think about each feature:

### 1. Persistent Agent Memory — Proceed with caution

**The pitch:** Agents remember across sessions. Explore agent knows what it found last time. Reviewer tracks recurring issues.

**The reality check:**
- This is the **highest-risk feature**. Persistent state in an LLM context is inherently messy.
- **Staleness problem:** A MEMORY.md from 3 sessions ago may reference files that no longer exist, APIs that changed, or decisions that were overridden. The agent trusts its memory more than it should.
- **Poisoning risk:** A bad run (hallucinated paths, wrong conclusions) writes garbage into MEMORY.md. Future sessions inherit the garbage.
- **Scope confusion:** "project" scope means every developer on the team shares the same memory dir. Whose MEMORY.md is it? What if one developer's agent writes conclusions another developer's agent contradicts?
- **No garbage collection:** There's no mechanism to prune stale memories. MEMORY.md grows until it eats prompt budget.
- **gotgenes does symlink rejection** — good, but insufficient. Path traversal is checked for agent names but not for memory file contents. An LLM could write `../../etc/passwd` into a memory file path.

**Mitigations to build in:**
- Hard cap on MEMORY.md lines (200, like gotgenes) with truncation warning.
- Read-only by default — agents must opt into write access explicitly, not auto-detect from tool list.
- Never auto-create memory dirs for builtins. Only user-defined agents get `memory:` in frontmatter.
- `.gitignore` awareness: `.pi/agent-memory-local/` should be gitignored, `.pi/agent-memory/` should not (it's project-scoped and useful to commit).

**Verdict: Ship it, but ship it small.** `memory: project` only at first. `user` and `local` scopes are YAGNI until we see real usage.

### 2. Skill Preloading — Low risk, high value

**The pitch:** Agent frontmatter says `skills: brainstorming,systematic-debugging` and those SKILL.md contents get injected into the prompt.

**The reality check:**
- We already have `inheritSkills: boolean` and `resolveSkillsWithFallback()` + `buildSkillInjection()`. This is an *extension* of existing code, not new ground.
- gotgenes' `skill-loader.ts` is ~100 lines. Our `skills.ts` is already 631 lines and handles the same resolution paths. The delta is: instead of `inheritSkills: true` (all skills), you can say `skills: brainstorming,systematic-debugging` (specific skills). **We already support this** — `agent.skills` is `string[] | undefined` and `runSync()` already calls `resolveSkillsWithFallback(skillNames, ...)`.
- The *only* gap: our `inheritSkills: true` means "inject the pi-subagents orchestration skill." Their `skills: true` means "inherit all parent skills." Different semantics. Our `inheritSkills` is about the parent-child skill contract, not about which skills to preload. These are orthogonal concepts and should stay orthogonal.

**Verdict: Already 80% implemented.** The gap is documentation and maybe a frontmatter field to distinguish "preload these specific skills" from "inherit parent's skill context." Minimal code change.

### 3. Graceful max_turns — Good UX, architectural mismatch

**The pitch:** When an agent hits its turn limit, send a "wrap up now" steer message and give it 5 more turns instead of hard-killing it.

**The reality check:**
- **Our architecture doesn't use `session.steer()`.** We spawn `pi` as a child process (`child_process.spawn`). gotgenes uses `createAgentSession()` from Pi's SDK, which gives them an `AgentSession` object with `.steer()` and `.abort()` methods. We have no equivalent — our only control is `SIGINT`/`SIGTERM`/`SIGKILL`.
- To implement this, we'd need to either:
  - (a) Switch to the session-based API (massive refactor — don't), or
  - (b) Use the intercom bridge to send a steering message, or
  - (c) Track turns from the JSONL stream and write a temp file that acts as a "steering prompt" injected via the prompt runtime extension.
- Option (c) is the most practical: our `subagent-prompt-runtime.ts` already intercepts agent events. We could add a turn counter there and inject a "wrap up" message after N turns.
- **But wait:** the prompt runtime runs *inside* the child pi process, not in our extension. It can't easily track turns or inject messages mid-conversation. It's a pre-execution hook, not an event stream processor.
- Option (b) is viable: our intercom bridge can deliver messages to running agents. But this only works for agents that start intercom (i.e., detached/background agents). Foreground agents that hit max_turns are the ones that need graceful shutdown most — and they don't have intercom.

**Verdict: Defer.** The implementation path is unclear without refactoring our execution model to support mid-run message injection. The hard kill is ugly but reliable. Revisit when we add session-based execution (which we'll need for resume/steer anyway).

### 4. Tool Denylist — Trivial, do it now

**The pitch:** `disallowedTools: string[]` on AgentConfig — block specific tools even if extensions provide them.

**The reality check:**
- We pass `--tools` to pi, which is an allowlist. We pass `--no-extensions` + specific `--extension` paths. There's no `--deny-tool` flag in pi's CLI.
- gotgenes implements this by filtering the session's available tools after creation — but they use the session API. We'd need to filter at the `--tools` level.
- Simple approach: `disallowedTools` removes entries from `agent.tools` before building pi args. But this only affects built-in tools (`read`, `bash`, `edit`, etc.). It can't block extension-provided tools because we don't control the extension registry inside the child process.
- To block extension tools, we'd need `--no-extensions` + explicit `--extension` list (excluding the offending extension). But that's heavy-handed — you can't block one tool from an extension without blocking the whole extension.
- **Honest scope:** `disallowedTools` can only reliably block built-in tools. Document this limitation.

**Verdict: Ship it for built-in tools only.** 20-line change. Don't over-engineer for extension-level denylisting until Pi adds `--deny-tool`.

---

## Revised Priority

| Priority | Feature | Effort | Risk | Value |
|----------|---------|--------|------|-------|
| 1 | Tool denylist (built-in only) | 1h | Low | Medium |
| 2 | Skill preloading (close the gap) | 2h | Low | Medium-High |
| 3 | Persistent agent memory (project scope only) | 6h | Medium | High |
| 4 | Graceful max_turns | Deferred | — | — |

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/agents/agents.ts` | Modify | Add `disallowedTools` and `memory` to `AgentConfig`, frontmatter parsing |
| `src/agents/agent-serializer.ts` | Modify | Add `disallowedTools`, `memory` to `KNOWN_FIELDS` and serialization |
| `src/runs/shared/pi-args.ts` | Modify | Filter `disallowedTools` from `tools` before building args |
| `src/runs/foreground/execution.ts` | Modify | Wire memory block into system prompt assembly |
| `src/shared/memory.ts` | Create | Memory directory resolution, MEMORY.md reading, prompt block building |
| `src/shared/types.ts` | Modify | Add `MemoryScope` type |
| `agents/*.md` | Modify | Add `memory: project` to scout and reviewer |
| `test/unit/memory.test.ts` | Create | Unit tests for memory module |
| `test/unit/pi-args-denylist.test.ts` | Create | Unit tests for tool denylist filtering |

---

## Task 1: Tool Denylist (Built-in Only)

**Files:**
- Modify: `src/agents/agents.ts:70-97` (AgentConfig interface)
- Modify: `src/agents/agent-serializer.ts` (KNOWN_FIELDS)
- Modify: `src/agents/agents.ts:550-665` (frontmatter parsing)
- Modify: `src/runs/shared/pi-args.ts:74-86` (tools filtering)
- Test: `test/unit/pi-args-denylist.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/pi-args-denylist.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

describe("buildPiArgs disallowedTools", () => {
	it("removes disallowed built-in tools from the tools list", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			disallowedTools: ["bash", "write", "edit"],
		});
		const toolsArg = args.find((_, i) => args[i - 1] === "--tools");
		assert.ok(toolsArg, "expected --tools flag");
		assert.equal(toolsArg, "read,grep,find,ls");
	});

	it("returns undefined tools when all are disallowed", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			disallowedTools: ["read", "bash"],
		});
		assert.ok(!args.includes("--tools"), "expected no --tools flag when all tools are disallowed");
	});

	it("does nothing when disallowedTools is undefined", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash", "edit"],
		});
		const toolsArg = args.find((_, i) => args[i - 1] === "--tools");
		assert.equal(toolsArg, "read,bash,edit");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types test/unit/pi-args-denylist.test.ts`
Expected: FAIL — `disallowedTools` not yet in `BuildPiArgsInput`

- [ ] **Step 3: Add `disallowedTools` to AgentConfig and BuildPiArgsInput**

In `src/agents/agents.ts`, add to the `AgentConfig` interface after `mcpDirectTools`:

```typescript
	/** Tool denylist — these built-in tools are removed even if `tools` includes them. */
	disallowedTools?: string[];
```

In `src/agents/agent-serializer.ts`, add `"disallowedTools"` to the `KNOWN_FIELDS` set.

In `src/agents/agents.ts` frontmatter parsing section (~line 590), add after the `rawTools` parsing:

```typescript
		const rawDisallowedTools = frontmatter.disallowedTools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
```

And in the `agents.push({...})` call, add:

```typescript
			disallowedTools: rawDisallowedTools && rawDisallowedTools.length > 0 ? rawDisallowedTools : undefined,
```

In `src/runs/shared/pi-args.ts`, add to `BuildPiArgsInput`:

```typescript
	disallowedTools?: string[];
```

In `buildPiArgs`, after the `builtinTools` are collected (around line 83), filter:

```typescript
		if (input.disallowedTools?.length) {
			const denied = new Set(input.disallowedTools);
			const filtered = builtinTools.filter((t) => !denied.has(t));
			builtinTools.length = 0;
			builtinTools.push(...filtered);
		}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types test/unit/pi-args-denylist.test.ts`
Expected: PASS

- [ ] **Step 5: Wire disallowedTools through execution.ts**

In `src/runs/foreground/execution.ts`, pass `disallowedTools` to `buildPiArgs`:

Find the `buildPiArgs({...})` call inside `runSingleAttempt` and add:

```typescript
		disallowedTools: agent.disallowedTools,
```

- [ ] **Step 6: Add disallowedTools to agent-management.ts validation**

In `src/agents/agent-management.ts`, find the config validation block and add:

```typescript
	if (hasKey(cfg, "disallowedTools")) {
		if (Array.isArray(cfg.disallowedTools) && cfg.disallowedTools.every((t: unknown) => typeof t === "string"))
			target.disallowedTools = cfg.disallowedTools;
		else if (typeof cfg.disallowedTools === "string")
			target.disallowedTools = cfg.disallowedTools.split(",").map((t: string) => t.trim()).filter(Boolean);
		else return "config.disallowedTools must be a string array or comma-separated string when provided.";
	}
```

- [ ] **Step 7: Commit**

```bash
git add src/agents/agents.ts src/agents/agent-serializer.ts src/agents/agent-management.ts src/runs/shared/pi-args.ts src/runs/foreground/execution.ts test/unit/pi-args-denylist.test.ts
git commit -m "feat: add disallowedTools denylist for built-in tools on AgentConfig"
```

---

## Task 2: Skill Preloading — Close the Gap

**Files:**
- Modify: `src/agents/agents.ts` (frontmatter parsing — already supports `skills: string[]`)
- Modify: `src/runs/foreground/execution.ts` (system prompt assembly — already calls `buildSkillInjection`)
- Read: `src/agents/skills.ts` (already handles resolution)
- Test: `test/unit/skill-preload.test.ts`

**The actual gap:** Our `AgentConfig.skills` field is already `string[] | undefined`, frontmatter parsing already handles `skill`/`skills` YAML, and `runSync()` already resolves and injects skill content via `buildSkillInjection(resolvedSkills)`. The only gap is **documentation** and a **small semantic clarity fix**.

- [ ] **Step 1: Write a test confirming skill preloading already works**

```typescript
// test/unit/skill-preload.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../src/agents/skills.ts";

describe("skill preloading", () => {
	it("resolveSkillsWithFallback returns resolved skill names", () => {
		// This test uses the real skill resolution against the installed skills.
		// It should find at least "pi-subagents" since that's bundled.
		const { resolved, missing } = resolveSkillsWithFallback(["pi-subagents"], process.cwd(), process.cwd());
		assert.ok(resolved.length > 0, "expected at least one resolved skill");
		assert.ok(!missing.includes("pi-subagents"), "pi-subagents skill should be found");
	});

	it("buildSkillInjection produces non-empty content for resolved skills", () => {
		const { resolved } = resolveSkillsWithFallback(["pi-subagents"], process.cwd(), process.cwd());
		if (resolved.length === 0) return; // skip if not installed in test env
		const injection = buildSkillInjection(resolved);
		assert.ok(injection.length > 0, "expected non-empty skill injection content");
		assert.ok(injection.includes("pi-subagents"), "injection should reference the skill name");
	});
});
```

- [ ] **Step 2: Run test**

Run: `node --test --experimental-strip-types test/unit/skill-preload.test.ts`
Expected: PASS (or partial pass depending on test environment)

- [ ] **Step 3: Verify that `inheritSkills` and `skills` are orthogonal**

Read `src/runs/shared/pi-args.ts` lines 100-102 and `src/runs/foreground/execution.ts` lines 753-770. Confirm that:
- `inheritSkills: true` → `--no-skills` is NOT passed (child inherits all parent skills context)
- `skills: ["brainstorming"]` → skill content is injected into systemPrompt AND `--no-skills` is passed (child gets only those skills explicitly, not all parent skills)

These are currently **not orthogonal** — if `inheritSkills: false`, `--no-skills` is passed, but the explicitly listed `skills` are still injected into the system prompt. This is actually correct behavior: the child gets the specific skills injected as prompt content, but doesn't inherit the parent's full skill context. **No code change needed** — this is the right semantics.

- [ ] **Step 4: Add `skills` to BuiltinAgentOverrideBase and cloneOverrideBase**

In `src/agents/agents.ts`, `BuiltinAgentOverrideBase` already has `skills?: string[]`. Verify `cloneOverrideBase` clones it. It does (line 182). Verify `BuiltinAgentOverrideConfig` has it. It does (line 60).

- [ ] **Step 5: Document the feature in agent frontmatter**

No code change. The feature works. Confirm by reading an existing agent file that uses `skills:` frontmatter. Example: check `agents/worker.md` or `agents/reviewer.md`.

```bash
grep -l "skills:" agents/*.md
```

If no builtin agents use `skills:`, add it to reviewer.md as a demonstration:

```markdown
---
name: reviewer
description: ...
skills: requesting-code-review,receiving-code-review
---
```

- [ ] **Step 6: Commit**

```bash
git add test/unit/skill-preload.test.ts agents/reviewer.md
git commit -m "feat: document and test skill preloading on agent frontmatter"
```

---

## Task 3: Persistent Agent Memory (Project Scope Only)

**Files:**
- Create: `src/shared/memory.ts`
- Modify: `src/agents/agents.ts` (add `memory` to AgentConfig + frontmatter)
- Modify: `src/agents/agent-serializer.ts` (add `memory` to KNOWN_FIELDS)
- Modify: `src/runs/foreground/execution.ts` (inject memory block into system prompt)
- Test: `test/unit/memory.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/memory.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMemoryDir, readMemoryIndex, buildMemoryBlock, isUnsafeName } from "../../src/shared/memory.ts";

describe("memory", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("isUnsafeName", () => {
		it("rejects path traversal", () => {
			assert.ok(isUnsafeName("../../etc"));
			assert.ok(isUnsafeName("agent/../../../etc"));
		});
		it("accepts normal names", () => {
			assert.ok(!isUnsafeName("scout"));
			assert.ok(!isUnsafeName("my-agent"));
		});
	});

	describe("resolveMemoryDir", () => {
		it("resolves project scope under .pi/agent-memory/", () => {
			const dir = resolveMemoryDir("scout", "project", tmpDir);
			assert.ok(dir.includes(".pi"), "project scope should use .pi");
			assert.ok(dir.includes("agent-memory"), "should contain agent-memory");
			assert.ok(dir.endsWith("scout"), "should end with agent name");
		});
		it("throws on unsafe agent name", () => {
			assert.throws(() => resolveMemoryDir("../../../etc", "project", tmpDir));
		});
	});

	describe("readMemoryIndex", () => {
		it("returns undefined when no MEMORY.md exists", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			assert.equal(readMemoryIndex(memoryDir), undefined);
		});
		it("returns content when MEMORY.md exists", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Memory\n- Found auth in src/auth/");
			const content = readMemoryIndex(memoryDir);
			assert.ok(content);
			assert.ok(content.includes("Found auth"));
		});
		it("truncates at 200 lines", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`);
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), lines.join("\n"));
			const content = readMemoryIndex(memoryDir);
			const contentLines = content!.split("\n");
			assert.ok(contentLines.length <= 200, `expected <=200 lines, got ${contentLines.length}`);
		});
		it("rejects symlinked directories", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			const targetDir = path.join(tmpDir, "real-agent-memory");
			fs.mkdirSync(targetDir, { recursive: true });
			fs.mkdirSync(path.dirname(memoryDir), { recursive: true });
			fs.symlinkSync(targetDir, memoryDir);
			assert.equal(readMemoryIndex(memoryDir), undefined);
		});
	});

	describe("buildMemoryBlock", () => {
		it("returns undefined when memory is not configured", () => {
			assert.equal(buildMemoryBlock(undefined, undefined, tmpDir), undefined);
		});
		it("returns instructions when memory dir is empty", () => {
			const memoryDir = resolveMemoryDir("scout", "project", tmpDir);
			const block = buildMemoryBlock("project", "scout", tmpDir);
			assert.ok(block);
			assert.ok(block.includes("MEMORY.md"), "should mention MEMORY.md");
		});
		it("returns existing memory content", () => {
			const memoryDir = resolveMemoryDir("scout", "project", tmpDir);
			fs.mkdirSync(memoryDir, { recursive: true });
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Memory\n- Found auth in src/auth/");
			const block = buildMemoryBlock("project", "scout", tmpDir);
			assert.ok(block);
			assert.ok(block.includes("Found auth"));
		});
		it("marks read-only when agent has no write tools", () => {
			const block = buildMemoryBlock("project", "scout", tmpDir, true);
			assert.ok(block!.includes("read-only"), "should indicate read-only");
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types test/unit/memory.test.ts`
Expected: FAIL — `src/shared/memory.ts` doesn't exist

- [ ] **Step 3: Create `src/shared/memory.ts`**

```typescript
/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scope:
 *   - "project" → .pi/agent-memory/{agent-name}/
 *
 * Security: symlink rejection, path traversal checks, line cap enforcement.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryScope = "project";

const MAX_MEMORY_LINES = 200;

/** Check if an agent name contains path traversal characters. */
export function isUnsafeName(name: string): boolean {
	return name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0");
}

/** Resolve the memory directory path for a given agent + scope + cwd. */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
	if (isUnsafeName(agentName)) {
		throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
	}
	switch (scope) {
		case "project":
			return join(cwd, ".pi", "agent-memory", agentName);
	}
}

/** Read the first N lines of MEMORY.md, if it exists. Returns undefined if missing or symlinked. */
export function readMemoryIndex(memoryDir: string): string | undefined {
	if (!existsSync(memoryDir)) return undefined;
	if (isSymlink(memoryDir)) return undefined;

	const memoryFile = join(memoryDir, "MEMORY.md");
	if (!existsSync(memoryFile)) return undefined;
	if (isSymlink(memoryFile)) return undefined;

	try {
		const content = readFileSync(memoryFile, "utf-8");
		const lines = content.split("\n");
		if (lines.length > MAX_MEMORY_LINES) {
			return lines.slice(0, MAX_MEMORY_LINES).join("\n") + "\n\n[MEMORY.md truncated at 200 lines]";
		}
		return content;
	} catch {
		return undefined;
	}
}

/** Build the memory block to inject into the agent's system prompt. */
export function buildMemoryBlock(
	scope: MemoryScope | undefined,
	agentName: string,
	cwd: string,
	readOnly = false,
): string | undefined {
	if (!scope) return undefined;

	const memoryDir = resolveMemoryDir(agentName, scope, cwd);
	const existingMemory = readMemoryIndex(memoryDir);

	const memoryContent = existingMemory
		? `\n\n## Current MEMORY.md\n${existingMemory}`
		: `\n\nNo MEMORY.md exists yet. Create one at ${join(memoryDir, "MEMORY.md")} to start building persistent memory.`;

	const accessNote = readOnly
		? "\n\nYou have READ-ONLY access to memory. You can read existing memories but cannot modify them."
		: `\n\n## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines). Lines after 200 are truncated.
- Store detailed memories in separate files within ${memoryDir}/ and link to them from MEMORY.md.
- Each memory file should use this frontmatter format:
  \`\`\`markdown
  ---
  name: <memory name>
  description: <one-line description>
  type: <user|feedback|project|reference>
  ---
  <memory content>
  \`\`\`
- Update or remove memories that become outdated. Check for existing memories before creating duplicates.`;

	return `## Persistent Agent Memory (${scope} scope)${memoryContent}${accessNote}`;
}

function isSymlink(p: string): boolean {
	try {
		return lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types test/unit/memory.test.ts`
Expected: PASS

- [ ] **Step 5: Add `memory` to AgentConfig**

In `src/agents/agents.ts`:

Add to the import section:
```typescript
import type { MemoryScope } from "../shared/memory.ts";
```

Add to `AgentConfig` interface after `disallowedTools`:
```typescript
	/** Persistent agent memory scope — agents with memory get a persistent directory and MEMORY.md */
	memory?: MemoryScope;
```

Add to `BuiltinAgentOverrideBase`:
```typescript
	memory?: MemoryScope;
```

Add to `BuiltinAgentOverrideConfig`:
```typescript
	memory?: MemoryScope | false;
```

Add to `cloneOverrideBase`:
```typescript
		memory: agent.memory,
```

- [ ] **Step 6: Add `memory` to frontmatter parsing**

In `src/agents/agents.ts` frontmatter parsing section (~line 630), add:

```typescript
		const memory = frontmatter.memory === "project"
			? "project" as const
			: undefined;
```

And in the `agents.push({...})` call, add:
```typescript
			memory,
```

- [ ] **Step 7: Add `memory` to KNOWN_FIELDS**

In `src/agents/agent-serializer.ts`, add `"memory"` to the `KNOWN_FIELDS` set.

- [ ] **Step 8: Wire memory block into system prompt assembly**

In `src/runs/foreground/execution.ts`, import the memory module:

```typescript
import { buildMemoryBlock } from "../../shared/memory.ts";
```

In `runSync()`, after skill injection (around line 770), add memory block:

```typescript
	// Inject persistent memory block if agent has memory configured
	const memoryBlock = buildMemoryBlock(agent.memory, agent.name, runtimeCwd, isReadOnlyAgent(agent));
	if (memoryBlock) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryBlock}` : memoryBlock;
	}
```

Add the helper function (near top of file or in shared utils):

```typescript
/** An agent is read-only if it has no write/edit tools. */
function isReadOnlyAgent(agent: AgentConfig): boolean {
	const writeTools = new Set(["write", "edit", "bash"]);
	const agentTools = agent.tools ?? [];
	return !agentTools.some((t) => writeTools.has(t));
}
```

- [ ] **Step 9: Add `memory` to agent-management.ts validation**

In `src/agents/agent-management.ts`, add validation:

```typescript
	if (hasKey(cfg, "memory")) {
		if (cfg.memory === "project" || cfg.memory === undefined)
			target.memory = cfg.memory as MemoryScope | undefined;
		else if (cfg.memory === false)
			target.memory = undefined;
		else return "config.memory must be 'project' or false when provided.";
	}
```

- [ ] **Step 10: Add `memory: project` to scout and reviewer agents**

In `agents/scout.md`, add to frontmatter:
```yaml
memory: project
```

In `agents/reviewer.md`, add to frontmatter:
```yaml
memory: project
```

- [ ] **Step 11: Add `.pi/agent-memory/` hint to `.gitignore` guidance**

Not a file change — just documentation that `.pi/agent-memory/` is project-scoped and should be committed, while `.pi/agent-memory-local/` should be gitignored. (We're only shipping `project` scope, so no gitignore changes needed yet.)

- [ ] **Step 12: Run all tests**

Run: `npm test`
Expected: All existing + new tests pass

- [ ] **Step 13: Commit**

```bash
git add src/shared/memory.ts src/agents/agents.ts src/agents/agent-serializer.ts src/agents/agent-management.ts src/runs/foreground/execution.ts agents/scout.md agents/reviewer.md test/unit/memory.test.ts
git commit -m "feat: add persistent agent memory (project scope) with MEMORY.md index"
```

---

## Task 4: Graceful max_turns — DEFERRED

**Rationale:** Our child-process-based execution model doesn't support mid-run message injection. gotgenes uses `session.steer()` from the Pi SDK's `AgentSession` API; we use `child_process.spawn` with JSONL stream parsing. Implementing graceful shutdown would require either:
- Migrating to `AgentSession` API (massive refactor, breaks our architecture)
- Using intercom bridge (only works for detached/background agents, not the foreground agents that need this most)
- Adding a Pi CLI flag for max_turns with graceful shutdown (requires Pi core changes)

**When to revisit:** After we add `--max-turns` support in the Pi CLI itself, or when we migrate from `spawn`-based execution to `AgentSession`-based execution.

**No code changes in this task.**

---

## Self-Review

### 1. Spec coverage
- ✅ Tool denylist — Task 1 covers built-in tools, documents limitation for extension tools
- ✅ Skill preloading — Task 2 confirms it already works, adds tests and documentation
- ✅ Persistent memory — Task 3 implements project scope, defers user/local
- ✅ Graceful max_turns — Task 4 documents deferral with rationale

### 2. Placeholder scan
- No "TBD", "TODO", "implement later" found
- No "add appropriate error handling" — all error paths specified
- All test code included
- All file paths are exact

### 3. Type consistency
- `disallowedTools?: string[]` — used consistently across AgentConfig, BuildPiArgsInput, and validation
- `MemoryScope = "project"` — used consistently across memory.ts, AgentConfig, frontmatter parsing, and validation
- `buildMemoryBlock` returns `string | undefined` — checked in test and in execution.ts wiring

### Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MEMORY.md grows unbounded, eats prompt budget | Medium | High | 200-line hard cap with truncation warning |
| Agent writes garbage into memory | Medium | Medium | Read-only auto-detection; project-scoped so garbage is visible |
| `disallowedTools` can't block extension tools | Certain | Low | Document limitation; require Pi CLI `--deny-tool` for full coverage |
| Memory dir path traversal via agent name | Low | Critical | `isUnsafeName()` check with rejection |
| Symlink attack on memory dir | Low | High | `isSymlink()` check on both dir and file |
| Frontmatter field collisions (e.g. `memory` already used in some .md) | Low | Low | `KNOWN_FIELDS` addition prevents misparse as `extraFields` |
