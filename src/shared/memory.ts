/**
 * memory.ts — Persistent agent memory: per-agent memory directories that persist across sessions.
 *
 * Memory scope:
 *   - "project" → .pi/agent-memory/{agent-name}/
 *
 * Security: symlink rejection, path traversal checks, line cap enforcement.
 */

import { existsSync, lstatSync, readFileSync, openSync, closeSync, constants } from "node:fs";
import { join, resolve, sep } from "node:path";

export type MemoryScope = "project";

const MAX_MEMORY_LINES = 200;

/**
 * Enforce a maximum line count on memory content, with a truncation notice.
 * This is the canonical enforcement point for the line cap.
 */
export function enforceLineCap(content: string, maxLines = MAX_MEMORY_LINES): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) return content;
	return lines.slice(0, maxLines).join("\n") + "\n\n[MEMORY.md truncated at 200 lines]";
}

/** Check if an agent name contains path traversal characters.
 * Also guards against Unicode normalization attacks (e.g. ONE DOT LEADER normalizing to ".." on HFS+/APFS)
 * by resolving the path and verifying it stays within the expected root. */
export function isUnsafeName(name: string, cwd: string): boolean {
	// Resolve to check path stays within expected root
	const expectedRoot = resolve(cwd, ".pi", "agent-memory");
	const resolved = resolve(expectedRoot, name);
	if (!resolved.startsWith(expectedRoot + sep)) return true;

	// Simple ASCII safety checks for the name itself
	if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return true;
	return false;
}

/** Resolve the memory directory path for a given agent + scope + cwd. */
export function resolveMemoryDir(agentName: string, scope: MemoryScope, cwd: string): string {
	if (isUnsafeName(agentName, cwd)) {
		throw new Error(`Unsafe agent name for memory directory: "${agentName}"`);
	}
	switch (scope) {
		case "project":
			return join(cwd, ".pi", "agent-memory", agentName);
		default:
			const _exhaustive: never = scope;
			throw new Error(`Unknown memory scope: "${_exhaustive}"`);
	}
}

/** Read the first N lines of MEMORY.md, if it exists. Returns undefined if missing or symlinked. */
export function readMemoryIndex(memoryDir: string): string | undefined {
	if (!existsSync(memoryDir)) return undefined;
	if (isSymlink(memoryDir)) return undefined;

	const memoryFile = join(memoryDir, "MEMORY.md");

	try {
		const fd = openSync(memoryFile, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const content = readFileSync(fd, "utf-8");
			return enforceLineCap(content);
		} finally {
			closeSync(fd);
		}
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
