import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBuiltinOverrideConfig, discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";
import { handleList } from "../../src/agents/agent-management.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function readText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	assert.ok(first);
	assert.equal(first.type, "text");
	assert.equal(typeof first.text, "string");
	return first.text;
}

describe("builtin agent disabling", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-disabled-project-"));
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

	it("filters a per-agent disabled builtin from runtime discovery while keeping it in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: true },
				},
			},
		});

		const runtimeReviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(runtimeReviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "user");
	});

	it("surfaces malformed disabled overrides instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				agentOverrides: {
					reviewer: { disabled: "true" },
				},
			},
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("reviewer")
				&& error.message.includes("disabled"),
		);
	});

	it("bulk disableBuiltins hides builtins at runtime and marks them disabled in discoverAgentsAll", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const runtimeBuiltinCount = discoverAgents(tempProject, "both").agents.filter((agent) => agent.source === "builtin").length;
		assert.equal(runtimeBuiltinCount, 0);

		const allBuiltins = discoverAgentsAll(tempProject).builtin;
		assert.ok(allBuiltins.length > 0);
		assert.ok(allBuiltins.every((agent) => agent.disabled === true));
		assert.ok(allBuiltins.every((agent) => agent.override?.scope === "user"));
	});

	it("an explicit user override opts a builtin out of user-scope bulk disable", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { model: "openai/gpt-5.4" },
				},
			},
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.disabled, undefined);
		assert.equal(reviewer.model, "openai/gpt-5.4");
		assert.equal(reviewer.override?.scope, "user");
	});

	it("project disableBuiltins false re-enables builtins hidden by user bulk disable", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: false },
		});

		assert.ok(discoverAgents(tempProject, "both").agents.some((agent) => agent.source === "builtin"));
	});

	it("project bulk disable beats user per-agent re-enable overrides", () => {
		fs.mkdirSync(path.join(tempProject, ".pi"), { recursive: true });
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: {
				disableBuiltins: true,
				agentOverrides: {
					reviewer: { disabled: false, model: "openai/gpt-5.4" },
				},
			},
		});
		writeJson(path.join(tempProject, ".pi", "settings.json"), {
			subagents: { disableBuiltins: true },
		});

		const reviewer = discoverAgents(tempProject, "both").agents.find((agent) => agent.name === "reviewer");
		assert.equal(reviewer, undefined);

		const allReviewer = discoverAgentsAll(tempProject).builtin.find((agent) => agent.name === "reviewer");
		assert.ok(allReviewer);
		assert.equal(allReviewer.disabled, true);
		assert.equal(allReviewer.override?.scope, "project");
	});

	it("surfaces malformed disableBuiltins values instead of silently ignoring them", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: { disableBuiltins: "true" },
		});

		assert.throws(
			() => discoverAgents(tempProject, "both"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("disableBuiltins"),
		);
	});

	it("hides disabled builtins from agent-facing management list output", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { disableBuiltins: true },
		});
		const agentsDir = path.join(tempProject, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentsDir, "helper.md"),
			"---\nname: helper\ndescription: Helper\n---\n\nHelp.\n",
			"utf-8",
		);
		const disabledBuiltinNames = discoverAgentsAll(tempProject).builtin.map((agent) => agent.name);
		assert.ok(disabledBuiltinNames.length > 0);

		const text = readText(handleList(
			{},
			{ cwd: tempProject, modelRegistry: { getAvailable: () => [] } },
		));

		assert.match(text, /Executable agents:\n- helper \(project\): Helper/);
		assert.doesNotMatch(text, /Disabled builtins:/);
		for (const name of disabledBuiltinNames) {
			assert.doesNotMatch(text, new RegExp(`^- ${name} \\(builtin`, "m"));
		}
	});

	it("buildBuiltinOverrideConfig emits disabled false when re-enabling a builtin", () => {
		const override = buildBuiltinOverrideConfig(
			{
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: undefined,
				systemPrompt: "Base prompt",
			},
			{
				model: undefined,
				fallbackModels: undefined,
				thinking: undefined,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				disabled: false,
				systemPrompt: "Base prompt",
				skills: undefined,
				tools: undefined,
				mcpDirectTools: undefined,
			},
		);

		assert.deepEqual(override, { disabled: false });
	});
});

describe("M1 six-role builtin roster", () => {
	const DURABLE_SIX = ["context-builder", "janitor", "oracle", "planner", "reviewer", "worker"];
	const DISABLED_COMPAT = ["deslopper", "oracle-fresh", "researcher", "scout", "synthesizer", "test-writer", "worker-heavy", "worker-light"];

	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-roster-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-roster-project-"));
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

	it("exposes exactly the six durable roles in discoverAgents default (no settings)", () => {
		const { agents } = discoverAgents(tempProject, "both");
		const builtinNames = agents.filter((a) => a.source === "builtin").map((a) => a.name).sort();
		assert.deepEqual(builtinNames, DURABLE_SIX);
	});

	it("hides all eight compat agents from discoverAgents by default", () => {
		const { agents } = discoverAgents(tempProject, "both");
		const builtinNames = new Set(agents.filter((a) => a.source === "builtin").map((a) => a.name));
		for (const name of DISABLED_COMPAT) {
			assert.equal(builtinNames.has(name), false, `${name} should be hidden by default`);
		}
	});

	it("surfaces all disabled compat agents in discoverAgentsAll.builtin", () => {
		const { builtin } = discoverAgentsAll(tempProject);
		const disabledNames = builtin.filter((a) => a.disabled === true).map((a) => a.name).sort();
		assert.deepEqual(disabledNames, DISABLED_COMPAT.slice().sort());
	});

	it("reports only the six durable roles as executable in list output", () => {
		const result = handleList(
			{},
			{ cwd: tempProject, modelRegistry: { getAvailable: () => [] } },
		);
		const text = result.content[0]?.text ?? "";
		for (const name of DURABLE_SIX) {
			assert.match(text, new RegExp(`- ${name} \\(builtin`), `${name} should appear in list`);
		}
		for (const name of DISABLED_COMPAT) {
			assert.doesNotMatch(text, new RegExp(`- ${name} \\(builtin`), `${name} should not appear in list`);
		}
	});

	it("re-enabling a compat agent via user agentOverrides restores it to discoverAgents", () => {
		writeJson(path.join(tempHome, ".pi", "agent", "settings.json"), {
			subagents: { agentOverrides: { scout: { disabled: false } } },
		});
		const { agents } = discoverAgents(tempProject, "both");
		const scout = agents.find((a) => a.name === "scout");
		assert.ok(scout, "scout should be re-enabled");
		assert.equal(scout.disabled, false);
	});
});
