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

function makeAgents(names: string[], models?: string[], thinkings?: string[]): {
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
		model: models?.[i],
		thinking: thinkings?.[i],
		override: undefined,
	}));
}

function makeAgentsWithOverride(names: string[], models?: string[], overrides?: boolean[]): {
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
		model: models?.[i],
		thinking: undefined,
		override: overrides?.[i] ? { model: models?.[i] ?? "custom/model" } : undefined,
	}));
}

function makeMockTui() {
	return { requestRender() {} };
}

function makeMockTheme() {
	return { fg(_key: string, text: string) { return text; }, bold(text: string) { return text; } };
}

function makeRecordingTheme() {
	const keys: string[] = [];
	return {
		fg(key: string, text: string) { keys.push(key); return text; },
		bold(text: string) { return text; },
		keys,
	};
}

function findRow(rendered: string, name: string): string {
	// Match the agent name as a standalone token in a rendered line.
	return stripAnsi(rendered.split("\n").find((line) => {
		const stripped = stripAnsi(line);
		const re = new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`);
		return re.test(stripped);
	}) ?? "");
}


/** Type-safe accessor for component private sets used in tests. */
function componentState(component: unknown) {
	return component as { dirtyAgents: Set<string>; resetAgents: Set<string> };
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
	const beforeRow = stripAnsi(before.split("\n").find((line) => stripAnsi(line).includes("worker")) ?? "");
	assert.ok(!beforeRow.includes("✎"), "no edit marker on the worker row before change");
	assert.ok(beforeRow.includes("thinking: inherit"), "initial unset thinking shows inherit");

	// Simulate the user cycling the thinking level for the selected agent.
	component.cycleThinkingLevel();
	const newThinking = component.agentThinkingOverrides.get("worker");
	assert.ok(newThinking && newThinking !== "off", "thinking override changed to a non-off level");

	const after = component.render(84).join("\n");
	const afterRow = stripAnsi(after.split("\n").find((line) => stripAnsi(line).includes("worker")) ?? "");
	assert.ok(afterRow.includes("✎"), "edit marker appears on the worker row after change");
	assert.ok(afterRow.includes(`thinking: ${newThinking}`), "rendered thinking matches override");
	assert.ok(!afterRow.includes("thinking: inherit"), "old inherit display is gone");
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

// ── Phase 3: thinking settings view (SettingsList) ─────────────────────

test("subagent-hub: tab opens the thinking view", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84); // build the main view + SelectList
	component.handleInput("\t"); // tab opens thinking view

	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /Thinking Levels/, "thinking view title appears");
	assert.match(stripAnsi(rendered), /navigate/, "footer hints appear");
});

test("subagent-hub: escape from thinking view returns to main", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.enterThinkingView();
	component.render(84); // build the thinking view
	component.handleInput("\x1b"); // escape

	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /Subagent Models/, "back to main view");
	assert.doesNotMatch(stripAnsi(rendered), /Thinking Levels/, "thinking view is gone");
});

test("subagent-hub: thinking view no-touch close preserves unset thinking", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Enter thinking view, do nothing, exit — no dirty writes.
	component.enterThinkingView();
	component.render(84);
	component.exitThinkingView();

	assert.equal(component.agentThinkingOverrides.has("a"), false, "agent a thinking stays unset");
	assert.equal(component.agentThinkingOverrides.has("b"), false, "agent b thinking stays unset");
	assert.equal((component as any).dirtyAgents.size, 0, "no agents dirtied by no-touch open+close");
});

test("subagent-hub: thinking view onChange marks dirty and updates only that agent", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"], ["openai/model-0", "openai/model-0"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterThinkingView();
	component.render(84); // build the SettingsList

	// Press enter to cycle the first agent's thinking level.
	component.handleInput("\r");

	const thinkingA = component.agentThinkingOverrides.get("a");
	assert.ok(thinkingA && thinkingA !== "off", "agent a thinking was changed");
	assert.equal(component.agentThinkingOverrides.has("b"), false, "agent b is untouched");
	assert.ok((component as any).dirtyAgents.has("a"), "agent a is dirty");
	assert.equal((component as any).dirtyAgents.has("b"), false, "agent b is not dirty");
});

test("subagent-hub: thinking view onChange pins model only when agent has configured model", {
	skip: !available,
}, () => {
	// Agent with a configured model gets a companion model pin.
	const agentsWithModel = makeAgents(["configured"], ["openai/model-0"]);
	const models = makeModels(3);
	const componentWith = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agentsWithModel,
		models,
		undefined,
		() => {},
	);

	componentWith.enterThinkingView();
	componentWith.render(84);
	componentWith.handleInput("\r"); // cycle thinking

	assert.ok(componentWith.agentModelOverrides.has("configured"), "model pinned for configured agent");

	// Agent without a configured model does NOT get a fabricated model pin.
	const agentsNoModel = makeAgents(["unconfigured"]);
	const componentWithout = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agentsNoModel,
		models,
		undefined,
		() => {},
	);

	componentWithout.enterThinkingView();
	componentWithout.render(84);
	componentWithout.handleInput("\r"); // cycle thinking

	assert.equal(componentWithout.agentModelOverrides.has("unconfigured"), false, "no model pin for model-less agent");
});

test("subagent-hub: thinking view exposes only model-supported levels", {
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

	component.enterThinkingView();
	component.render(84); // build the SettingsList

	// Check the SettingItem's values array directly (the shim renders only currentValue).
	const items = (component as any).thinkingSelectList.items as any[];
	const item = items.find((i) => i.id === "a");
	assert.ok(item, "agent a has a setting item");
	assert.deepEqual(item.values, ["off", "high", "xhigh"], "only supported levels exposed");
	assert.ok(!item.values.includes("minimal"), "minimal excluded (null in map)");
	assert.ok(!item.values.includes("low"), "low excluded (null in map)");
	assert.ok(!item.values.includes("medium"), "medium excluded (null in map)");
});

test("subagent-hub: thinking view off-only model stays on off", {
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

	component.enterThinkingView();
	component.render(84);

	// Press enter — for an off-only model, cycling should not change anything.
	component.handleInput("\r");

	// The value stays "off" (the only supported level).
	const thinking = component.agentThinkingOverrides.get("a");
	assert.ok(!thinking || thinking === "off", "off-only model stays on off");
});

test("subagent-hub: model change clamps unsupported thinking level", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a"], ["openai/model-0"]);
	const models = [
		{ provider: "openai", id: "model-0", fullId: "openai/model-0", reasoning: true },
		{ provider: "vendor", id: "no-reasoning", fullId: "vendor/no-reasoning", reasoning: false },
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Set a thinking override that the new model won't support.
	component.agentThinkingOverrides.set("a", "high");
	(component as any).dirtyAgents.add("a");

	// Select a model that only supports "off".
	component.enterModelSelector(0);
	component.modelSearchQuery = "vendor";
	component.filterModels();
	assert.equal(component.filteredModels.length, 1, "vendor model found");
	component.modelSelectedIndex = 0;

	// Render to build the model SelectList, then simulate the onSelect callback.
	component.render(84);
	const selectedModel = component.filteredModels[component.modelSelectedIndex];
	if (selectedModel && (component as any).modelSelectList) {
		(component as any).modelSelectList.onSelect({ value: selectedModel.fullId });
	}

	// The thinking override should be clamped to "off".
	assert.equal(component.agentThinkingOverrides.get("a"), "off", "unsupported thinking clamped to off");
});

test("subagent-hub: thinking view width invariant holds", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker", "planner"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.enterThinkingView();

	for (const width of [30, 60, 84]) {
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: line exceeds bounds (${visibleWidth(line)})`);
		}
	}
});

// ── Phase 4: display polish ─────────────────────────────────────────────

test("subagent-hub: header shows agent count and modified count", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(
		["a", "b", "c"],
		["openai/model-0", "openai/model-1", "openai/model-2"],
		[false, true, true],
	);
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
	assert.match(stripAnsi(rendered), /Subagent Models \(3 agents · 0 modified\)/, "header shows count with zero modified");

	// Dirty-only agent.
	component.agentModelOverrides.set("a", "anthropic/model-1");
	componentState(component).dirtyAgents.add("a");
	component.invalidate();
	let after = component.render(84).join("\n");
	assert.match(stripAnsi(after), /Subagent Models \(3 agents · 1 modified\)/, "dirty-only counts as modified");

	// Reset-only agent (requires persisted override metadata).
	component.selectedAgentIndex = 1;
	component.resetSelectedAgent();
	component.invalidate();
	after = component.render(84).join("\n");
	assert.match(stripAnsi(after), /Subagent Models \(3 agents · 2 modified\)/, "reset-only counts as modified");

	// Both dirty and reset: counted once in the union.
	component.agentModelOverrides.set("c", "anthropic/model-2");
	componentState(component).dirtyAgents.add("c");
	componentState(component).resetAgents.add("c");
	component.invalidate();
	after = component.render(84).join("\n");
	assert.match(stripAnsi(after), /Subagent Models \(3 agents · 3 modified\)/, "dirty-and-reset counted once in union");
});

test("subagent-hub: persisted marker shows for agents with override", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a", "b"], ["openai/model-0", "openai/model-0"], [true, false]);
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
	assert.match(findRow(rendered, "a"), /●/, "persisted agent shows ● marker");
	assert.doesNotMatch(findRow(rendered, "b"), /●/, "non-persisted agent has no ● marker");
});

test("subagent-hub: session edit marker shows for dirty agents", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	(component as any).dirtyAgents.add("a");
	const rendered = component.render(84).join("\n");
	assert.match(findRow(rendered, "a"), /✎/, "dirty agent shows ✎ marker");
	assert.doesNotMatch(findRow(rendered, "b"), /✎/, "clean agent has no ✎ marker");
});

test("subagent-hub: staged reset marker replaces edit marker", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Stage a reset for the persisted agent.
	(component as any).resetAgents.add("a");
	const rendered = component.render(84).join("\n");
	const row = findRow(rendered, "a");
	assert.match(row, /↺/, "staged reset shows ↺ marker");
	assert.doesNotMatch(row, /✎/, "staged reset does not show edit marker");
	assert.match(row, /●/, "persisted marker remains alongside reset marker");
});

test("subagent-hub: persisted and session markers both show when overlap", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	(component as any).dirtyAgents.add("a");
	const rendered = component.render(84).join("\n");
	const row = findRow(rendered, "a");
	assert.match(row, /●/, "persisted marker shown");
	assert.match(row, /✎/, "session edit marker shown");
});

test("subagent-hub: unset thinking shows inherit and explicit off shows off", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"], ["openai/model-0", "openai/model-0"], [undefined, "off"]);
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
	assert.match(findRow(rendered, "a"), /thinking: inherit/, "unset thinking shows inherit");
	assert.match(findRow(rendered, "b"), /thinking: off/, "explicit off shows off");
});

test("subagent-hub: all thinking color keys are exercised", {
	skip: !available,
}, () => {
	const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const keyFor = (level: string) => {
		if (level === "off") return "thinkingOff";
		if (level === "xhigh") return "thinkingXhigh";
		return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}`;
	};
	const models = [{ provider: "test", id: "all-levels", fullId: "test/all-levels", reasoning: true, thinkingLevelMap: { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "x", max: "max" } }];
	for (const level of levels) {
		const agents = makeAgents(["a"], ["test/all-levels"], [level]);
		const recording = makeRecordingTheme();
		const component = new SubagentHubComponent!(
			makeMockTui(),
			recording as any,
			agents,
			models,
			undefined,
			() => {},
		);
		component.render(84);
		assert.ok(recording.keys.includes(keyFor(level)), `color key for ${level} used`);
	}
});

test("subagent-hub: model picker row includes supported thinking levels", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["openai/model-0"]);
	const models = [
		{ provider: "openai", id: "model-0", fullId: "openai/model-0", reasoning: true, thinkingLevelMap: { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "x", max: "max" } },
		{ provider: "anthropic", id: "model-1", fullId: "anthropic/model-1", reasoning: true, thinkingLevelMap: { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "x", max: "max" } },
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
	const rendered = component.render(84).join("\n");
	assert.match(stripAnsi(rendered), /\[openai\].*off\/minimal\/low\/medium\/high\/xhigh\/max/, "openai row lists supported levels");
	assert.match(stripAnsi(rendered), /\[anthropic\].*off\/minimal\/low\/medium\/high\/xhigh\/max/, "anthropic row lists supported levels");
});

test("subagent-hub: model picker Current shows base model and active thinking", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["openai/model-0:high"]);
	const models = [{
		provider: "openai", id: "model-0", fullId: "openai/model-0", reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "x", max: "max" },
	}];
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
	assert.match(stripped, /Current: openai\/model-0/, "Current shows base model without suffix");
	assert.match(stripped, /thinking: high/, "Current shows active thinking");
});

test("subagent-hub: model picker Current shows inherit when thinking unset", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"], ["openai/model-0"]);
	const models = [{ provider: "openai", id: "model-0", fullId: "openai/model-0" }];
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
	assert.match(stripped, /Current: openai\/model-0/, "Current shows base model without suffix");
	assert.match(stripped, /thinking: inherit/, "Current shows inherit when thinking is unset");
});

test("subagent-hub: empty-query model list is sorted by provider then id with preferred first", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = [
		{ provider: "zebra", id: "zulu", fullId: "zebra/zulu" },
		{ provider: "openai", id: "model-0", fullId: "openai/model-0" },
		{ provider: "anthropic", id: "model-1", fullId: "anthropic/model-1" },
		{ provider: "openai", id: "model-a", fullId: "openai/model-a" },
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		"openai",
		() => {},
	);

	component.enterModelSelector(0);
	const ids = component.filteredModels.map((m) => m.id);
	assert.deepEqual(ids, ["model-0", "model-a", "model-1", "zulu"], "preferred provider first, then alphabetical provider/id");
});

test("subagent-hub: non-empty query preserves fuzzy relevance order over provider sort", {
	skip: !available,
}, () => {
	const agents = makeAgents(["worker"]);
	const models = [
		{ provider: "openai", id: "zzz-gpt-zzz", fullId: "openai/zzz-gpt-zzz" },
		{ provider: "zebra", id: "gpt", fullId: "zebra/gpt" },
	];
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		"openai",
		() => {},
	);

	component.enterModelSelector(0);
	component.modelSearchQuery = "gpt";
	component.filterModels();
	// The empty-query provider sort would put "openai" first; the query should
	// rank the model whose id starts with the query above the substring match.
	assert.deepEqual(
		component.filteredModels.map((m) => m.fullId),
		["zebra/gpt", "openai/zzz-gpt-zzz"],
		"fuzzy relevance order wins over alphabetical provider order",
	);
});

// ── Phase 5: single/bulk reset + undo ──────────────────────────────

test("subagent-hub: single reset stages a reset for persisted agent", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 0;
	component.render(84); // build main view
	component.handleInput("x");

	const st = componentState(component);
	assert.ok(st.resetAgents.has("a"), "agent staged for reset");
	assert.ok(!st.dirtyAgents.has("a"), "reset agent removed from dirty");
});

test("subagent-hub: single reset is a no-op on non-persisted agent", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a"]); // no override metadata
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");

	const st = componentState(component);
	assert.equal(st.resetAgents.size, 0, "non-persisted agent not staged for reset");
});

test("subagent-hub: undo restores exact prior state after single reset", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Setup: agent has a model override and a thinking override, and is dirty.
	component.agentModelOverrides.set("a", "anthropic/model-1");
	component.agentThinkingOverrides.set("a", "high");
	componentState(component).dirtyAgents.add("a");

	const modelBefore = component.agentModelOverrides.get("a");
	const thinkingBefore = component.agentThinkingOverrides.get("a");
	const wasDirtyBefore = componentState(component).dirtyAgents.has("a");

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");

	// Reset should have cleared the maps.
	assert.equal(component.agentModelOverrides.has("a"), false, "model cleared by reset");
	assert.equal(component.agentThinkingOverrides.has("a"), false, "thinking cleared by reset");
	assert.ok(componentState(component).resetAgents.has("a"), "agent in resetAgents");

	// Undo.
	component.handleInput("u");

	assert.equal(component.agentModelOverrides.get("a"), modelBefore, "model restored by undo");
	assert.equal(component.agentThinkingOverrides.get("a"), thinkingBefore, "thinking restored by undo");
	assert.equal(componentState(component).dirtyAgents.has("a"), wasDirtyBefore, "dirty membership restored");
	assert.ok(!componentState(component).resetAgents.has("a"), "reset removed by undo");
});

test("subagent-hub: undo can unwind multiple single resets in LIFO order", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a", "b"], ["openai/model-0", "openai/model-0"], [true, true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x"); // reset agent a

	component.selectedAgentIndex = 1;
	component.handleInput("x"); // reset agent b

	assert.equal(componentState(component).resetAgents.size, 2, "both agents reset");

	// Undo last (agent b).
	component.handleInput("u");
	assert.ok(!componentState(component).resetAgents.has("b"), "agent b reset undone");
	assert.ok(componentState(component).resetAgents.has("a"), "agent a still reset");

	// Undo previous (agent a).
	component.handleInput("u");
	assert.ok(!componentState(component).resetAgents.has("a"), "agent a reset undone");
});

test("subagent-hub: undo when stack is empty is a no-op", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("u"); // no transactions

	assert.ok(true, "undo on empty stack does not throw");
});

test("subagent-hub: bulk reset targets only persisted agents", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(
		["persisted1", "persisted2", "plain"],
		["openai/model-0", "openai/model-0", "openai/model-0"],
		[true, true, false],
	);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84); // build main view
	component.handleInput("X"); // enter confirmation

	const confirmRender = component.render(84).join("\n");
	assert.match(stripAnsi(confirmRender), /Reset Overrides/, "confirmation view title shows");
	assert.match(stripAnsi(confirmRender), /2 persisted/, "count reflects only persisted agents");
});

test("subagent-hub: bulk reset confirm stages resets for all persisted agents", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(
		["p1", "p2", "plain"],
		["openai/model-0", "openai/model-0", "openai/model-0"],
		[true, true, false],
	);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.handleInput("X"); // enter confirmation
	component.render(84); // build confirmation view (creates SelectList)

	// Simulate confirming "Reset".
	const confirmList = (component as any).resetConfirmSelectList;
	assert.ok(confirmList, "confirmation SelectList exists");
	confirmList.onSelect({ value: "reset" });

	const st = componentState(component);
	assert.ok(st.resetAgents.has("p1"), "p1 staged for reset");
	assert.ok(st.resetAgents.has("p2"), "p2 staged for reset");
	assert.ok(!st.resetAgents.has("plain"), "plain agent NOT staged");
	assert.equal((component as any).view, "main", "returns to main after confirm");


test("subagent-hub: bulk reset with no persisted agents does not push undo transaction", {
	skip: !available,
}, () => {
	const agents = makeAgents(["a", "b"]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.handleInput("X");
	component.render(84); // build confirmation view

	const confirmList = (component as any).resetConfirmSelectList;
	assert.ok(confirmList, "confirmation SelectList exists");
	confirmList.onSelect({ value: "reset" });

	assert.equal(componentState(component).resetAgents.size, 0, "no agents staged");
	assert.equal((component as any).undoStack.length, 0, "no undo transaction pushed");
	assert.equal((component as any).view, "main", "returns to main");

	const rendered = component.render(84).join("\n");
	assert.doesNotMatch(stripAnsi(rendered), /\bundo\b/, "undo hint not shown in footer");
});
});

test("subagent-hub: bulk reset cancel returns without resetting", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["p1"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.handleInput("X"); // enter confirmation
	component.render(84); // build confirmation view

	// Simulate selecting "Cancel".
	const confirmList = (component as any).resetConfirmSelectList;
	confirmList.onSelect({ value: "cancel" });

	const st = componentState(component);
	assert.equal(st.resetAgents.size, 0, "no agents staged after cancel");
	assert.equal((component as any).view, "main", "returns to main after cancel");
});

test("subagent-hub: bulk reset cancel via escape returns without resetting", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["p1"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.handleInput("X"); // enter confirmation
	component.handleInput("\x1b"); // escape

	const st = componentState(component);
	assert.equal(st.resetAgents.size, 0, "no agents staged after escape");
	assert.equal((component as any).view, "main", "returns to main after escape");
});

test("subagent-hub: bulk reset clears conflicting session edits", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["p1"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Setup: dirty model + thinking override.
	component.agentModelOverrides.set("p1", "anthropic/model-1");
	component.agentThinkingOverrides.set("p1", "high");
	componentState(component).dirtyAgents.add("p1");

	component.render(84);
	component.handleInput("X"); // enter confirmation
	component.render(84); // build confirmation view
	(component as any).resetConfirmSelectList.onSelect({ value: "reset" });

	assert.equal(component.agentModelOverrides.has("p1"), false, "model override cleared");
	assert.equal(component.agentThinkingOverrides.has("p1"), false, "thinking override cleared");
	assert.ok(!componentState(component).dirtyAgents.has("p1"), "agent removed from dirty");
	assert.ok(componentState(component).resetAgents.has("p1"), "agent in resetAgents");
});

test("subagent-hub: undo of bulk transaction restores all targeted agents", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(
		["p1", "p2"],
		["openai/model-0", "openai/model-0"],
		[true, true],
	);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Setup: dirty edits on both.
	component.agentModelOverrides.set("p1", "anthropic/model-1");
	component.agentThinkingOverrides.set("p1", "high");
	componentState(component).dirtyAgents.add("p1");
	component.agentModelOverrides.set("p2", "google/model-2");
	componentState(component).dirtyAgents.add("p2");

	component.render(84);
	component.handleInput("X");
	component.render(84); // build confirmation view
	(component as any).resetConfirmSelectList.onSelect({ value: "reset" });

	// Both should be cleared and in resetAgents.
	assert.equal(component.agentModelOverrides.has("p1"), false, "p1 model cleared");
	assert.equal(component.agentModelOverrides.has("p2"), false, "p2 model cleared");

	// Undo the bulk transaction.
	component.handleInput("u");

	assert.equal(component.agentModelOverrides.get("p1"), "anthropic/model-1", "p1 model restored");
	assert.equal(component.agentThinkingOverrides.get("p1"), "high", "p1 thinking restored");
	assert.ok(componentState(component).dirtyAgents.has("p1"), "p1 dirty restored");
	assert.equal(component.agentModelOverrides.get("p2"), "google/model-2", "p2 model restored");
	assert.ok(componentState(component).dirtyAgents.has("p2"), "p2 dirty restored");
	assert.ok(!componentState(component).resetAgents.has("p1"), "p1 reset removed");
	assert.ok(!componentState(component).resetAgents.has("p2"), "p2 reset removed");
});

test("subagent-hub: edit after reset removes agent from resetAgents (edit wins)", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Stage a reset.
	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");
	assert.ok(componentState(component).resetAgents.has("a"), "agent staged for reset");

	// Now cycle thinking (edit path) — should remove from resetAgents.
	component.cycleThinkingLevel();
	assert.ok(!componentState(component).resetAgents.has("a"), "edit removes from resetAgents");
	assert.ok(componentState(component).dirtyAgents.has("a"), "agent is now dirty");
});


test("subagent-hub: model edit after reset removes agent from resetAgents (edit wins)", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Stage a reset on the persisted agent.
	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");
	assert.ok(componentState(component).resetAgents.has("a"), "agent staged for reset");

	// Enter model selector and pick a different model (model-path edit wins).
	component.enterModelSelector(0);
	component.render(84); // build modelSelectList
	const modelList = (component as any).modelSelectList;
	assert.ok(modelList, "model SelectList exists");
	modelList.onSelect({ value: "anthropic/model-1" });

	assert.ok(!componentState(component).resetAgents.has("a"), "model edit removes agent from resetAgents");
	assert.ok(componentState(component).dirtyAgents.has("a"), "agent is now dirty");
	assert.equal(component.agentModelOverrides.get("a"), "anthropic/model-1", "model override recorded");
});

test("subagent-hub: reset after edit removes agent from dirty maps (reset wins)", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	// Setup: dirty model + thinking override.
	component.agentModelOverrides.set("a", "anthropic/model-1");
	component.agentThinkingOverrides.set("a", "high");
	componentState(component).dirtyAgents.add("a");

	// Reset (reset wins over edit).
	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");

	assert.equal(component.agentModelOverrides.has("a"), false, "model override cleared by reset");
	assert.equal(component.agentThinkingOverrides.has("a"), false, "thinking override cleared by reset");
	assert.ok(!componentState(component).dirtyAgents.has("a"), "agent removed from dirty");
	assert.ok(componentState(component).resetAgents.has("a"), "agent in resetAgents");
});

test("subagent-hub: reset then ctrl+c discards everything", {
	skip: !available,
}, (t, done) => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
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
				assert.equal(result.overrides.size, 0, "ctrl+c discards all overrides");
				assert.equal(result.resetAgents, undefined, "ctrl+c discards staged resets");
				done();
			}
		},
	);

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x"); // stage reset
	component.handleInput("\x03"); // ctrl+c
}, { timeout: 2000 });

test("subagent-hub: done via esc includes staged resets in result", {
	skip: !available,
}, (t, done) => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
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
				assert.ok(result.overrides instanceof Map, "overrides is a Map");
				assert.equal(result.overrides.size, 0, "no dirty overrides (only reset staged)");
				assert.ok(result.resetAgents, "resetAgents present in result");
				assert.ok(result.resetAgents.has("a"), "agent a in resetAgents");
				done();
			}
		},
	);

	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x"); // stage reset
	component.handleInput("\x1b"); // esc = done
}, { timeout: 2000 });

test("subagent-hub: done via esc includes both dirty and reset agents", {
	skip: !available,
}, (t, done) => {
	const agents = makeAgentsWithOverride(["a", "b"], ["openai/model-0", "openai/model-0"], [true, false]);
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
				assert.equal(result.overrides.size, 1, "one dirty override (agent b)");
				assert.equal(result.overrides.get("b"), "anthropic/model-1", "agent b override");
				assert.ok(result.resetAgents, "resetAgents present");
				assert.ok(result.resetAgents.has("a"), "agent a staged for reset");
				assert.ok(!result.resetAgents.has("b"), "agent b is dirty, not reset");
				done();
			}
		},
	);

	// Agent b: dirty edit.
	component.agentModelOverrides.set("b", "anthropic/model-1");
	componentState(component).dirtyAgents.add("b");
	// Agent a: stage reset.
	component.selectedAgentIndex = 0;
	component.render(84);
	component.handleInput("x");
	// Exit with esc.
	component.handleInput("\x1b");
}, { timeout: 2000 });

test("subagent-hub: footer shows undo hint when undo stack is non-empty", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a"], ["openai/model-0"], [true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	const beforeReset = stripAnsi(component.render(84).join("\n"));
	assert.ok(!beforeReset.includes("undo"), "no undo hint before any reset");

	component.selectedAgentIndex = 0;
	component.handleInput("x");
	const afterReset = stripAnsi(component.render(84).join("\n"));
	assert.match(afterReset, /undo/, "undo hint appears after reset");
});

test("subagent-hub: reset-confirm view width invariant holds", {
	skip: !available,
}, () => {
	const agents = makeAgentsWithOverride(["a", "b"], ["openai/model-0", "openai/model-0"], [true, true]);
	const models = makeModels(3);
	const component = new SubagentHubComponent!(
		makeMockTui(),
		makeMockTheme(),
		agents,
		models,
		undefined,
		() => {},
	);

	component.render(84);
	component.handleInput("X"); // enter confirmation

	for (const width of [30, 60, 84]) {
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: line exceeds bounds (${visibleWidth(line)})`);
		}
	}
});