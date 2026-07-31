import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
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

const LANE_MODELS = [
	{ provider: "openai", id: "model-0", fullId: "openai/model-0" },
	{
		provider: "deepseek",
		id: "reasoner",
		fullId: "deepseek/reasoner",
		reasoning: true,
		thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
	},
	{ provider: "vendor", id: "no-reasoning", fullId: "vendor/no-reasoning", reasoning: false },
];

type TestLaneMap = Record<string, Record<string, { model?: string; thinking?: string }>>;

interface TestLaneList {
	onSelect?: (item: { value: string }) => void;
	items: { value: string; label: string }[];
	selectedIndex: number;
}

/** Real arrow keys down to the item carrying `value`, then enter. Wraps like the component does. */
function selectByKeys(component: { handleInput(data: string): void }, list: TestLaneList | null | undefined, value: string): void {
	assert.ok(list, `list present for ${value}`);
	const index = list.items.findIndex((item) => item.value === value);
	assert.ok(index >= 0, `${value} present in the list`);
	const steps = (index - list.selectedIndex + list.items.length) % list.items.length;
	for (let i = 0; i < steps; i++) component.handleInput("\x1b[B");
	assert.equal(list.selectedIndex, index, `cursor landed on ${value}`);
	component.handleInput("\r");
}

/** Narrow accessor for the lane state driven by these tests. */
function laneState(component: unknown) {
	return component as {
		laneDrafts: { id: string; agentName: string; name: string; model: string | undefined; thinking: string | undefined }[];
		laneMessage: string | undefined;
		selectedLaneRowId: string | undefined;
		laneSelectList: TestLaneList | null;
		modelSelectList: TestLaneList | null;
		laneDeleteConfirmList: TestLaneList | null;
	};
}

function makeLaneHub(
	laneConfig: { user: TestLaneMap; project: TestLaneMap },
	onDone: (result: { laneMutations?: { kind: string; laneName: string }[] }) => void = () => {},
	agentNames: string[] = ["worker"],
) {
	assert.ok(SubagentHubComponent, "SubagentHubComponent imported");
	return new SubagentHubComponent(
		{ requestRender() {} },
		makeTheme(),
		makeAgents(agentNames),
		LANE_MODELS,
		undefined,
		onDone,
		laneConfig,
	);
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

		// Drive the shared test-only cycle seam so the agent becomes dirty and shows ✎
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

		assert.match(stripped, /Subagent Models \(2 agents · 1 override\)/, "header count visible");
		assert.match(findPlainRow(rendered, "persisted"), /●/, "persisted marker visible");
		assert.match(findPlainRow(rendered, "edited"), /✎/, "edit marker visible");
		assert.match(findPlainRow(rendered, "edited"), /thinking: inherit/, "unset thinking shown as inherit");
		assert.match(stripped, /● persisted · ✎ edited · ↺ reset/, "marker legend visible");
	});

	it("opens reset confirmation via X and cancels back to main", () => {
		const agents = makeAgents(["p1", "p2"], [true, true]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		component.render(84); // build main view
		component.handleInput("X"); // enter confirmation

		const confirmRender = component.render(84).join("\n");
		const stripped = stripAnsi(confirmRender);
		assert.match(stripped, /Reset Overrides/, "confirmation title shows");
		assert.match(stripped, /2 persisted/, "count reflects persisted agents only");
		assert.match(stripped, /Cancel/, "Cancel option visible");

		// Escape cancels back to main.
		component.handleInput("\x1b");
		const mainRender = component.render(84).join("\n");
		assert.match(stripAnsi(mainRender), /Subagent Models/, "back to main view");
		assert.doesNotMatch(stripAnsi(mainRender), /Reset Overrides/, "confirmation view gone");
	});

	it("bulk reset confirm stages resets and shows reset markers", () => {
		const agents = makeAgents(["p1", "p2", "plain"], [true, true, false]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		component.render(84); // build main view
		component.handleInput("X"); // enter confirmation
		component.render(84); // build confirmation view

		// Confirm reset.
		(component as any).resetConfirmSelectList.onSelect({ value: "reset" });

		const mainRender = component.render(84).join("\n");
		const stripped = stripAnsi(mainRender);
		assert.match(stripped, /Subagent Models/, "back to main view");
		assert.match(stripped, /2 overrides/, "header shows 2 agents with overrides");
		assert.match(findPlainRow(mainRender, "p1"), /↺/, "p1 shows reset marker");
		assert.match(findPlainRow(mainRender, "p2"), /↺/, "p2 shows reset marker");
		assert.doesNotMatch(findPlainRow(mainRender, "plain"), /↺/, "plain agent has no reset marker");
	});

	it("single reset then undo restores prior state in render", () => {
		const agents = makeAgents(["p1"], [true]);
		const models = makeModels(3);
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			() => {},
		);

		component.render(84);
		component.handleInput("x"); // stage single reset
		const resetRender = component.render(84).join("\n");
		assert.match(findPlainRow(resetRender, "p1"), /↺/, "reset marker after single reset");

		component.handleInput("u"); // undo
		const undoneRender = component.render(84).join("\n");
		assert.doesNotMatch(findPlainRow(undoneRender, "p1"), /↺/, "reset marker gone after undo");
	});

	it("reset then esc exits with staged resets in result", () => {
		const agents = makeAgents(["p1"], [true]);
		const models = makeModels(3);
		let receivedResult: any = null;
		const component = new SubagentHubComponent!(
			{ requestRender() {} },
			makeTheme(),
			agents,
			models,
			undefined,
			(result: any) => { receivedResult = result; },
		);

		component.render(84);
		component.handleInput("x"); // stage reset
		component.handleInput("\x1b"); // esc = done

		assert.ok(receivedResult, "result received on esc");
		assert.ok(receivedResult.resetAgents, "resetAgents present");
		assert.ok(receivedResult.resetAgents.has("p1"), "p1 in resetAgents");
	});

	// ── M2.2: lane views driven by real keys ──────────────────────

	it("l enters the lane list and renders project and user rows with scope labels", () => {
		const component = makeLaneHub({
			user: { worker: { normal: { model: "openai/model-0" }, mine: { model: "deepseek/reasoner" } } },
			project: { worker: { normal: { model: "vendor/no-reasoning" } } },
		});

		component.render(84);
		component.handleInput("l");
		const rendered = component.render(84).join("\n");
		const stripped = stripAnsi(rendered);

		assert.match(stripped, /Model Lanes \(worker · 3 lanes\)/, "union of project and user rows");
		assert.match(stripped, /effective · read-only/, "project row labelled effective");
		assert.match(stripped, /shadowed by project/, "same-name user row labelled shadowed");
		assert.match(stripped, /mine/, "unshadowed user row visible");
		assert.match(stripped, /n new/, "lane footer keys shown");
		assert.doesNotMatch(stripped, /tab thinking/, "agent-view footer keys are gone");
	});

	it("project lane details are read-only and expose no mutation keys", () => {
		const component = makeLaneHub({
			user: {},
			project: { worker: { normal: { model: "vendor/no-reasoning", thinking: "off" } } },
		});
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		selectByKeys(component, state.laneSelectList, "project:normal");
		const stripped = stripAnsi(component.render(84).join("\n"));

		assert.match(stripped, /Lane: normal/, "detail opened");
		assert.match(stripped, /source:   project settings/, "scope shown");
		assert.match(stripped, /read-only/, "read-only note");
		assert.doesNotMatch(stripped, /m model/, "no model key for project rows");
		assert.doesNotMatch(stripped, /r rename/, "no rename key for project rows");

		// Mutation keys are inert on a project row.
		component.handleInput("m");
		assert.match(stripAnsi(component.render(84).join("\n")), /Lane: normal/, "still on the detail view");
	});

	it("drives the lane model picker and clamps thinking on a model change", () => {
		const component = makeLaneHub({
			user: { worker: { deep: { model: "deepseek/reasoner", thinking: "high" } } },
			project: {},
		});
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		selectByKeys(component, state.laneSelectList, `user:${state.laneDrafts[0]?.id ?? ""}`);
		component.handleInput("m");
		for (const ch of "vendor") component.handleInput(ch);
		const picker = stripAnsi(component.render(84).join("\n"));
		assert.match(picker, /Lane Model \(deep\)/, "lane model picker titled by lane");
		assert.match(picker, /Search: vendor/, "typed query filters the picker");
		assert.doesNotMatch(picker, /\[deepseek\]/, "non-matching models filtered out of the list");

		selectByKeys(component, state.modelSelectList, "vendor/no-reasoning");
		const detail = stripAnsi(component.render(84).join("\n"));
		assert.match(detail, /model:    vendor\/no-reasoning/, "model updated");
		assert.match(detail, /thinking: off/, "thinking clamped to the supported level");
	});

	it("lane thinking picker offers inherit plus supported levels only", () => {
		const component = makeLaneHub({
			user: { worker: { deep: { model: "deepseek/reasoner" } } },
			project: {},
		});
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		selectByKeys(component, state.laneSelectList, `user:${state.laneDrafts[0]?.id ?? ""}`);
		component.handleInput("t");
		assert.match(stripAnsi(component.render(84).join("\n")), /Lane Thinking \(deep\)/);

		const seen: (string | undefined)[] = [];
		for (let i = 0; i < 4; i++) {
			component.handleInput("\r");
			seen.push(state.laneDrafts[0]?.thinking);
		}
		assert.deepEqual(seen, ["off", "high", "xhigh", undefined], "cycles inherit + supported levels only");
		assert.ok(!seen.includes("medium"), "unsupported levels omitted");

		component.handleInput("\x1b");
		assert.match(stripAnsi(component.render(84).join("\n")), /Lane: deep/, "esc returns to the lane detail");
	});

	it("arrow keys retarget d and enter at the row under the cursor", () => {
		const component = makeLaneHub({
			user: {
				worker: {
					alpha: { model: "openai/model-0" },
					beta: { model: "deepseek/reasoner" },
					gamma: { model: "vendor/no-reasoning" },
				},
			},
			project: {},
		});
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		const rows = state.laneSelectList?.items ?? [];
		assert.equal(rows.length, 3, "three lane rows listed");

		// ↓↓ must carry selectedLaneRowId with the visible cursor, or d deletes the wrong lane.
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		assert.equal(state.laneSelectList?.selectedIndex, 2, "cursor on the third row");
		assert.equal(state.selectedLaneRowId, rows[2]?.value, "row id tracks the cursor");

		// ↑ wraps nowhere here; it just steps back onto the second row.
		component.handleInput("\x1b[A");
		assert.equal(state.selectedLaneRowId, rows[1]?.value, "row id follows upward moves too");

		// enter opens the detail for the cursor row, not the first row.
		component.handleInput("\r");
		assert.match(
			stripAnsi(component.render(84).join("\n")),
			new RegExp(`Lane: ${rows[1]?.label}\\b`),
			"detail opened for the cursor row",
		);
		component.handleInput("\x1b"); // detail → lane list
		component.render(84);

		// d targets the same row: the confirmation must name it, and delete must remove it.
		component.handleInput("\x1b[B"); // back onto the third row
		assert.equal(state.selectedLaneRowId, rows[2]?.value);
		component.handleInput("d");
		const dialog = stripAnsi(component.render(84).join("\n"));
		assert.match(dialog, new RegExp(`Delete Lane \u2014 ${rows[2]?.label}`), "dialog names the cursor row");
		assert.doesNotMatch(dialog, new RegExp(`Delete Lane \u2014 ${rows[0]?.label}`), "not the first row");

		selectByKeys(component, state.laneDeleteConfirmList, "delete");
		assert.deepEqual(
			state.laneDrafts.map((draft) => draft.name).sort(),
			[rows[0]?.label, rows[1]?.label].sort(),
			"only the cursor row was deleted",
		);
	});
	it("delete dialog defaults to Cancel, cancels, then confirms", () => {
		const component = makeLaneHub({
			user: { worker: { normal: { model: "openai/model-0" } } },
			project: {},
		});
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		component.handleInput("d");
		const dialog = stripAnsi(component.render(84).join("\n"));
		assert.match(dialog, /Delete Lane/, "confirmation opened");
		assert.match(dialog, /Cancel/, "cancel option present");
		assert.equal(state.laneDeleteConfirmList?.selectedIndex, 1, "defaults to Cancel");

		component.handleInput("\r"); // enter on the default row = Cancel
		assert.equal(state.laneDrafts.length, 1, "cancel keeps the lane");

		component.render(84);
		component.handleInput("d");
		component.render(84);
		component.handleInput("\x1b[A"); // ↑ off the safe default onto Delete
		assert.equal(state.laneDeleteConfirmList?.selectedIndex, 0, "cursor on Delete");
		component.handleInput("\r");
		assert.equal(state.laneDrafts.length, 0, "confirm removes the draft");
		const afterDelete = stripAnsi(component.render(84).join("\n"));
		assert.match(afterDelete, /No lanes configured/, "empty lane list rendered");
		assert.match(afterDelete, /u undo/, "lane undo hint appears after a lane action");
	});

	it("emits lane mutations only when escaping from the main view", () => {
		const results: { laneMutations?: { kind: string; laneName: string }[] }[] = [];
		const component = makeLaneHub(
			{ user: { worker: { normal: { model: "openai/model-0" } } }, project: {} },
			(result) => { results.push(result); },
		);
		const state = laneState(component);

		component.render(84);
		component.handleInput("l");
		component.render(84);
		component.handleInput("d");
		component.render(84);
		selectByKeys(component, state.laneDeleteConfirmList, "delete");

		// Escape from the lane list returns to agents without closing the hub.
		component.handleInput("\x1b");
		assert.equal(results.length, 0, "lane-list esc does not finish the hub");

		component.render(84);
		component.handleInput("\x1b");
		assert.equal(results.length, 1, "main esc finishes the hub");
		assert.deepEqual(results[0]?.laneMutations, [{ kind: "remove", agentName: "worker", laneName: "normal" }]);
	});

	it("renders every lane view within width at 60, 84, and 100 columns", () => {
		const component = makeLaneHub({
			user: { worker: { "a-very-long-legacy-lane-name-for-width-checks": { model: "deepseek/reasoner", thinking: "high" } } },
			project: { worker: { "a-very-long-legacy-lane-name-for-width-checks": { model: "vendor/no-reasoning" } } },
		});
		const state = laneState(component);
		const widths = [60, 84, 100];

		const assertWidths = (label: string) => {
			for (const width of widths) {
				for (const line of component.render(width)) {
					assert.ok(visibleWidth(line) <= width, `${label} at width ${width}: line exceeds bounds`);
				}
			}
		};

		component.render(84);
		component.handleInput("l");
		assertWidths("lane list");

		component.render(84);
		state.laneSelectList?.onSelect?.({ value: `user:${state.laneDrafts[0]?.id ?? ""}` });
		assertWidths("lane detail");

		component.handleInput("r");
		assertWidths("lane name");
		component.handleInput("\x1b");

		component.render(84);
		component.handleInput("m");
		assertWidths("lane model");
		component.handleInput("\x1b");

		component.render(84);
		component.handleInput("t");
		assertWidths("lane thinking");
		component.handleInput("\x1b");

		component.render(84);
		component.handleInput("\x1b"); // detail → lane list
		component.render(84);
		component.handleInput("d");
		assertWidths("lane delete confirmation");
	});

	it("main header reports staged lane changes separately from agent overrides", () => {
		const component = makeLaneHub({
			user: { worker: { normal: { model: "openai/model-0" } } },
			project: {},
		});
		const state = laneState(component);

		const before = stripAnsi(component.render(84).join("\n"));
		assert.match(before, /Subagent Models \(1 agents · 0 overrides\)/, "count is labelled as overrides");
		assert.doesNotMatch(before, /lane edit/, "no lane segment before anything is staged");

		// Stage a lane delete with real keys, then return to the main view.
		component.handleInput("l");
		component.render(84);
		component.handleInput("d");
		component.render(84);
		state.laneDeleteConfirmList?.onSelect?.({ value: "delete" });
		component.handleInput("\x1b"); // lane list → main

		const after = stripAnsi(component.render(84).join("\n"));
		assert.match(
			after,
			/Subagent Models \(1 agents · 0 overrides · 1 lane edit\)/,
			"main view says esc will write a lane change",
		);

		for (const width of [60, 84, 100]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `main header at width ${width}: line exceeds bounds`);
			}
		}
	});

	it("lane undo is offered and applied per agent", () => {
		const component = makeLaneHub(
			{
				user: {
					worker: { fast: { model: "openai/model-0" } },
					reviewer: { deep: { model: "openai/model-0" } },
				},
				project: {},
			},
			() => {},
			["worker", "reviewer"],
		);
		const state = laneState(component);

		// Stage a delete under worker.
		component.render(84);
		component.handleInput("l");
		component.render(84);
		component.handleInput("d");
		component.render(84);
		state.laneDeleteConfirmList?.onSelect?.({ value: "delete" });
		assert.match(stripAnsi(component.render(84).join("\n")), /u undo/, "undo offered to the owning role");

		// Switch to reviewer: the key is neither advertised nor destructive there.
		component.handleInput("\x1b"); // lane list → main
		component.selectedAgentIndex = 1;
		component.render(84);
		component.handleInput("l");
		const reviewerList = stripAnsi(component.render(84).join("\n"));
		assert.match(reviewerList, /Model Lanes \(reviewer/, "reviewer lane list");
		assert.doesNotMatch(reviewerList, /u undo/, "undo hidden for a role with nothing staged");

		component.handleInput("u");
		assert.match(
			stripAnsi(component.render(84).join("\n")),
			/Nothing to undo for reviewer/,
			"explicit refusal instead of a silent cross-agent revert",
		);
		assert.equal(
			state.laneDrafts.some((draft) => draft.agentName === "worker" && draft.name === "fast"),
			false,
			"worker's staged delete survives",
		);
	});
});
