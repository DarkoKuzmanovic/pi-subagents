import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import { parseFrontmatter } from "../../src/agents/frontmatter.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

describe("agent serializer round-trip", () => {
	it("preserves disallowedTools and memory through serialize → parseFrontmatter", () => {
		const config: AgentConfig = {
			name: "test-agent",
			description: "Test agent for serialization round-trip",
			tools: ["bash", "write"],
			disallowedTools: ["bash", "write"],
			memory: "project",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
		};

		const serialized = serializeAgent(config);
		const { frontmatter } = parseFrontmatter(serialized);

		// Verify raw frontmatter fields are present
		assert.equal(frontmatter.disallowedTools, "bash, write");
		assert.equal(frontmatter.memory, "project");

		// Verify round-trip: parse frontmatter back to config shape
		const rawDisallowedTools = frontmatter.disallowedTools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		assert.deepEqual(rawDisallowedTools, ["bash", "write"]);

		const memory = frontmatter.memory === "project" ? ("project" as const) : undefined;
		assert.equal(memory, "project");
	});

	it("omits disallowedTools and memory when not set", () => {
		const config: AgentConfig = {
			name: "minimal-agent",
			description: "Minimal agent with no extras",
			tools: [],
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
		};

		const serialized = serializeAgent(config);
		const { frontmatter } = parseFrontmatter(serialized);

		assert.equal(frontmatter.disallowedTools, undefined);
		assert.equal(frontmatter.memory, undefined);
	});

	it("preserves empty disallowedTools as undefined in frontmatter", () => {
		const config: AgentConfig = {
			name: "empty-denylist-agent",
			description: "Agent with empty denylist array",
			tools: ["bash"],
			disallowedTools: [],
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
		};

		const serialized = serializeAgent(config);
		const { frontmatter } = parseFrontmatter(serialized);

		// Empty array should not emit a frontmatter line
		assert.equal(frontmatter.disallowedTools, undefined);
	});
});
