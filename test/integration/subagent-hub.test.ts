import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tryImport } from "../support/helpers.ts";

const hubMod = await tryImport<{
	SubagentHubComponent: new (...args: unknown[]) => any;
}>("./src/tui/subagent-hub.ts");
const available = !!hubMod;
const SubagentHubComponent = hubMod?.SubagentHubComponent;

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching the ESC control char
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeTheme() {
	return {
		fg(_key: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
}

function makeModels(count: number): { provider: string; id: string; fullId: string }[] {
	const providers = ["openai", "anthropic", "google"];
	const models: { provider: string; id: string; fullId: string }[] = [];
	for (let i = 0; i < count; i++) {
		const provider = providers[i % providers.length]!;
		const id = `model-${i}`;
		models.push({ provider, id, fullId: `${provider}/${id}` });
	}
	return models;
}

function makeAgents(names: string[]): {
	name: string;
	description: string;
	systemPrompt: string;
	systemPromptMode: string;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	source: string;
	filePath: string;
}[] {
	return names.map((name) => ({
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: `${name}.md`,
	}));
}

describe("subagent hub", {
	skip: !available ? "subagent-hub.ts not importable" : undefined,
}, () => {
	it("renders agent list with models", () => {
		const agents = makeAgents(["worker", "planner", "oracle"]);
		const models = makeModels(5);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			"openai",
			() => {},
			"/tmp/test-cwd",
		);

		const rendered = component.render(84).join("\n");
		const stripped = stripAnsi(rendered);

		assert.match(stripped, /worker/);
		assert.match(stripped, /planner/);
		assert.match(stripped, /oracle/);
		assert.match(stripped, /\(host default\)/);
		assert.match(stripped, /Subagent Models/);
		assert.match(stripped, /enter model/);
	});

	it("enter and exit model selector via direct methods", () => {
		const agents = makeAgents(["worker"]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
			"/tmp/test-cwd",
		);

		assert.equal(component.editingAgentIndex, null);

		component.enterModelSelector(0);
		assert.equal(component.editingAgentIndex, 0);

		const modelSelectorRender = component.render(84).join("\n");
		assert.match(stripAnsi(modelSelectorRender), /Select Model/);
		assert.match(stripAnsi(modelSelectorRender), /Search:/);
		assert.match(stripAnsi(modelSelectorRender), /model-0/);

		component.exitModelSelector();
		assert.equal(component.editingAgentIndex, null);

		const mainRender = component.render(84).join("\n");
		assert.match(stripAnsi(mainRender), /Subagent Models/);
	});

	it("select model via direct state manipulation", () => {
		const agents = makeAgents(["worker"]);
		const models = makeModels(5);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
			"/tmp/test-cwd",
		);

		component.enterModelSelector(0);
		component.modelSearchQuery = "model-3";
		component.filterModels();

		const filtered = component.filteredModels;
		const found = filtered.some((m: any) => m.fullId === "openai/model-3");
		assert.ok(found, "filteredModels should contain openai/model-3");

		const idx = filtered.findIndex((m: any) => m.fullId === "openai/model-3");
		if (idx >= 0) component.modelSelectedIndex = idx;

		const selected = component.filteredModels[component.modelSelectedIndex];
		if (selected) {
			component.agentModelOverrides.set("worker", selected.fullId);
		}
		component.exitModelSelector();

		assert.equal(
			component.agentModelOverrides.get("worker"),
			"openai/model-3",
		);
	});

	it("renders model override indicator in main view", () => {
		const agents = makeAgents(["worker"]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
			"/tmp/test-cwd",
		);

		// Drive a real edit path so the agent becomes dirty and shows ✎
		component.cycleThinkingLevel();

		const rendered = component.render(84).join("\n");
		assert.match(rendered, /✎/);
	});

	it("search filters models in model picker", () => {
		const agents = makeAgents(["worker"]);
		const models = makeModels(10);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
			"/tmp/test-cwd",
		);

		component.enterModelSelector(0);
		const beforeFilter = component.render(84).join("\n");
		assert.match(stripAnsi(beforeFilter), /model-0/);
		assert.match(stripAnsi(beforeFilter), /model-1/);
		assert.match(stripAnsi(beforeFilter), /model-2/);
		assert.match(stripAnsi(beforeFilter), /openai/);
		assert.match(stripAnsi(beforeFilter), /anthropic/);
		assert.match(stripAnsi(beforeFilter), /google/);

		component.modelSearchQuery = "openai";
		component.filterModels();

		const afterFilter = component.render(84).join("\n");
		assert.match(stripAnsi(afterFilter), /model-0/);
		assert.match(stripAnsi(afterFilter), /openai/);
		assert.doesNotMatch(stripAnsi(afterFilter), /anthropic/);
		assert.doesNotMatch(stripAnsi(afterFilter), /google/);
	});
});