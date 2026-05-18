/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scope:
 *   - "project" → .pi/agent-memory/{agent-name}/
 *
 * Security: symlink rejection, path traversal checks, line cap enforcement.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
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
