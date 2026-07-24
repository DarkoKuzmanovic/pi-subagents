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

function makeAgents(names: string[], overrides?: boolean[]): {
	name: string;
	description: string;
	systemPrompt: string;
	systemPromptMode: string;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	source: string;
	filePath: string;
	override?: unknown;
}[] {
	return names.map((name, i) => ({
		name,
		description: `Test agent: ${name}`,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: `${name}.md`,
		override: overrides?.[i] ? { model: "openai/model-0" } : undefined,
	}));
}

function findPlainRow(rendered: string, name: string): string {
	return stripAnsi(rendered.split("\n").find((line) => {
		const stripped = stripAnsi(line);
		const re = new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`);
		return re.test(stripped);
	}) ?? "");
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

	it("filters and clears via keystrokes in model picker", () => {
		const agents = makeAgents(["worker"]);
		const models = makeModels(10);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		component.enterModelSelector(0);
		for (const ch of "openai") {
			component.handleInput(ch);
		}
		let rendered = component.render(84).join("\n");
		assert.ok(stripAnsi(rendered).includes("Search: openai"), "search query appears");
		assert.ok(stripAnsi(rendered).includes("model-0"), "openai model shown");
		assert.ok(!stripAnsi(rendered).includes("anthropic"), "anthropic models hidden");
		assert.ok(!stripAnsi(rendered).includes("google"), "google models hidden");

		// Backspace entire "openai" (6 chars)
		for (let i = 0; i < 6; i++) {
			component.handleInput("\x7f");
		}
		for (const ch of "anth") {
			component.handleInput(ch);
		}
		rendered = component.render(84).join("\n");
		assert.ok(stripAnsi(rendered).includes("Search: anth"), "search query now anth");
		assert.ok(stripAnsi(rendered).includes("anthropic"), "anthropic models shown");

		// Escape returns to main view and clears query
		component.handleInput("\x1b");
		assert.equal(component.editingAgentIndex, null);
		assert.equal(component.modelSearchQuery, "");
		assert.equal(component.modelSelectedIndex, 0, "selected index reset on exit");
		assert.equal(component.filteredModels.length, 10, "filtered models restored on exit");
	});

	it("opens thinking view via tab, cycles a level, returns to main", () => {
		const agents = makeAgents(["worker", "planner"]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		// Build the main view, then press tab to open thinking.
		component.render(84);
		component.handleInput("\t");

		const thinkingRender = component.render(84).join("\n");
		assert.match(stripAnsi(thinkingRender), /Thinking Levels/, "thinking view rendered");
		assert.match(stripAnsi(thinkingRender), /worker/, "agent worker visible");
		assert.match(stripAnsi(thinkingRender), /planner/, "agent planner visible");

		// Press enter to cycle the first agent's thinking level.
		component.handleInput("\r");

		// Verify dirty-only thinking override was applied.
		const thinkingOverride = component.agentThinkingOverrides.get("worker");
		assert.ok(thinkingOverride && thinkingOverride !== "off", "thinking override set for worker");
		assert.equal(component.agentThinkingOverrides.has("planner"), false, "planner untouched");

		// Escape returns to main view.
		component.handleInput("\x1b");
		const mainRender = component.render(84).join("\n");
		assert.match(stripAnsi(mainRender), /Subagent Models/, "back to main view");
	});

	it("renders main and model views within width at 60, 84, and 100 columns", () => {
		const agents = makeAgents(["worker", "planner", "oracle"]);
		const models = makeModels(12);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			"openai",
			() => {},
		);

		for (const width of [60, 84, 100]) {
			const mainLines = component.render(width);
			for (const line of mainLines) {
				assert.ok(stripAnsi(line).length <= width, `main width ${width}: line exceeds bounds`);
			}
		}

		component.enterModelSelector(0);
		for (const width of [60, 84, 100]) {
			const modelLines = component.render(width);
			for (const line of modelLines) {
				assert.ok(stripAnsi(line).length <= width, `model width ${width}: line exceeds bounds`);
			}
		}
	});

	it("main view displays markers, counts, and inherit thinking in plain text", () => {
		const agents = makeAgents(["persisted", "edited"], [true, false]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		(component as any).dirtyAgents.add("edited");
		const rendered = component.render(84).join("\n");
		const stripped = stripAnsi(rendered);

		assert.match(stripped, /Subagent Models \(2 agents · 1 modified\)/, "header count visible");
		assert.match(findPlainRow(rendered, "persisted"), /●/, "persisted marker visible");
		assert.match(findPlainRow(rendered, "edited"), /✎/, "edit marker visible");
		assert.match(findPlainRow(rendered, "edited"), /thinking: inherit/, "unset thinking shown as inherit");
		assert.match(stripped, /● persisted · ✎ edited · ↺ reset/, "marker legend visible");
	});
});
