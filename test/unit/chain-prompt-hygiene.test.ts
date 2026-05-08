/**
 * Unit tests for chain prompt hygiene — stripping stale XML blocks.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripStaleAgentBlocks } from "../../src/shared/settings.ts";

describe("stripStaleAgentBlocks", () => {
	it("strips <sub_agent_context> blocks", () => {
		const input = "Some output\n<sub_agent_context>stale context here</sub_agent_context>\nMore output";
		const result = stripStaleAgentBlocks(input);
		assert.ok(!result.includes("sub_agent_context"));
		assert.ok(!result.includes("stale context here"));
		assert.ok(result.includes("Some output"));
		assert.ok(result.includes("More output"));
	});

	it("strips <runtime_truth> blocks", () => {
		const input = "Result\n<runtime_truth>old truth data</runtime_truth>\nContinue";
		const result = stripStaleAgentBlocks(input);
		assert.ok(!result.includes("runtime_truth"));
		assert.ok(!result.includes("old truth data"));
		assert.ok(result.includes("Result"));
		assert.ok(result.includes("Continue"));
	});

	it("strips multiple XML blocks", () => {
		const input = "<sub_agent_context>ctx1</sub_agent_context>middle<runtime_truth>truth1</runtime_truth>end";
		const result = stripStaleAgentBlocks(input);
		assert.ok(!result.includes("ctx1"));
		assert.ok(!result.includes("truth1"));
		assert.ok(result.includes("middle"));
		assert.ok(result.includes("end"));
	});

	it("strips multiline XML blocks", () => {
		const input = "before\n<sub_agent_context>\nline 1\nline 2\nline 3\n</sub_agent_context>\nafter";
		const result = stripStaleAgentBlocks(input);
		assert.ok(!result.includes("line 1"));
		assert.ok(result.includes("before"));
		assert.ok(result.includes("after"));
	});

	it("returns original text if it contains no XML blocks", () => {
		const input = "Normal output with no special blocks";
		assert.equal(stripStaleAgentBlocks(input), input);
	});

	it("returns original text for empty/falsy input", () => {
		assert.equal(stripStaleAgentBlocks(""), "");
	});

	it("preserves text when stripping would empty it entirely", () => {
		const input = "<sub_agent_context>everything</sub_agent_context>";
		const result = stripStaleAgentBlocks(input);
		// Should return original since stripping would leave empty string
		assert.equal(result, input);
	});

	it("does not strip unrelated XML tags", () => {
		const input = "<thinking>this should stay</thinking>\n<code>also stays</code>";
		assert.equal(stripStaleAgentBlocks(input), input);
	});
});
