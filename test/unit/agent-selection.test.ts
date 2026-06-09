import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUnknownAgentError, looksLikeModelId, mergeAgentsForScope } from "../../src/agents/agent-selection.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

function makeAgent(name: string, source: "builtin" | "user" | "project", systemPrompt: string): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt,
		source,
		filePath: `/${source}/${name}.md`,
	};
}

describe("mergeAgentsForScope", () => {
	it("returns project agents when scope is project", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("project", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});

	it("returns user agents when scope is user", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("user", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
	});

	it("prefers project agents on name collisions when scope is both", () => {
		const userAgents = [makeAgent("shared", "user", "user prompt")];
		const projectAgents = [makeAgent("shared", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
		assert.equal(result[0]?.systemPrompt, "project prompt");
	});

	it("keeps agents from both scopes when names are distinct", () => {
		const userAgents = [makeAgent("user-only", "user", "user prompt")];
		const projectAgents = [makeAgent("project-only", "project", "project prompt")];
		const result = mergeAgentsForScope("both", userAgents, projectAgents);
		assert.equal(result.length, 2);
		assert.ok(result.find((a) => a.name === "user-only" && a.source === "user"));
		assert.ok(result.find((a) => a.name === "project-only" && a.source === "project"));
	});

	it("includes builtin agents when no user or project override exists", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const result = mergeAgentsForScope("both", [], [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "builtin");
	});

	it("user agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const userAgents = [makeAgent("scout", "user", "custom prompt")];
		const result = mergeAgentsForScope("both", userAgents, [], builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "user");
		assert.equal(result[0]?.systemPrompt, "custom prompt");
	});

	it("project agents override builtins with the same name", () => {
		const builtinAgents = [makeAgent("scout", "builtin", "builtin prompt")];
		const projectAgents = [makeAgent("scout", "project", "project prompt")];
		const result = mergeAgentsForScope("both", [], projectAgents, builtinAgents);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.source, "project");
	});
});

describe("looksLikeModelId", () => {
	it("flags provider/model and aliased model ids", () => {
		assert.equal(looksLikeModelId("openai/gpt-5.5"), true);
		assert.equal(looksLikeModelId("anthropic/claude-opus-4-8"), true);
		assert.equal(looksLikeModelId("opus"), true);
		assert.equal(looksLikeModelId("gpt-5.5"), true);
		assert.equal(looksLikeModelId("claude-opus-4-20250514"), true);
		assert.equal(looksLikeModelId("deepseek-v4-pro"), true);
		assert.equal(looksLikeModelId("worker:high"), true);
	});

	it("does not flag real role names", () => {
		assert.equal(looksLikeModelId("worker"), false);
		assert.equal(looksLikeModelId("planner"), false);
		assert.equal(looksLikeModelId("context-builder"), false);
		assert.equal(looksLikeModelId("reviewer"), false);
		assert.equal(looksLikeModelId("janitor"), false);
	});
});

describe("formatUnknownAgentError", () => {
	const agents = [makeAgent("worker", "builtin", "p"), makeAgent("planner", "builtin", "p")];

	it("always lists the available agents", () => {
		const msg = formatUnknownAgentError("nope", agents);
		assert.match(msg, /Available agents: worker, planner/);
	});

	it("gives a model+role hint when the value looks like a model id", () => {
		const msg = formatUnknownAgentError("openai/gpt-5.5", agents);
		assert.match(msg, /looks like a model id/);
		assert.match(msg, /agent: "worker", model: "openai\/gpt-5\.5"/);
	});

	it("annotates the offending position when provided", () => {
		const msg = formatUnknownAgentError("opus", agents, "task 2");
		assert.match(msg, /\(task 2\)/);
	});
});
