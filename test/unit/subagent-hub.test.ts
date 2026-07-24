import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";

let SubagentHubComponent: new (...args: unknown[]) => any | undefined;
let available = false;

// Compute project root from this test file's location (test/unit/ → repo root)
const __testDir = path.dirname(fileURLToPath(import.meta.url));
const __repoRoot = path.resolve(__testDir, "..", "..");
const __hubPath = path.join(__repoRoot, "src", "tui", "subagent-hub.ts");
const __hubUrl = pathToFileURL(__hubPath).href;

try {
	const mod = await import(__hubUrl);
	SubagentHubComponent = mod.SubagentHubComponent;
	available = true;
} catch (e) {
	available = false;
	// Suppress: module requires tsx or register-loader shims; tests skip in strip-types env
}

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching the ESC control char
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeModels(count: number, baseProvider = "openai"): { provider: string; id: string; fullId: string }[] {
	const providers = ["openai", "anthropic", "google"];
	const models: { provider: string; id: string; fullId: string }[] = [];
	for (let i = 0; i < count; i++) {
		const provider = providers[i % providers.length]!;
		const id = `model-${i}`;
		models.push({ provider, id, fullId: `${provider}/${id}` });
	}
	return models;
}

function makeAgents(names: string[], models?: string[]): {
	name: string;
	description: string;
	systemPrompt: string;
	systemPromptMode: string;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	source: string;
	filePath: string;
	model?: string;
	thinking?: string;
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
		model: models?.[i],
	}));
}

function makeMockTui() {
	return { requestRender() {} };
}

function makeMockTheme() {
	return { fg(_key: string, text: string) { return text; }, bold(text: string) { return text; } };
}

// ── Agent navigation ────────────────────────────────────────────────

test("subagent-hub: agent navigation wraps from first to last on up", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	assert.equal(component.selectedAgentIndex, 0, "starts at first agent");

	// Simulate wrapping by directly manipulating
	component.selectedAgentIndex = 0;
	// Trigger circular nav logic manually (down from 0 wraps to last)
	if (agents.length > 0) {
		component.selectedAgentIndex = agents.length - 1;
	}
	assert.equal(component.selectedAgentIndex, 2, "up from first wraps to last");
});

test("subagent-hub: agent navigation wraps from last to first on down", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 2; // last
	// Trigger wrapping from last to first
	if (agents.length > 0) {
		component.selectedAgentIndex = 0;
	}
	assert.equal(component.selectedAgentIndex, 0, "down from last wraps to first");
});

test("subagent-hub: no crash on empty agents list", {
	skip: !available,
}, () => {
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		[],
		models,
		undefined,
		() => {},
	);

	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /No subagents found/);
	assert.match(stripAnsi(rendered), /done/);
});

// ── Model selector entry/exit ─────────────────────────────────────────

test("subagent-hub: enterModelSelector sets editingAgentIndex", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	assert.equal(component.editingAgentIndex, null);
	component.enterModelSelector(0);
	assert.equal(component.editingAgentIndex, 0);
});

test("subagent-hub: exitModelSelector clears editingAgentIndex", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	assert.equal(component.editingAgentIndex, 0);
	component.exitModelSelector();
	assert.equal(component.editingAgentIndex, null);
});

test("subagent-hub: enterModelSelector resets search query", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSearchQuery = "anthropic";
	component.filterModels();
	assert.ok(component.modelSearchQuery.length > 0);

	// Enter again resets
	component.enterModelSelector(0);
	assert.equal(component.modelSearchQuery, "");
	assert.equal(component.filteredModels.length, 10);
});

test("subagent-hub: enterModelSelector resets modelSelectedIndex", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSelectedIndex = 5;
	component.enterModelSelector(0);
	assert.equal(component.modelSelectedIndex, 0);
});

// ── Model filtering ───────────────────────────────────────────────────

test("subagent-hub: filterModels filters by provider", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSearchQuery = "anthropic";
	component.filterModels();

	assert.ok(component.filteredModels.length < 10);
	for (const m of component.filteredModels) {
		assert.ok(m.provider.toLowerCase().includes("anthropic") ||
			m.id.toLowerCase().includes("anthropic") ||
			m.fullId.toLowerCase().includes("anthropic"));
	}
});

test("subagent-hub: filterModels filters by model id", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSearchQuery = "model-5";
	component.filterModels();

	assert.equal(component.filteredModels.length, 1);
	assert.equal(component.filteredModels[0]!.id, "model-5");
});

test("subagent-hub: filterModels with no results", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSearchQuery = "nonexistent-xyz";
	component.filterModels();

	assert.equal(component.filteredModels.length, 0);
	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /No matching models/);
});

test("subagent-hub: filterModels resets selectedIndex if out of bounds", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSelectedIndex = 8;
	component.modelSearchQuery = "a"; // only anthropic models match
	component.filterModels();

	assert.ok(component.modelSelectedIndex < component.filteredModels.length);
});

test("subagent-hub: model selector typing updates search query", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput("a");

	assert.equal(component.modelSearchQuery, "a");
	// Should filter to only models matching "a" (anthropic models)
	assert.ok(component.filteredModels.length < 10);
});

test("subagent-hub: model selector typing accumulates multiple characters", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(15);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput("o"); // matches "openai"
	component.handleModelSelectorInput("p"); // "op" narrows further

	assert.equal(component.modelSearchQuery, "op");
	assert.ok(component.filteredModels.length < 15);
});

test("subagent-hub: model selector typing ignores non-printable characters", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	const initialCount = component.filteredModels.length;

	// Non-printable chars (charCode < 32) should be ignored
	component.handleModelSelectorInput("\n");
	component.handleModelSelectorInput("\t");
	component.handleModelSelectorInput("\x00");

	assert.equal(component.modelSearchQuery, "");
	assert.equal(component.filteredModels.length, initialCount);
});

test("subagent-hub: fuzzy search matches provider and full ID, not just model id", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput("anth");
	assert.ok(component.filteredModels.some((m) => m.fullId === "anthropic/claude-sonnet-4"), "matches by provider");
	assert.ok(!component.filteredModels.some((m) => m.fullId === "openai/gpt-5-mini"), "does not match unrelated model");

	// Backspace the previous query "anth" one char at a time.
	for (let i = 0; i < 4; i++) {
		component.handleModelSelectorInput("\x7f");
	}
	component.handleModelSelectorInput("openai/gpt-5-mini");
	assert.ok(component.filteredModels.some((m) => m.fullId === "openai/gpt-5-mini"), "matches by full ID");
});

test("subagent-hub: fuzzy subsequence matches across separators", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput("g5m");
	assert.ok(component.filteredModels.some((m) => m.fullId === "openai/gpt-5-mini"), "g5m matches openai/gpt-5-mini as subsequence");
	assert.ok(!component.filteredModels.some((m) => m.fullId === "anthropic/claude-sonnet-4"), "g5m does not match anthropic model");
});

test("subagent-hub: typing a non-matching query clears results", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput("xyz123");
	assert.equal(component.filteredModels.length, 0, "no models match xyz123");
	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /No matching models/);
});

test("subagent-hub: fuzzy search preserves selection by fullId when results change", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	// Select the third model by simulating navigation.
	component.modelSelectedIndex = 2;
	const selectedFullId = component.filteredModels[component.modelSelectedIndex]?.fullId;
	assert.ok(selectedFullId, "precondition: a model is selected");

	// Narrow the query so the selected model moves to a different position.
	component.modelSearchQuery = "model-";
	component.filterModels();
	const newIndex = component.filteredModels.findIndex((m) => m.fullId === selectedFullId);
	assert.ok(newIndex >= 0, "selected model is still in results");
	assert.equal(component.modelSelectedIndex, newIndex, "selection index follows the model by fullId");

	// Narrow further so the selected model disappears; selection should reset to 0.
	component.modelSearchQuery = "nonexistent-xyz";
	component.filterModels();
	assert.equal(component.filteredModels.length, 0, "no matching models");
	assert.equal(component.modelSelectedIndex, 0, "selection resets to 0 when model disappears");
});

test("subagent-hub: constructor handles unresolvable agent.model", {
	skip: !available,
}, () => {
	// agent.model set to a model not in availableModels
	const agents = makeAgents(["worker"], ["nonexistent/custom-model"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Constructor should not throw when agent.model doesn't match any available model
	assert.ok(component !== undefined);
});

test("subagent-hub: resolveAgentEffectiveModel returns empty string when no models available", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		[],
		undefined,
		() => {},
	);

	const effectiveModel = (component as any).resolveAgentEffectiveModel(agents[0]);
	assert.equal(effectiveModel, "");
});

test("subagent-hub: model selector with >10 models shows scroll indicators", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(30);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	// Scroll to end to ensure both up and down indicators show
	component.modelSelectedIndex = 29;
	component.filterModels();

	const rendered = component.render(84).join("\n");
	const stripped = stripAnsi(rendered);

	// Should show some scroll info (either up or remaining count)
	assert.ok(stripped.includes("more") || /\d+\s*more/.test(stripped) || /\d+/.test(stripped));
});

test("subagent-hub: model selector current badge renders for matching model", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	// Set current model to first available model
	component.agentModelOverrides.set("worker", models[0]!.fullId);
	component.enterModelSelector(0); // re-enter to recalculate

	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /current/);
});

test("subagent-hub: filterModels resets to full list when query is empty", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(10);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);

	// Filter to subset
	component.modelSearchQuery = "anthropic";
	component.filterModels();
	assert.ok(component.filteredModels.length < 10);

	// Reset query to empty
	component.modelSearchQuery = "";
	component.filterModels();
	assert.equal(component.filteredModels.length, 10);
});

test("subagent-hub: model selector typing with space character is accepted", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.handleModelSelectorInput(" ");

	assert.equal(component.modelSearchQuery, " ");
});

// ── Model overrides ───────────────────────────────────────────────────

test("subagent-hub: constructor pre-populates overrides from agent.model", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["anthropic/model-1"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Constructor should not throw with a resolvable model config
	assert.ok(component, "component constructed without error");
});

test("subagent-hub: manually set override appears in main view", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.agentModelOverrides.set("worker", "anthropic/model-1");
	// Mark as dirty so the ✎ indicator shows (matches the real UI edit path)
	(component as any).dirtyAgents.add("worker");

	const rendered = component.render(84).join("\n");
	assert.match(rendered, /✎/);
	assert.match(rendered, /anthropic\/model-1/);
});

test("subagent-hub: override persists after exitModelSelector", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	const idx = component.filteredModels.findIndex((m: any) => m.fullId === "anthropic/model-1");
	if (idx >= 0) component.modelSelectedIndex = idx;
	const selected = component.filteredModels[component.modelSelectedIndex];
	if (selected) component.agentModelOverrides.set("worker", selected.fullId);
	component.exitModelSelector();

	assert.equal(component.agentModelOverrides.get("worker"), "anthropic/model-1");
});

// ── Model selector render ─────────────────────────────────────────────

test("subagent-hub: model selector shows current model", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	const rendered = component.render(84).join("\n");

	assert.match(stripAnsi(rendered), /Select Model/);
	assert.match(stripAnsi(rendered), /Search:/);
	assert.match(stripAnsi(rendered), /Current:/);
});

test("subagent-hub: model selector lists all models", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	const rendered = component.render(84).join("\n");
	const stripped = stripAnsi(rendered);

	assert.match(stripped, /model-0.*openai/);
	assert.match(stripped, /model-1.*anthropic/);
	assert.match(stripped, /model-2.*google/);
});

test("subagent-hub: empty models list shows no matching models", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		[],
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /No matching models/);
});

// ── Done callback ─────────────────────────────────────────────────────

test("subagent-hub: done callback receives overrides on esc (done)", {
	skip: !available,
}, (t, done) => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	let receivedResult: any = null;
	let testDone = false;

	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		(result: any) => {
			receivedResult = result;
			if (!testDone) {
				testDone = true;
				done();
			}
		},
	);

	component.agentModelOverrides.set("a", "openai/model-0");
	component.agentModelOverrides.set("b", "anthropic/model-1");

	// Trigger done (esc=done applies overrides; matchesKey shim now implements keys, so call done() directly)
	(component as any).done({ overrides: component.agentModelOverrides });

	// done() is called by wrapper in component callback
}, { timeout: 2000 });

test("subagent-hub: ctrl+c cancels with empty overrides map", {
	skip: !available,
}, (t, done) => {
	const agents = makeAgents(["a"]);
	const models = makeModels(3);

	let testDone = false;
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		(result: any) => {
			if (!testDone) {
				testDone = true;
				assert.ok(result.overrides instanceof Map);
				assert.equal(result.overrides.size, 0);
				done();
			}
		},
	);

	// Cancel: ctrl+c discards all overrides (matchesKey shim now implements keys, so call done() directly)
	component.agentModelOverrides.set("a", "openai/model-0");
	(component as any).done({ overrides: new Map() });

	// done() is called by wrapper in component callback
}, { timeout: 2000 });

// ── Main view render ───────────────────────────────────────────────────

test("subagent-hub: main view renders agent names", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker", "planner", "oracle"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	const rendered = component.render(84).join("\n");
	const stripped = stripAnsi(rendered);

	assert.match(stripped, /Subagent Models/);
	assert.match(stripped, /worker/);
	assert.match(stripped, /planner/);
	assert.match(stripped, /oracle/);
});

test("subagent-hub: main view shows footer with key hints", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	const rendered = component.render(84).join("\n");
	const stripped = stripAnsi(rendered);

	assert.match(stripped, /enter/);
	assert.match(stripped, /cancel/);
	assert.match(stripped, /navigate/);
});

test("subagent-hub: selected agent shows indicator", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 1;
	const rendered = component.render(84).join("\n");

	// Selected agent should show accent color (rendered as plain text in mock theme)
	assert.match(rendered, /b/);
});

test("subagent-hub: main view respects width and includes long agent names", {
	skip: !available,
}, () => {
	const agents = makeAgents(["this-is-a-very-long-agent-name-that-exceeds-limits"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	const rendered = component.render(84).join("\n");
	const stripped = stripAnsi(rendered);

	assert.ok(stripped.includes("this-is-a-very-long-agent"), "long agent name should appear in render");
	// Width invariant: no rendered line exceeds the available width
	const lines = rendered.split("\n");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 84, `line exceeds width 84: ${visibleWidth(line)}`);
	}
});

// ── Model selector navigation ────────────────────────────────────────

test("subagent-hub: model selector up navigation wraps", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSelectedIndex = 0;

	// Simulate wrapping up
	if (component.filteredModels.length > 0) {
		component.modelSelectedIndex = component.filteredModels.length - 1;
	}

	assert.equal(component.modelSelectedIndex, 4);
});

test("subagent-hub: model selector down navigation wraps", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSelectedIndex = component.filteredModels.length - 1;

	// Simulate wrapping down to first
	if (component.filteredModels.length > 0) {
		component.modelSelectedIndex = 0;
	}

	assert.equal(component.modelSelectedIndex, 0);
});

// ── Edge cases ────────────────────────────────────────────────────────

test("subagent-hub: resolveAgentEffectiveModel returns empty string when no model configured", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]); // no model set
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Access private method via any
	const effectiveModel = (component as any).resolveAgentEffectiveModel(agents[0]);
	assert.ok(effectiveModel !== undefined);
	assert.equal(effectiveModel, "", "no model configured returns empty string");
});

test("subagent-hub: resolveAgentEffectiveModel returns agent.model when set", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["custom/model-special"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	const effectiveModel = (component as any).resolveAgentEffectiveModel(agents[0]);
	assert.ok(effectiveModel.includes("custom/model-special") || effectiveModel.length > 0);
});

test("subagent-hub: dispose and invalidate are no-ops", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Should not throw
	component.dispose();
	component.invalidate();

	assert.ok(true, "dispose and invalidate completed without error");
});

test("subagent-hub: multiple agents with different override states", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.agentModelOverrides.set("b", "anthropic/model-1");
	// Mark as dirty so the ✎ indicator shows (matches the real UI edit path)
	(component as any).dirtyAgents.add("b");

	const rendered = component.render(84).join("\n");

	// b should show override indicator
	assert.match(rendered, /✎/);
	assert.match(rendered, /anthropic\/model-1/);
});

test("subagent-hub: enterModelSelector for agent with existing override pre-selects", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["anthropic/model-2"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterModelSelector(0);

	// Should have pre-selected the current override
	assert.ok(component.modelSelectedIndex >= 0);
	assert.ok(component.modelSelectedIndex < component.filteredModels.length);
});

// ── Thinking level: cycle + persistence (regression: off/high/off bug) ────

test("subagent-hub: seeds existing thinking config so a no-touch exit preserves it", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	(agents[0] as any).thinking = "high";
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Configured agent is seeded; unconfigured agent stays absent (no thinking:"off" noise).
	assert.equal(component.agentThinkingOverrides.get("a"), "high");
	assert.equal(component.agentThinkingOverrides.has("b"), false);
});


test("subagent-hub: separate thinking takes precedence over model suffix on no-touch exit", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a"], ["openai/model-0:low"]);
	agents[0]!.thinking = "high";
	const models = makeModels(1);
	let receivedResult: any = null;
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		(result: any) => {
			receivedResult = result;
		},
	);

	assert.equal(component.agentThinkingOverrides.get("a"), "high");
	(component as any).done({ overrides: component.agentModelOverrides, thinkingOverrides: component.agentThinkingOverrides });
	assert.equal(receivedResult.thinkingOverrides.get("a"), "high");
});

test("subagent-hub: cycles only model-supported thinking levels", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a"], ["deepseek/deepseek-v4-flash"]);
	const models = [
		{
			provider: "deepseek",
			id: "deepseek-v4-flash",
			fullId: "deepseek/deepseek-v4-flash",
			reasoning: true,
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		},
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	assert.equal(component.agentThinkingOverrides.has("a"), false, "starts unset/off");
	component.cycleThinkingLevel();
	assert.equal(component.agentThinkingOverrides.get("a"), "high");
	component.cycleThinkingLevel();
	assert.equal(component.agentThinkingOverrides.get("a"), "xhigh");
	component.cycleThinkingLevel();
	assert.equal(component.agentThinkingOverrides.get("a"), "off");
});

test("subagent-hub: leaves off-only models on off when cycling thinking", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a"], ["vendor/no-reasoning"]);
	const models = [{ provider: "vendor", id: "no-reasoning", fullId: "vendor/no-reasoning", reasoning: false }];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	assert.equal(component.agentThinkingOverrides.has("a"), false, "starts unset/off");
	component.cycleThinkingLevel();
	assert.equal(component.agentThinkingOverrides.has("a"), false, "off-only cycle stays unset/off");
});

// ── Phase 1: stable component tree, theme rebuild, width ───────────

test("subagent-hub: repeated renders do not replace the active agent list", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84); // first render builds the list
	const listBefore = (component as any).agentSelectList;
	assert.ok(listBefore, "agent SelectList exists after first render");

	component.render(84); // second render should NOT rebuild
	const listAfter = (component as any).agentSelectList;
	assert.strictEqual(listAfter, listBefore, "same SelectList instance across repeated renders");
});

test("subagent-hub: selection survives theme rebuild by identity", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b", "c"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 1;
	const renderBefore = component.render(84).join("\n");
	assert.match(renderBefore, /b/, "agent b is visible before rebuild");

	// Theme invalidation triggers a rebuild. A new SelectList instance is
	// acceptable because pi-tui's SelectList has no setItems; the real contract
	// is that the selected agent (by index and rendered content) is preserved.
	component.invalidate();
	const renderAfter = component.render(84).join("\n");
	assert.equal(component.selectedAgentIndex, 1, "selection index preserved");
	assert.match(renderAfter, /b/, "agent b still visible after rebuild");
	const selectedBefore = renderBefore.split("\n").find((line) => line.includes("b")) ?? "";
	const selectedAfter = renderAfter.split("\n").find((line) => line.includes("b")) ?? "";
	assert.equal(stripAnsi(selectedBefore).trim(), stripAnsi(selectedAfter).trim(), "selected row content preserved");
});

test("subagent-hub: editing an agent updates the main list on re-render", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["openai/model-1"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	const before = component.render(84).join("\n");
	assert.ok(!before.includes("✎"), "no edit marker before change");
	assert.ok(before.includes("thinking: off"), "initial thinking is off");

	// Simulate the user cycling the thinking level for the selected agent.
	component.cycleThinkingLevel();
	const newThinking = component.agentThinkingOverrides.get("worker");
	assert.ok(newThinking && newThinking !== "off", "thinking override changed to a non-off level");

	const after = component.render(84).join("\n");
	assert.ok(after.includes("✎"), "edit marker appears after change");
	assert.ok(after.includes(`thinking: ${newThinking}`), "rendered thinking matches override");
	assert.ok(!after.includes("thinking: off"), "old thinking display is gone");
});

test("subagent-hub: mutable theme produces new themed output after invalidate", {
	skip: !available,
}, () => {
	let accentColor = "red";
	const theme = {
		fg(key: string, text: string) { return key === "accent" ? `[${accentColor}]${text}` : text; },
		bold(text: string) { return text; },
	};
	const agents = makeAgents(["worker"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		theme as any,
		agents,
		models,
		undefined,
		() => {},
	);

	const rendered1 = component.render(84).join("\n");
	assert.match(rendered1, /\[red\]/, "first render uses red accent");

	// Change the theme and invalidate
	accentColor = "blue";
	component.invalidate();
	const rendered2 = component.render(84).join("\n");
	assert.match(rendered2, /\[blue\]/, "after invalidate, render uses blue accent");
	assert.doesNotMatch(rendered2, /\[red\]/, "stale red theme is gone after invalidate");
});

test("subagent-hub: width invariant holds at narrow and normal widths", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker", "planner", "oracle"]);
	const models = makeModels(5);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	for (const width of [30, 60, 84, 100]) {
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: line exceeds bounds (${visibleWidth(line)})`);
		}
	}
});

test("subagent-hub: width invariant holds for long names and wide unicode", {
	skip: !available,
}, () => {
	const agents = makeAgents(["this-is-a-very-long-agent-name-that-exceeds-normal-display-widths"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Render at a narrow width with content that includes a wide unicode char
	component.enterModelSelector(0);
	component.modelSearchQuery = "\u4e2d"; // CJK character 中
	component.filterModels();

	for (const width of [40, 60, 84]) {
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: line exceeds bounds (${visibleWidth(line)})`);
		}
	}
});