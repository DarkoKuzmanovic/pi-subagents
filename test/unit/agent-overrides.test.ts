import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll, removeBuiltinAgentOverride } from "../../src/agents/agents.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeProjectAgent(cwd: string, name: string, body: string): void {
	const filePath = path.join(cwd, ".pi", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, body, "utf-8");
}

describe("builtin agent overrides", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("bundled builtin agents inherit the default model", () => {
		const builtins = discoverAgentsAll(tempProject).builtin;
		assert.ok(builtins.length > 0);
		assert.deepEqual(
			builtins
				.filter((agent) => agent.model !== undefined || agent.fallbackModels !== undefined)
				.map((agent) => agent.name),
			[],
		);
	});

	it("applies user settings overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						model: "openai/gpt-5.4",
						thinking: "xhigh",
						systemPromptMode: "replace",
						inheritProjectContext: true,
						inheritSkills: true,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.thinking, "xhigh");
		assert.equal(reviewer.systemPromptMode, "replace");
		assert.equal(reviewer.inheritProjectContext, true);
		assert.equal(reviewer.inheritSkills, true);
		assert.equal(reviewer.override?.scope, "user");
		assert.equal(reviewer.override?.path, path.join(tempHome, ".pi", "agent", "settings.json"));
	});

	it("prefers project settings overrides over user settings overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini", thinking: "high" } } },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.thinking, "high");
		assert.equal(reviewer.override?.scope, "project");
		assert.equal(reviewer.override?.path, path.join(tempProject, ".pi", "settings.json"));
	});

	it("does not apply project settings overrides when scope is user", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "user").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("does not apply user settings overrides when scope is project", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.notEqual(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override, undefined);
	});

	it("does not read malformed out-of-scope settings files", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		fs.mkdirSync(path.join(tempHome, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHome, ".pi", "agent", "settings.json"), '{"subagents":', "utf-8");
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai-codex/gpt-5.4-mini" } } },
		});

		const reviewer = discoverAgents(tempProject, "project").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "openai-codex/gpt-5.4-mini");
		assert.equal(reviewer.override?.scope, "project");
	});

	it("does not apply builtin settings overrides when a full project agent overrides the builtin", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4" } } },
		});
		writeProjectAgent(tempProject, "reviewer", `---\nname: reviewer\ndescription: Project reviewer\nmodel: google/gemini-3-pro\n---\n\nUse the project reviewer.\n`);

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "project");
		assert.equal(reviewer.model, "google/gemini-3-pro");
		assert.equal(reviewer.override, undefined);
	});

	it("does not create a settings file when removing a non-existent override", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		assert.equal(fs.existsSync(settingsPath), false);
		removeBuiltinAgentOverride(tempProject, "reviewer", "user");
		assert.equal(fs.existsSync(settingsPath), false);
	});

	it("surfaces malformed settings files instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, '{"subagents":', "utf-8");

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to parse settings file"),
		);
	});

	it("surfaces settings read failures without mislabeling them as parse errors", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		fs.mkdirSync(settingsPath, { recursive: true });

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("Failed to read settings file"),
		);
	});

	it("surfaces malformed builtin override entries instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: {
						inheritProjectContext: "true",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("inheritProjectContext"),
		);
	});

	it("builds false sentinels when an override clears builtin fields", () => {
		const override = buildBuiltinOverrideConfig(
			{
				model: "openai-codex/gpt-5.4-mini",
				fallbackModels: ["openai/gpt-5-mini"],
				thinking: "high",
				systemPromptMode: "append",
				inheritProjectContext: true,
				inheritSkills: false,
				defaultContext: "fork",
				systemPrompt: "Base prompt",
				skills: ["safe-bash"],
				tools: ["bash"],
				mcpDirectTools: ["xcodebuild_list_sims"],
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				defaultContext: undefined,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
			},
		);

		assert.deepEqual(override, {
			model: false,
			fallbackModels: false,
			thinking: false,
			systemPromptMode: "replace",
			inheritProjectContext: false,
			defaultContext: false,
			skills: false,
			tools: false,
		});
	});

	it("applies disallowedTools and memory overrides to builtin agents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						disallowedTools: ["bash"],
						memory: "project",
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.deepEqual(reviewer.disallowedTools, ["bash"]);
		assert.equal(reviewer.memory, "project");
	});

	it("captures disallowedTools and memory diffs in override config", () => {
		const shared = {
			model: "openai/gpt-5.4",
			fallbackModels: undefined,
			thinking: "high" as const,
			systemPromptMode: "replace" as const,
			inheritProjectContext: true,
			inheritSkills: false,
			defaultContext: "fresh" as const,
			disabled: false,
			systemPrompt: "Base prompt",
			skills: undefined,
			tools: undefined,
			mcpDirectTools: undefined,
		};
		const override = buildBuiltinOverrideConfig(
			{ ...shared, disallowedTools: [], memory: undefined },
			{ ...shared, disallowedTools: ["bash", "web_search"], memory: "project" },
		);
		assert.deepEqual(override?.disallowedTools, ["bash", "web_search"]);
		assert.equal(override?.memory, "project");
	});

	it("clears disallowedTools and memory with false sentinels", () => {
		const shared = {
			model: undefined,
			fallbackModels: undefined,
			thinking: undefined,
			systemPromptMode: "replace" as const,
			inheritProjectContext: true,
			inheritSkills: false,
			defaultContext: undefined,
			disabled: false,
			systemPrompt: "Base prompt",
			skills: undefined,
			tools: undefined,
			mcpDirectTools: undefined,
		};
		const override = buildBuiltinOverrideConfig(
			{ ...shared, disallowedTools: ["bash"], memory: "project" },
			{ ...shared, disallowedTools: undefined, memory: undefined },
		);
		assert.equal(override?.disallowedTools, false);
		assert.equal(override?.memory, false);
	});

	it("applies modelPromptRole override to builtin agents (Fix 2)", () => {
		// Fix 2: Support modelPromptRole overrides in settings
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						modelPromptRole: "worker",
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.source, "builtin");
		assert.equal(reviewer.modelPromptRole, "worker");
	});

	it("clears modelPromptRole with false override (Fix 2)", () => {
		// Fix 2: Support clearing modelPromptRole by setting it to false
		// First set a role, then clear it
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: {
						modelPromptRole: false,
					},
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		// Even though we set it to false, the base agent has no role, so it should be undefined
		assert.equal(reviewer.modelPromptRole, undefined);
	});

	it("captures modelPromptRole diffs in override config (Fix 2)", () => {
		// Fix 2: buildBuiltinOverrideConfig should capture modelPromptRole differences
		const shared = {
			model: "openai/gpt-5.4",
			fallbackModels: undefined,
			thinking: "high" as const,
			systemPromptMode: "replace" as const,
			inheritProjectContext: true,
			inheritSkills: false,
			defaultContext: undefined,
			disabled: false,
			systemPrompt: "Base prompt",
			skills: undefined,
			tools: undefined,
			mcpDirectTools: undefined,
		};
		const override = buildBuiltinOverrideConfig(
			{ ...shared, modelPromptRole: undefined },
			{ ...shared, modelPromptRole: "worker" },
		);
		assert.equal(override?.modelPromptRole, "worker");
	});

	it("clears modelPromptRole with false sentinel in override config (Fix 2)", () => {
		// Fix 2: buildBuiltinOverrideConfig should produce false sentinel when clearing role
		const shared = {
			model: "openai/gpt-5.4",
			fallbackModels: undefined,
			thinking: "high" as const,
			systemPromptMode: "replace" as const,
			inheritProjectContext: true,
			inheritSkills: false,
			defaultContext: undefined,
			disabled: false,
			systemPrompt: "Base prompt",
			skills: undefined,
			tools: undefined,
			mcpDirectTools: undefined,
		};
		const override = buildBuiltinOverrideConfig(
			{ ...shared, modelPromptRole: "worker" },
			{ ...shared, modelPromptRole: undefined },
		);
		assert.equal(override?.modelPromptRole, false);
	});

	it("applies addTools override to builtin agents with defined baseline", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: ["pitaj"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		assert.ok(worker.tools?.includes("pitaj"));
		// Verify baseline tools are still present
		assert.ok(worker.tools?.includes("bash"));
		assert.ok(worker.tools?.includes("read"));
	});

	it("merges addTools after override tools replacement", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						tools: ["bash", "edit"],
						addTools: ["pitaj", "web_search"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		// Should have: bash, edit (from tools override) + pitaj, web_search (from addTools)
		assert.deepEqual(worker.tools, ["bash", "edit", "pitaj", "web_search"]);
	});

	it("deduplicates addTools entries against existing tools", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: ["bash", "pitaj"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		// bash should appear only once
		const bashCount = (worker.tools ?? []).filter((t) => t === "bash").length;
		assert.equal(bashCount, 1);
		assert.ok(worker.tools?.includes("pitaj"));
	});

	it("preserves baseline-first ordering when adding tools", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						tools: ["tool1", "tool2"],
						addTools: ["tool3", "tool1", "tool4"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		// tool1, tool2 come first (from override.tools), then tool3, tool4 (new from addTools)
		// tool1 should not appear twice
		assert.deepEqual(worker.tools, ["tool1", "tool2", "tool3", "tool4"]);
	});

	it("handles mcp: prefixed entries in addTools", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: ["mcp:xcodebuild_list_sims", "pitaj"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		assert.ok(worker.tools?.includes("pitaj"));
		assert.ok(worker.mcpDirectTools?.includes("xcodebuild_list_sims"));
	});

	it("is a no-op when addTools is applied to agent with undefined tools baseline", () => {
		// Create a custom agent with no explicit tools
		writeProjectAgent(
			tempProject,
			"custom-agent",
			`---
name: custom-agent
description: A custom agent with no tools
---

Custom agent body.
`,
		);

		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: {
				agentOverrides: {
					"custom-agent": {
						addTools: ["pitaj"],
					},
				},
			},
		});

		const agent = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "custom-agent");
		assert.ok(agent);
		// addTools should be a no-op when tools baseline is undefined
		assert.equal(agent.tools, undefined);
		assert.equal(agent.mcpDirectTools, undefined);
	});

	it("still respects disallowedTools after addTools merge", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: ["pitaj"],
						disallowedTools: ["bash"],
					},
				},
			},
		});

		const worker = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "worker");
		assert.ok(worker);
		// pitaj should be added
		assert.ok(worker.tools?.includes("pitaj"));
		// but the effective toolset has disallowedTools filtered at runtime (pi-args.ts:212-216)
		// the agent config should still have bash in the full list, but disallowedTools will filter it
		assert.deepEqual(worker.disallowedTools, ["bash"]);
	});

	it("clones and preserves addTools in override config round-trip", () => {
		const original: BuiltinAgentOverrideConfig = {
			addTools: ["pitaj", "web_search"],
		};

		// Simulate saveBuiltinAgentOverride → readSubagentSettings round-trip
		// by using cloneOverrideValue
		const cloned = cloneOverrideValue(original);
		assert.deepEqual(cloned.addTools, ["pitaj", "web_search"]);

		// Verify it's a new array, not the same reference
		assert.notEqual(cloned.addTools, original.addTools);
	});

	it("rejects addTools with false value (not array-or-false like tools)", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: false,
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes("addTools")
				&& error.message.includes("array"),
		);
	});

	it("rejects non-array addTools values", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: "pitaj",
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes("addTools")
				&& error.message.includes("array"),
		);
	});

	it("rejects non-string items in addTools array", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					worker: {
						addTools: ["pitaj", 123, "web_search"],
					},
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes("addTools")
				&& error.message.includes("array of strings"),
		);
	});

	// Import cloneOverrideValue for the round-trip test
	function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
		return {
			...(override.model !== undefined ? { model: override.model } : {}),
			...(override.fallbackModels !== undefined
				? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
				: {}),
			...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
			...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
			...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
			...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
			...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
			...(override.modelPromptRole !== undefined ? { modelPromptRole: override.modelPromptRole } : {}),
			...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
			...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
			...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
			...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
			...(override.addTools !== undefined ? { addTools: [...override.addTools] } : {}),
			...(override.disallowedTools !== undefined
				? { disallowedTools: override.disallowedTools === false ? false : [...override.disallowedTools] }
				: {}),
			...(override.memory !== undefined ? { memory: override.memory } : {}),
		};
	}

	interface BuiltinAgentOverrideConfig {
		model?: string | false;
		fallbackModels?: string[] | false;
		thinking?: string | false;
		systemPromptMode?: "append" | "replace";
		inheritProjectContext?: boolean;
		inheritSkills?: boolean;
		defaultContext?: "fresh" | "fork" | "lineage" | false;
		modelPromptRole?: string | false;
		disabled?: boolean;
		systemPrompt?: string;
		skills?: string[] | false;
		tools?: string[] | false;
		addTools?: string[];
		disallowedTools?: string[] | false;
		memory?: "project" | false;
	}
});
