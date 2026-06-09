import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_TOOL_NAME_LENGTH,
	sanitizeRecordToolNames,
	sanitizeSessionJsonl,
	sanitizeToolName,
} from "../../src/shared/tool-name-sanitizer.ts";

describe("sanitizeToolName", () => {
	it("leaves valid tool names unchanged (returns null)", () => {
		assert.equal(sanitizeToolName("subagent"), null);
		assert.equal(sanitizeToolName("context_mode_ctx_execute"), null);
		assert.equal(sanitizeToolName("read"), null);
		assert.equal(sanitizeToolName("codegraph_codegraph_search"), null);
		assert.equal(sanitizeToolName("a.b-c_d"), null);
	});

	it("rewrites names containing characters no real tool name uses", () => {
		const out = sanitizeToolName('subagent({{model: "openai/gpt-4.1"}})<tool_call>');
		assert.notEqual(out, null);
		assert.match(out as string, /^[A-Za-z0-9_.-]+$/);
		assert.ok((out as string).length <= MAX_TOOL_NAME_LENGTH);
	});

	it("truncates over-long names to the provider-safe bound", () => {
		const longName = "a".repeat(500);
		const out = sanitizeToolName(longName);
		assert.notEqual(out, null);
		assert.ok((out as string).length <= MAX_TOOL_NAME_LENGTH);
	});

	it("falls back to a placeholder when nothing valid remains", () => {
		assert.equal(sanitizeToolName("()<>{}"), "invalid_tool_call");
		assert.equal(sanitizeToolName("   "), "invalid_tool_call");
	});

	it("handles the real Anthropic-rejected garbage name from the incident", () => {
		const garbage =
			'subagent</arg_value>agent: gpt-5</arg_key><arg_value>status</arg_value>'.repeat(6);
		const out = sanitizeToolName(garbage);
		assert.notEqual(out, null);
		assert.match(out as string, /^[A-Za-z0-9_.-]+$/);
		assert.ok((out as string).length <= MAX_TOOL_NAME_LENGTH);
	});
});

describe("sanitizeRecordToolNames", () => {
	it("rewrites malformed toolCall names inside an assistant message", () => {
		const record = {
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hi" },
					{ type: "toolCall", id: "x", name: "bad name with spaces", arguments: {} },
				],
			},
		};
		const changed = sanitizeRecordToolNames(record);
		assert.equal(changed, 1);
		assert.equal(record.message.content[1]!.name, "bad_name_with_spaces");
	});

	it("ignores records without a structured content array", () => {
		assert.equal(sanitizeRecordToolNames({ type: "session" }), 0);
		assert.equal(sanitizeRecordToolNames({ message: { role: "user", content: "plain" } }), 0);
		assert.equal(sanitizeRecordToolNames(null), 0);
	});

	it("leaves valid toolCall names untouched", () => {
		const record = {
			message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
		};
		assert.equal(sanitizeRecordToolNames(record), 0);
	});
});

describe("sanitizeSessionJsonl", () => {
	it("rewrites only the malformed lines and preserves the rest verbatim", () => {
		const good = JSON.stringify({ type: "session", id: "abc" });
		const valid = JSON.stringify({
			message: { role: "assistant", content: [{ type: "toolCall", name: "subagent" }] },
		});
		const bad = JSON.stringify({
			message: { role: "assistant", content: [{ type: "toolCall", name: "x".repeat(300) }] },
		});
		const input = `${good}\n${valid}\n${bad}`;
		const { text, changed } = sanitizeSessionJsonl(input);
		assert.equal(changed, 1);
		const outLines = text.split("\n");
		assert.equal(outLines[0], good); // untouched
		assert.equal(outLines[1], valid); // untouched
		const parsed = JSON.parse(outLines[2]!);
		assert.ok(parsed.message.content[0].name.length <= MAX_TOOL_NAME_LENGTH);
	});

	it("preserves non-JSON lines without throwing", () => {
		const input = "not json\n{bad}\n";
		const { text, changed } = sanitizeSessionJsonl(input);
		assert.equal(changed, 0);
		assert.equal(text, input);
	});
});
