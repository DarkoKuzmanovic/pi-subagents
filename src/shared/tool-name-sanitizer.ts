/**
 * Tool-call name sanitization for forked subagent sessions.
 *
 * Background: when a parent orchestrator model emits a malformed tool call, the
 * entire JSON arguments (or stray `<tool_call>` fragments) can land in the tool
 * *name* field. These records get persisted in the parent transcript. A `fork`
 * subagent replays that transcript verbatim to its own model. Providers with
 * strict validation reject the request — e.g. Anthropic returns:
 *
 *   400 invalid_request_error:
 *   messages.N.content.M.tool_use.name: String should have at most 200 characters
 *
 * which fails the child before it does any work. We own the fork boundary, so we
 * sanitize inherited tool-call names there: names that are over-long or contain
 * characters no real tool name uses are rewritten to a safe, deterministic token.
 *
 * Pure functions live here so they can be unit-tested without touching the
 * filesystem; the in-place file rewrite lives in `fork-context.ts`.
 */

/** Conservative upper bound — comfortably under every provider's tool-name limit. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** Characters real tool names use. Anything else marks the name as malformed. */
const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

const PLACEHOLDER_TOOL_NAME = "invalid_tool_call";

/**
 * Return a sanitized tool name, or `null` if the name is already safe (so callers
 * can cheaply detect "no change"). A safe name matches {@link VALID_TOOL_NAME}
 * and is at most {@link MAX_TOOL_NAME_LENGTH} characters.
 */
export function sanitizeToolName(name: string): string | null {
	if (VALID_TOOL_NAME.test(name) && name.length <= MAX_TOOL_NAME_LENGTH) {
		return null;
	}
	let cleaned = name
		.replace(/[^A-Za-z0-9_.-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[_.-]+|[_.-]+$/g, "");
	if (!cleaned) cleaned = PLACEHOLDER_TOOL_NAME;
	if (cleaned.length > MAX_TOOL_NAME_LENGTH) {
		cleaned = cleaned.slice(0, MAX_TOOL_NAME_LENGTH).replace(/[_.-]+$/g, "");
		if (!cleaned) cleaned = PLACEHOLDER_TOOL_NAME;
	}
	return cleaned;
}

interface MessageRecordLike {
	message?: {
		role?: string;
		content?: unknown;
	};
}

/**
 * Sanitize tool-call names inside one parsed session record (mutates in place).
 * Returns the number of names rewritten. Records that are not assistant messages
 * with a structured content array are left untouched.
 */
export function sanitizeRecordToolNames(record: unknown): number {
	const rec = record as MessageRecordLike;
	const content = rec?.message?.content;
	if (!Array.isArray(content)) return 0;
	let changed = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: string; name?: unknown };
		if (p.type !== "toolCall" || typeof p.name !== "string") continue;
		const sanitized = sanitizeToolName(p.name);
		if (sanitized !== null) {
			p.name = sanitized;
			changed++;
		}
	}
	return changed;
}

/**
 * Sanitize an entire session transcript supplied as JSONL text. Returns the
 * rewritten text plus a count of changed tool-call names. Lines that do not
 * parse as JSON are preserved verbatim so we never corrupt an unexpected format.
 */
export function sanitizeSessionJsonl(jsonl: string): { text: string; changed: number } {
	const lines = jsonl.split("\n");
	let changed = 0;
	const out = lines.map((line) => {
		if (!line.trim()) return line;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			return line; // not JSON — leave as-is
		}
		const n = sanitizeRecordToolNames(record);
		if (n === 0) return line;
		changed += n;
		return JSON.stringify(record);
	});
	return { text: out.join("\n"), changed };
}
