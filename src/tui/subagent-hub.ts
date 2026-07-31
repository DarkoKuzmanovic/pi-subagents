import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, SettingItem, TUI } from "@earendil-works/pi-tui";
import { Container, SelectList, SettingsList, Spacer, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../shared/model-info.ts";
import {
	resolveModelCandidate,
} from "../runs/shared/model-fallback.ts";
import { isValidModelLaneName } from "../agents/model-lanes.ts";
import type { ModelLaneMap, ModelLanePatch, UserModelLaneMutation } from "../agents/model-lanes.ts";

/** Type guard for a supported thinking-level string. */
function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}
export interface SubagentHubResult {
	overrides: Map<string, string>; // agent name → model override string
	thinkingOverrides?: Map<string, string>; // agent name → thinking level override
	resetAgents?: Set<string>; // agent names whose overrides should be removed
	laneMutations?: UserModelLaneMutation[]; // staged user-scope lane changes (removes first)
}

/** Optional lane data injected by the slash handler; project data stays read-only. */
export interface SubagentHubLaneConfig {
	user: ModelLaneMap;
	project: ModelLaneMap;
}

/** Snapshot of one agent's prior state, captured before a reset for undo. */
interface ResetSnapshot {
	agentName: string;
	modelOverride: string | undefined;     // prior map value; undefined = entry was absent
	thinkingOverride: string | undefined;  // prior map value; undefined = entry was absent
	wasDirty: boolean;
	wasReset: boolean;
}

/** A single undo transaction: one single-reset or one confirmed bulk-reset. */
interface ResetTransaction {
	snapshots: ResetSnapshot[];
}

/**
 * A staged user lane. `id` is stable across renames so undo and row selection never
 * key on the mutable name; `original*` fields carry the on-disk state used to derive
 * the minimal mutation set (undefined `originalName` = created in this session).
 */
interface LaneDraft {
	id: string;
	agentName: string;
	originalName: string | undefined;
	name: string;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	originalModel: string | undefined;
	originalThinking: ThinkingLevel | undefined;
}

/**
 * One undoable lane action: the exact draft list captured before it was applied.
 * `agentName` scopes the undo to the role that staged it, because lane undo is offered
 * per-agent and must never silently revert another role's staged work.
 */
interface LaneTransaction {
	agentName: string | undefined;
	drafts: LaneDraft[];
	selectedRowId: string | undefined;
}

/** A rendered lane row: project rows are read-only, user rows map to a draft. */
interface LaneRow {
	id: string;
	scope: "project" | "user";
	name: string;
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
	draftId: string | undefined;
	shadowed: boolean;
	legacy: boolean;
}

/** Discriminated view state — each phase adds cases as needed. */
type HubView =
	| "main"
	| "model"
	| "thinking"
	| "reset-confirm"
	| "lane-list"
	| "lane-detail"
	| "lane-name"
	| "lane-model"
	| "lane-thinking"
	| "lane-delete-confirm";

export class SubagentHubComponent implements Component {
	private readonly MODEL_SELECTOR_HEIGHT = 10;

	// Injected dependencies (explicit fields, not parameter properties, for strip-types compat)
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly agents: AgentConfig[];
	private readonly availableModels: ModelInfo[];
	private readonly preferredProvider: string | undefined;
	private readonly done: (result: SubagentHubResult) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		agents: AgentConfig[],
		availableModels: ModelInfo[],
		preferredProvider: string | undefined,
		done: (result: SubagentHubResult) => void,
		laneConfig?: SubagentHubLaneConfig,
	) {
		this.tui = tui;
		this.theme = theme;
		this.agents = agents;
		this.availableModels = availableModels;
		this.preferredProvider = preferredProvider;
		this.done = done;

		// Pre-populate overrides from existing agent model configs
		for (const agent of this.agents) {
			if (agent.model) {
				const resolved = resolveModelCandidate(
					agent.model,
					this.availableModels,
					this.preferredProvider,
				);
				if (resolved) {
					this.agentModelOverrides.set(agent.name, resolved);
				}
			}
		}

		// Seed thinking overrides from existing agent config for display.
		// Dirty tracking ensures only user-changed agents are persisted on exit.
		for (const agent of this.agents) {
			const { thinkingSuffix } = agent.model ? splitKnownThinkingSuffix(agent.model) : { thinkingSuffix: "" };
			const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
			const seeded = agent.thinking ?? suffixThinking;
			if (seeded) {
				this.agentThinkingOverrides.set(agent.name, seeded);
			}
		}

		// Project lanes stay immutable display data; user lanes become editable drafts.
		this.projectLanes = laneConfig?.project ?? {};
		for (const [agentName, laneMap] of Object.entries(laneConfig?.user ?? {})) {
			for (const [laneName, definition] of Object.entries(laneMap)) {
				this.originalUserLaneKeys.push({ agentName, name: laneName });
				this.laneDrafts.push({
					id: `lane-${this.laneDraftCounter++}`,
					agentName,
					originalName: laneName,
					name: laneName,
					model: definition.model,
					thinking: definition.thinking,
					originalModel: definition.model,
					originalThinking: definition.thinking,
				});
			}
		}
	}

	// ── State ──────────────────────────────────────────────────

	private view: HubView = "main";
	private modelAgentIndex = 0;

	selectedAgentIndex = 0;
	modelSearchQuery = "";
	modelSelectedIndex = 0;
	filteredModels: ModelInfo[] = [];
	agentModelOverrides: Map<string, string> = new Map(); // agent name → preferred fullId
	agentThinkingOverrides: Map<string, string> = new Map(); // agent name → thinking level

	/** Test seam: exposes the model-editing agent index (null when in main view). */
	get editingAgentIndex(): number | null {
		return this.view === "model" ? this.modelAgentIndex : null;
	}

	// Tracks which agents the user explicitly changed (model pick or thinking cycle).
	// Only dirty agents are included in the result on exit, preventing no-op open+esc
	// from rewriting every agent's override in settings.json.
	private dirtyAgents = new Set<string>();
	private resetAgents = new Set<string>();

	/** Undo stack: each x (single) or confirmed X (bulk) pushes one transaction. u pops LIFO. */
	private undoStack: ResetTransaction[] = [];

	// SelectList instances are created per main-view rebuild because pi-tui's SelectList has no setItems();
	// selection is restored by index after each rebuild. They are reused only for navigation within a stable view.
	private agentSelectList: SelectList | null = null;
	private modelSelectList: SelectList | null = null;
	private thinkingSelectList: SettingsList | null = null;
	private resetConfirmSelectList: SelectList | null = null;
	private laneSelectList: SelectList | null = null;
	private laneThinkingList: SettingsList | null = null;
	private laneDeleteConfirmList: SelectList | null = null;

	// ── Lane state (staged only; nothing is written from this component) ──

	private projectLanes: ModelLaneMap = {};
	private laneDrafts: LaneDraft[] = [];
	/** Every lane key present on disk at open time, used to derive removals. */
	private originalUserLaneKeys: { agentName: string; name: string }[] = [];
	private laneDraftCounter = 0;
	private selectedLaneRowId: string | undefined;
	private laneDetailRowId: string | undefined;
	/** Draft targeted by the name/model/thinking/delete flows. */
	private laneEditingDraftId: string | undefined;
	private laneNameInput = "";
	private laneNameError: string | undefined;
	private laneNameMode: "create" | "rename" = "create";
	/** Create flow: a validated name waiting for a model choice. */
	private pendingLaneName: string | undefined;
	private laneMessage: string | undefined;
	/** Lane undo is deliberately separate from the override-reset undo stack. */
	private laneUndoStack: LaneTransaction[] = [];

	// Active container tree — rebuilt only on view/data/theme transitions.
	private activeContainer: Container | null = null;
	private needsRebuild = true;

	// ── Result ─────────────────────────────────────────────────

	/** Build the result containing only agents the user actually changed. */
	private buildDirtyResult(): SubagentHubResult {
		const overrides = new Map<string, string>();
		const thinkingOverrides = new Map<string, string>();
		for (const name of this.dirtyAgents) {
			const model = this.agentModelOverrides.get(name);
			if (model !== undefined) overrides.set(name, model);
			const thinking = this.agentThinkingOverrides.get(name);
			if (thinking !== undefined) thinkingOverrides.set(name, thinking);
		}
		// Latest edit wins over a pending reset: the returned reset set must
		// not include names that are also dirty.
		const prunedResets = new Set(
			[...this.resetAgents].filter((name) => !this.dirtyAgents.has(name)),
		);
		const laneMutations = this.buildLaneMutations();
		return {
			overrides,
			thinkingOverrides,
			resetAgents: prunedResets.size > 0 ? prunedResets : undefined,
			laneMutations: laneMutations.length > 0 ? laneMutations : undefined,
		};
	}

	dispose(): void {}

	// ── Rendering ─────────────────────────────────────────────

	invalidate(): void {
		this.needsRebuild = true;
		// Invalidate existing child caches so theme changes take effect.
		this.activeContainer?.invalidate();
		this.agentSelectList?.invalidate();
		this.modelSelectList?.invalidate();
		this.thinkingSelectList?.invalidate();
		this.resetConfirmSelectList?.invalidate();
		this.laneSelectList?.invalidate();
		this.laneThinkingList?.invalidate();
		this.laneDeleteConfirmList?.invalidate();
	}

	render(width: number): string[] {
		if (this.needsRebuild || !this.activeContainer) {
			if (this.view === "model") {
				this.activeContainer = this.buildModelSelectorView();
			} else if (this.view === "thinking") {
				this.activeContainer = this.buildThinkingView();
			} else if (this.view === "reset-confirm") {
				this.activeContainer = this.buildResetConfirmView();
			} else if (this.view === "lane-list") {
				this.activeContainer = this.buildLaneListView();
			} else if (this.view === "lane-detail") {
				this.activeContainer = this.buildLaneDetailView();
			} else if (this.view === "lane-name") {
				this.activeContainer = this.buildLaneNameView();
			} else if (this.view === "lane-model") {
				this.activeContainer = this.buildLaneModelView();
			} else if (this.view === "lane-thinking") {
				this.activeContainer = this.buildLaneThinkingView();
			} else if (this.view === "lane-delete-confirm") {
				this.activeContainer = this.buildLaneDeleteConfirmView();
			} else {
				this.activeContainer = this.buildMainView();
			}
			this.needsRebuild = false;
		}

		const lines = this.activeContainer.render(width);
		// Final invariant guard: no line may exceed the available width.
		// truncateToWidth strips ANSI before measuring and re-applies no ellipsis.
		return lines.map((line) => {
			if (visibleWidth(line) <= width) return line;
			return truncateToWidth(line, width, "");
		});
	}

	// ── Input ─────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.view === "model") {
			this.handleModelSelectorInput(data);
			return;
		}

		if (this.view === "thinking") {
			this.handleThinkingViewInput(data);
			return;
		}

		if (this.view === "reset-confirm") {
			this.handleResetConfirmInput(data);
			return;
		}

		if (this.view === "lane-list") {
			this.handleLaneListInput(data);
			return;
		}

		if (this.view === "lane-detail") {
			this.handleLaneDetailInput(data);
			return;
		}

		if (this.view === "lane-name") {
			this.handleLaneNameInput(data);
			return;
		}

		if (this.view === "lane-model") {
			this.handleLaneModelInput(data);
			return;
		}

		if (this.view === "lane-thinking") {
			this.handleLaneThinkingInput(data);
			return;
		}

		if (this.view === "lane-delete-confirm") {
			this.handleLaneDeleteConfirmInput(data);
			return;
		}

		// Main view: delegate navigation/selection to SelectList
		if (this.agentSelectList) {
			// ctrl+c = hard cancel (discard all overrides)
			if (matchesKey(data, "ctrl+c")) {
				this.done({ overrides: new Map() });
				return;
			}
			// esc = done (apply only dirty overrides + staged resets)
			if (matchesKey(data, "escape")) {
				this.done(this.buildDirtyResult());
				return;
			}
			if (matchesKey(data, "tab")) {
				this.enterThinkingView();
				return;
			}
			if (data === "x") {
				this.resetSelectedAgent();
				this.tui.requestRender();
				return;
			}
			if (data === "X") {
				this.enterResetConfirmView();
				return;
			}
			if (data === "u") {
				this.undoLastReset();
				this.tui.requestRender();
				return;
			}
			// `l` must be intercepted before delegation: SelectList ignores printable
			// letters today, but the lane entry point must not depend on that.
			if (data === "l") {
				this.enterLaneList();
				return;
			}
			// Everything else (up/down/enter/search) goes to SelectList.
			// Navigation does NOT trigger a rebuild — the SelectList handles
			// its own rendering and selection state internally.
			this.agentSelectList.handleInput(data);
			this.tui.requestRender();
			return;
		}

		// No SelectList (shouldn't happen, but fallback)
		if (matchesKey(data, "escape")) {
			this.done(this.buildDirtyResult());
		} else if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
		}
	}

	/** Handle input when in model selector mode (public for testability) */
	handleModelSelectorInput(data: string): void {
		// ctrl+c = hard cancel everything (discard all overrides, close hub)
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}

		// esc = cancel model change, return to agent list
		if (matchesKey(data, "escape")) {
			this.exitModelSelector();
			return;
		}

		// Backspace: remove last char from search query
		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			this.tui.requestRender();
			return;
		}

		// Printable characters (single keystroke or paste): append to search query
		if (data.length >= 1 && /^[\x20-\x7e]+$/.test(data)) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}

		// Navigation/selection keys: delegate to SelectList if available
		if (this.modelSelectList) {
			this.modelSelectList.handleInput(data);
			this.tui.requestRender();
			return;
		}
	}

	/** Handle input when in thinking view (public for testability) */
	handleThinkingViewInput(data: string): void {
		// ctrl+c = hard cancel everything (discard all overrides, close hub)
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}

		// esc = return to main view (do NOT save or close the hub)
		if (matchesKey(data, "escape")) {
			this.exitThinkingView();
			return;
		}

		// Everything else goes to SettingsList
		if (this.thinkingSelectList) {
			this.thinkingSelectList.handleInput?.(data);
			this.tui.requestRender();
			return;
		}
	}

	/** Handle input when in reset-confirm view (public for testability) */
	handleResetConfirmInput(data: string): void {
		// ctrl+c = hard cancel everything (discard all overrides, close hub)
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}

		// esc = cancel confirmation, return to main WITHOUT resetting
		if (matchesKey(data, "escape")) {
			this.exitResetConfirmView();
			return;
		}

		// Everything else goes to the confirmation SelectList
		if (this.resetConfirmSelectList) {
			this.resetConfirmSelectList.handleInput(data);
			this.tui.requestRender();
			return;
		}
	}

	// ── View builders ──────────────────────────────────────────

	private buildMainView(): Container {
		const th = this.theme;
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		// The header must say exactly what Escape will write. The first count covers agent
		// overrides only; staged lane changes are a separate domain and get their own segment.
		const overrideCount = new Set([...this.dirtyAgents, ...this.resetAgents]).size;
		const laneChangeCount = this.buildLaneMutations().length;
		const laneSegment = laneChangeCount > 0
			? ` \u00b7 ${laneChangeCount} lane edit${laneChangeCount === 1 ? "" : "s"}`
			: "";
		container.addChild(new Text(th.fg("accent", th.bold(` Subagent Models (${this.agents.length} agents \u00b7 ${overrideCount} override${overrideCount === 1 ? "" : "s"}${laneSegment})`)), 1, 0));
		container.addChild(new Spacer(1));

		if (this.agents.length === 0) {
			container.addChild(new Text(th.fg("dim", " No subagents found"), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(
				this.formatFooter("esc", "done"),
				1, 0,
			));
			container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
			return container;
		}

		const items: SelectItem[] = this.agents.map((agent) => {
			const override = this.agentModelOverrides.get(agent.name);
			const effectiveModel = override ?? this.resolveAgentEffectiveModel(agent);
			const { baseModel } = splitKnownThinkingSuffix(effectiveModel);
			const thinking = this.formatThinkingDisplay(agent, effectiveModel);
			const modelDisplay = baseModel || "(host default)";
			const markers = this.formatAgentMarkers(agent);
			const fallbackCount = agent.fallbackModels?.length ?? 0;
			const fallbackTag = fallbackCount > 0 ? `  +${fallbackCount} fallback${fallbackCount > 1 ? "s" : ""}` : "";
			const desc = `${modelDisplay}${markers ? `  ${markers}` : ""}  ·  ${th.fg("dim", "thinking:")} ${th.fg(thinking.colorKey, thinking.text)}${fallbackTag}`;
			return {
				value: agent.name,
				label: agent.name,
				description: desc,
			};
		});

		const selectTheme = this.getSelectListTheme();
		// Recreate the SelectList on every main-view rebuild because pi-tui's SelectList has no setItems();
		// once constructed, its item content is fixed. Selection is preserved by restoring selectedAgentIndex.
		this.agentSelectList = new SelectList(items, Math.min(items.length, 15), selectTheme);
		this.agentSelectList.setSelectedIndex(this.selectedAgentIndex);

		// Sync selectedAgentIndex when user navigates up/down
		this.agentSelectList.onSelectionChange = (item: SelectItem) => {
			const agentIndex = this.agents.findIndex((a) => a.name === item.value);
			if (agentIndex >= 0) this.selectedAgentIndex = agentIndex;
		};

		// Wire onSelect: enter opens model picker for selected agent
		this.agentSelectList.onSelect = (item: SelectItem) => {
			const agentIndex = this.agents.findIndex((a) => a.name === item.value);
			if (agentIndex >= 0) {
				// Sync selected index from SelectList state
				this.selectedAgentIndex = agentIndex;
				this.enterModelSelector(agentIndex);
			}
		};

		// Wire onCancel: SelectList cancel (esc) = done, apply dirty overrides
		this.agentSelectList.onCancel = () => {
			this.done(this.buildDirtyResult());
		};

		container.addChild(this.agentSelectList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("↑↓", "navigate", "enter", "model", "tab", "thinking", "l", "lanes", "x", "reset", "X", "bulk")
				+ (this.undoStack.length > 0 ? th.fg("dim", " • ") + rawKeyHint("u", "undo") : ""),
			1, 0,
		));
		container.addChild(new Text(
			this.formatFooter("esc", "done", "ctrl+c", "cancel") + th.fg("dim", " · ") + this.formatMarkerLegend(),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildModelSelectorView(): Container {
		const th = this.theme;
		const container = new Container();

		const agentName = this.agents[this.modelAgentIndex]?.name ?? "unknown";

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(` Select Model (${agentName})`)), 1, 0));

		// Search line
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		container.addChild(new Text(th.fg("dim", " Search: ") + this.modelSearchQuery + cursor, 1, 0));

		// Current model
		const agent = this.agents[this.modelAgentIndex];
		const currentModel = agent
			? (this.agentModelOverrides.get(agent.name) ??
					this.resolveAgentEffectiveModel(agent))
			: "";
		const { baseModel: currentBase } = splitKnownThinkingSuffix(currentModel);
		const currentThinking = agent ? this.formatThinkingDisplay(agent, currentModel) : { text: "inherit", colorKey: "dim" };
		container.addChild(new Text(
			th.fg("dim", " Current: ") + th.fg("warning", currentBase || "(host default)") + th.fg("dim", " · thinking: ") + th.fg(currentThinking.colorKey, currentThinking.text),
			1, 0,
		));
		container.addChild(new Spacer(1));

		if (this.filteredModels.length === 0) {
			this.modelSelectList = null;
			container.addChild(new Text(th.fg("muted", " No matching models"), 1, 0));
		} else {
			const { baseModel } = splitKnownThinkingSuffix(currentModel);
			const items: SelectItem[] = this.filteredModels.map((model) => {
				const isCurrent =
					model.fullId === baseModel ||
					model.id === baseModel;
				const supported = getSupportedThinkingLevels(model);
				const levelsText = supported.length > 0 ? ` · ${supported.join("/")}` : "";
				const desc = `[${model.provider}]${isCurrent ? " current" : ""}${levelsText}`;
				return {
					value: model.fullId,
					label: model.id,
					description: desc,
				};
			});

			const selectTheme = this.getSelectListTheme();
			if (!this.modelSelectList) {
				this.modelSelectList = new SelectList(items, Math.min(items.length, this.MODEL_SELECTOR_HEIGHT), selectTheme);
			}
			this.modelSelectList.setSelectedIndex(this.modelSelectedIndex);

			// Sync modelSelectedIndex when user navigates up/down
			this.modelSelectList.onSelectionChange = (item: SelectItem) => {
				const idx = this.filteredModels.findIndex((m) => m.fullId === item.value);
				if (idx >= 0) this.modelSelectedIndex = idx;
			};

			// Wire onSelect: enter selects model and returns to agent list
			this.modelSelectList.onSelect = (item: SelectItem) => {
				const selectedAgent = this.agents[this.modelAgentIndex];
				if (selectedAgent) {
					const prevModel = this.agentModelOverrides.get(selectedAgent.name) ?? this.resolveAgentEffectiveModel(selectedAgent);
					const { thinkingSuffix } = splitKnownThinkingSuffix(prevModel);
					const requestedLevel = thinkingSuffix.slice(1);
					const selectedModelInfo = findModelInfo(item.value, this.availableModels, this.preferredProvider);
					const supportedLevels = getSupportedThinkingLevels(selectedModelInfo);
					const suffix = supportedLevels.some((level) => level === requestedLevel) ? thinkingSuffix : "";
					this.agentModelOverrides.set(selectedAgent.name, `${item.value}${suffix}`);
					this.dirtyAgents.add(selectedAgent.name);

					// Edit wins over reset: remove from pending resets.
					this.resetAgents.delete(selectedAgent.name);

					// Clamp the separate thinking override if the new model doesn't support it
					const currentThinking = this.agentThinkingOverrides.get(selectedAgent.name);
					const clamped = this.clampThinkingForModel(currentThinking, item.value);
					if (clamped !== undefined) {
						this.agentThinkingOverrides.set(selectedAgent.name, clamped);
					}
				}
				this.exitModelSelector();
			};

			// Wire onCancel: SelectList cancel (esc) = back to agent list
			this.modelSelectList.onCancel = () => {
				this.exitModelSelector();
			};

			container.addChild(this.modelSelectList);
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter(...(this.filteredModels.length > 0 ? ["enter", "select"] : []), "type", "search"),
			1, 0,
		));
		container.addChild(new Text(
			this.formatFooter("esc", "back", "ctrl+c", "cancel"),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildThinkingView(): Container {
		const th = this.theme;
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(" Thinking Levels")), 1, 0));
		container.addChild(new Spacer(1));

		const items: SettingItem[] = this.agents.map((agent) => {
			const effectiveModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
			const modelInfo = findModelInfo(effectiveModel, this.availableModels, this.preferredProvider);
			const supportedLevels: string[] = getSupportedThinkingLevels(modelInfo);
			const { thinkingSuffix } = agent.model ? splitKnownThinkingSuffix(effectiveModel) : { thinkingSuffix: "" };
			const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
			const overridden = this.agentThinkingOverrides.get(agent.name);
			const effectiveThinking = overridden ?? agent.thinking ?? suffixThinking ?? "off";
			// Map to a legal value without dirtying: use the effective level if supported,
			// otherwise "off" (or first supported if "off" is absent).
			const currentValue = (isThinkingLevel(effectiveThinking) && supportedLevels.includes(effectiveThinking))
				? effectiveThinking
				: (supportedLevels.includes("off") ? "off" : (supportedLevels[0] ?? "off"));
			const { baseModel } = splitKnownThinkingSuffix(effectiveModel);
			const modelDisplay = baseModel || "(host default)";
			return {
				id: agent.name,
				label: `${agent.name}  \u00b7  ${modelDisplay}`,
				currentValue,
				values: supportedLevels,
			};
		});

		this.thinkingSelectList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id: string, newValue: string) => this.handleThinkingChange(id, newValue),
			() => this.exitThinkingView(),
			{ enableSearch: true },
		);

		container.addChild(this.thinkingSelectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("\u2191\u2193", "navigate", "enter", "cycle", "type", "search"),
			1, 0,
		));
		container.addChild(new Text(
			this.formatFooter("esc", "back", "ctrl+c", "cancel"),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	// ── Footer hint formatting (uses rawKeyHint for platform-aware key display) ──

	/** Format footer hints using rawKeyHint, pairs of (key, description). */
	private formatFooter(...pairs: string[]): string {
		const th = this.theme;
		const separator = th.fg("dim", " • ");
		const hints: string[] = [];
		for (let i = 0; i < pairs.length; i += 2) {
			const key = pairs[i];
			const desc = pairs[i + 1];
			if (key === undefined || desc === undefined) break;
			hints.push(rawKeyHint(key, desc));
		}
		return hints.join(separator);
	}

	// ── Display helpers ────────────────────────────────────────

	/** Map a ThinkingLevel to its Pi theme color key. Exhaustive switch. */
	private thinkingColorKey(level: ThinkingLevel): "thinkingOff" | "thinkingMinimal" | "thinkingLow" | "thinkingMedium" | "thinkingHigh" | "thinkingXhigh" | "thinkingMax" {
		switch (level) {
			case "off": return "thinkingOff";
			case "minimal": return "thinkingMinimal";
			case "low": return "thinkingLow";
			case "medium": return "thinkingMedium";
			case "high": return "thinkingHigh";
			case "xhigh": return "thinkingXhigh";
			case "max": return "thinkingMax";
		}
	}

	/** Format the marker glyphs for an agent row using the documented semantics. */
	private formatAgentMarkers(agent: AgentConfig): string {
		const th = this.theme;
		const markers: string[] = [];
		if (agent.override !== undefined) markers.push(th.fg("accent", "●"));
		if (this.resetAgents.has(agent.name)) {
			markers.push(th.fg("warning", "↺"));
		} else if (this.dirtyAgents.has(agent.name)) {
			markers.push(th.fg("warning", "✎"));
		}
		return markers.join("");
	}

	/** Compute the active thinking display for an agent: explicit level (colored) or dim "inherit". */
	private formatThinkingDisplay(agent: AgentConfig, effectiveModel: string): { text: string; colorKey: string } {
		const { thinkingSuffix } = splitKnownThinkingSuffix(effectiveModel);
		const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
		const overridden = this.agentThinkingOverrides.get(agent.name);
		const effectiveThinking = overridden ?? agent.thinking ?? suffixThinking;
		if (effectiveThinking === undefined) {
			return { text: "inherit", colorKey: "dim" };
		}
		const colorKey = isThinkingLevel(effectiveThinking) ? this.thinkingColorKey(effectiveThinking) : "muted";
		return { text: effectiveThinking, colorKey };
	}

	/** Compact marker legend for the main footer. */
	private formatMarkerLegend(): string {
		const th = this.theme;
		return th.fg("accent", "● persisted") + th.fg("dim", " · ") + th.fg("warning", "✎ edited") + th.fg("dim", " · ") + th.fg("warning", "↺ reset");
	}

	/** Sort models by provider then id, with preferredProvider first. */
	private sortModelsByProvider(models: ModelInfo[]): ModelInfo[] {
		return [...models].sort((a, b) => {
			if (this.preferredProvider) {
				const aPref = a.provider === this.preferredProvider;
				const bPref = b.provider === this.preferredProvider;
				if (aPref !== bPref) return aPref ? -1 : 1;
			}
			const providerCmp = a.provider.localeCompare(b.provider);
			if (providerCmp !== 0) return providerCmp;
			return a.id.localeCompare(b.id);
		});
	}

	/** Get a SelectList theme matching Pi's getSelectListTheme(), using the local theme. */
	private getSelectListTheme() {
		const th = this.theme;
		return {
			selectedPrefix: (s: string) => th.fg("accent", s),
			selectedText: (s: string) => th.fg("accent", s),
			description: (s: string) => th.fg("muted", s),
			scrollInfo: (s: string) => th.fg("dim", s),
			noMatch: (s: string) => th.fg("warning", s),
		};
	}

	// ── Model selection helpers ────────────────────────────────

	private resolveAgentEffectiveModel(agent: AgentConfig): string {
		if (agent.model) {
			const resolved = resolveModelCandidate(
				agent.model,
				this.availableModels,
				this.preferredProvider,
			);
			if (resolved) return resolved;
			return agent.model;
		}
		// No model configured — return empty; display will show "(host default)"
		return "";
	}

	/** Cycle thinking level for the selected agent. TEST-ONLY SEAM: the UI cycle now lives inside the SettingsList's values iteration (tab opens the thinking view); this method validates the shared cycle-computation + applyThinkingChange mutation tail. */
	cycleThinkingLevel(): void {
		const agent = this.agents[this.selectedAgentIndex];
		if (!agent) return;

		const effectiveModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
		const modelInfo = findModelInfo(effectiveModel, this.availableModels, this.preferredProvider);
		const availableLevels: ThinkingLevel[] = getSupportedThinkingLevels(modelInfo);

		if (availableLevels.length === 0) return;

		const { thinkingSuffix } = splitKnownThinkingSuffix(effectiveModel);
		const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
		const overridden = this.agentThinkingOverrides.get(agent.name);
		const currentThinking = overridden ?? agent.thinking ?? suffixThinking ?? "off";

		const currentIndex = isThinkingLevel(currentThinking) ? availableLevels.indexOf(currentThinking) : -1;
		if (currentIndex >= 0 && availableLevels.length === 1) return;
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % availableLevels.length;
		const nextLevel = availableLevels[nextIndex];

		this.applyThinkingChange(agent, nextLevel);
		this.needsRebuild = true;
	}

	/** Shared mutation: set a thinking override, mark dirty, remove from resets, pin model if configured. */
	private applyThinkingChange(agent: AgentConfig, level: string): void {
		this.agentThinkingOverrides.set(agent.name, level);
		this.dirtyAgents.add(agent.name);
		this.resetAgents.delete(agent.name);

		// Pin the resolved model so that a thinking-only change persists with its
		// companion model override. Only pin when the agent already has a configured
		// model — model-less agents inherit the host default.
		if (!this.agentModelOverrides.has(agent.name) && agent.model) {
			const effectiveModel = this.resolveAgentEffectiveModel(agent);
			const { baseModel } = splitKnownThinkingSuffix(effectiveModel);
			this.agentModelOverrides.set(agent.name, baseModel);
		}
	}

	/** SettingsList onChange: apply the thinking change and request a re-render. Does NOT set needsRebuild — the live SettingsList repaints its own row via requestRender; a full main-view rebuild is deferred until exitThinkingView (unlike the cycleThinkingLevel test seam, which has no live list). */
	private handleThinkingChange(agentName: string, newValue: string): void {
		const agent = this.agents.find((a) => a.name === agentName);
		if (!agent) return;
		this.applyThinkingChange(agent, newValue);
		this.tui.requestRender();
	}

	/** Reset the selected agent's persisted override, staging a reversible transaction. */
	private resetSelectedAgent(): void {
		const agent = this.agents[this.selectedAgentIndex];
		if (!agent) return;
		// Only meaningful for agents that actually have a persisted override
		if (!agent.override) return;
		// Already staged for reset — a second x is a no-op (one u fully unwinds it).
		if (this.resetAgents.has(agent.name)) return;
		// Capture prior state for undo before mutating.
		const snapshot: ResetSnapshot = {
			agentName: agent.name,
			modelOverride: this.agentModelOverrides.get(agent.name),
			thinkingOverride: this.agentThinkingOverrides.get(agent.name),
			wasDirty: this.dirtyAgents.has(agent.name),
			wasReset: this.resetAgents.has(agent.name),
		};
		this.undoStack.push({ snapshots: [snapshot] });
		// Clear conflicting session edits (reset wins over edit).
		this.agentModelOverrides.delete(agent.name);
		this.agentThinkingOverrides.delete(agent.name);
		this.dirtyAgents.delete(agent.name);
		this.resetAgents.add(agent.name);
		this.invalidate();
	}

	/** Enter model selector mode */
	enterModelSelector(agentIndex: number): void {
		this.view = "model";
		this.modelAgentIndex = agentIndex;
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = this.sortModelsByProvider([...this.availableModels]);
		this.modelSelectList = null;

		// Find current model of that agent in list
		const agent = this.agents[agentIndex];
		if (agent) {
			const currentModel = this.agentModelOverrides.get(agent.name) ??
				this.resolveAgentEffectiveModel(agent);
			const { baseModel } = splitKnownThinkingSuffix(currentModel);
			const currentIndex = this.filteredModels.findIndex(
				(m) => m.fullId === baseModel || m.id === baseModel,
			);
			if (currentIndex >= 0) {
				this.modelSelectedIndex = currentIndex;
			}
		}

		this.invalidate();
		this.tui.requestRender();
	}

	/** Exit model selector and return to main view */
	exitModelSelector(): void {
		this.view = "main";
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = this.sortModelsByProvider([...this.availableModels]);
		this.modelSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Enter the thinking view (test seam; tab from main opens this) */
	enterThinkingView(): void {
		this.view = "thinking";
		this.thinkingSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Exit the thinking view and return to main (test seam; escape/onClose returns here) */
	exitThinkingView(): void {
		this.view = "main";
		this.thinkingSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	// ── Bulk reset + undo (Phase 5) ───────────────────────────

	/** Enter the reset-confirm view with a Pi-framed SelectList (test seam; X from main opens this). */
	enterResetConfirmView(): void {
		// No-op when nothing is persisted — avoid opening a pointless "Reset 0" dialog.
		if (this.agents.every((a) => a.override === undefined)) return;
		this.view = "reset-confirm";
		this.resetConfirmSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Exit the reset-confirm view and return to main WITHOUT resetting (test seam). */
	exitResetConfirmView(): void {
		this.view = "main";
		this.resetConfirmSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Build the reset-confirmation view: a SelectList with two options. */
	private buildResetConfirmView(): Container {
		const th = this.theme;
		const container = new Container();

		const targetAgents = this.agents.filter((a) => a.override !== undefined);
		const count = targetAgents.length;

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(
			th.fg("accent", th.bold(` Reset Overrides`)) + th.fg("dim", ` — ${count} persisted agent${count === 1 ? "" : "s"}`),
			1, 0,
		));
		container.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{ value: "reset", label: `Reset ${count} persisted override${count === 1 ? "" : "s"}`, description: "stage for removal on exit" },
			{ value: "cancel", label: "Cancel", description: "return without resetting" },
		];
		const selectTheme = this.getSelectListTheme();
		this.resetConfirmSelectList = new SelectList(items, 2, selectTheme);
		this.resetConfirmSelectList.setSelectedIndex(1); // default to Cancel for safety

		this.resetConfirmSelectList.onSelect = (item: SelectItem) => {
			if (item.value === "reset") {
				this.performBulkReset();
			} else {
				this.exitResetConfirmView();
			}
		};

		this.resetConfirmSelectList.onCancel = () => {
			this.exitResetConfirmView();
		};

		container.addChild(this.resetConfirmSelectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("↑↓", "navigate", "enter", "confirm") + th.fg("dim", " • ") + this.formatFooter("esc", "back", "ctrl+c", "cancel"),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	/** Stage a bulk reset for all agents with persisted override metadata. Pushes one undo transaction if there are targets. */
	private performBulkReset(): void {
		const targetAgents = this.agents.filter((a) => a.override !== undefined);
		if (targetAgents.length === 0) {
			this.exitResetConfirmView();
			return;
		}
		const snapshots: ResetSnapshot[] = targetAgents.map((agent) => ({
			agentName: agent.name,
			modelOverride: this.agentModelOverrides.get(agent.name),
			thinkingOverride: this.agentThinkingOverrides.get(agent.name),
			wasDirty: this.dirtyAgents.has(agent.name),
			wasReset: this.resetAgents.has(agent.name),
		}));
		this.undoStack.push({ snapshots });
		for (const agent of targetAgents) {
			// Clear conflicting session edits (reset wins over edit).
			this.agentModelOverrides.delete(agent.name);
			this.agentThinkingOverrides.delete(agent.name);
			this.dirtyAgents.delete(agent.name);
			this.resetAgents.add(agent.name);
		}
		this.exitResetConfirmView();
	}

	/**
	 * Undo the most recent reset transaction (LIFO), restoring the exact snapshot
	 * taken at reset time. Note: an edit made AFTER a reset is clobbered by undo —
	 * e.g. reset A → edit A → undo returns A to its pre-reset state, discarding the
	 * post-reset edit. Intentional: undo restores the captured snapshot, it is not a
	 * general edit history. The stack is discarded when the hub closes.
	 */
	private undoLastReset(): void {
		const transaction = this.undoStack.pop();
		if (!transaction) return;
		for (const snap of transaction.snapshots) {
			// Restore model override map entry.
			if (snap.modelOverride !== undefined) {
				this.agentModelOverrides.set(snap.agentName, snap.modelOverride);
			} else {
				this.agentModelOverrides.delete(snap.agentName);
			}
			// Restore thinking override map entry.
			if (snap.thinkingOverride !== undefined) {
				this.agentThinkingOverrides.set(snap.agentName, snap.thinkingOverride);
			} else {
				this.agentThinkingOverrides.delete(snap.agentName);
			}
			// Restore dirty/reset membership.
			if (snap.wasDirty) {
				this.dirtyAgents.add(snap.agentName);
			} else {
				this.dirtyAgents.delete(snap.agentName);
			}
			if (snap.wasReset) {
				this.resetAgents.add(snap.agentName);
			} else {
				this.resetAgents.delete(snap.agentName);
			}
		}
		this.invalidate();
	}

	/** Filter models based on search query using fuzzy matching. */
	filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		const source = this.sortModelsByProvider([...this.availableModels]);
		const nextFiltered = query
			? fuzzyFilter(source, query, (m) => `${m.provider} ${m.id} ${m.fullId}`)
			: source;

		const previousFullId = this.filteredModels[this.modelSelectedIndex]?.fullId;
		const itemsChanged =
			nextFiltered.length !== this.filteredModels.length ||
			nextFiltered.some((m, i) => m.fullId !== this.filteredModels[i]?.fullId);

		this.filteredModels = nextFiltered;

		if (itemsChanged) {
			this.modelSelectList = null;
			if (previousFullId) {
				const newIndex = this.filteredModels.findIndex((m) => m.fullId === previousFullId);
				this.modelSelectedIndex = newIndex >= 0 ? newIndex : 0;
			} else {
				this.modelSelectedIndex = 0;
			}
		}

		this.modelSelectedIndex = Math.min(
			this.modelSelectedIndex,
			Math.max(0, this.filteredModels.length - 1),
		);
		this.invalidate();
	}

	// ── Lane editing (M2.2: staged only — this component never writes) ──

	/**
	 * Clamp a thinking level to what `modelFullId` supports. Shared by the agent model
	 * picker and the lane model picker so capability logic exists in exactly one place.
	 */
	private clampThinkingForModel(current: string | undefined, modelFullId: string): ThinkingLevel | undefined {
		if (!current) return undefined;
		const modelInfo = findModelInfo(modelFullId, this.availableModels, this.preferredProvider);
		const supported: ThinkingLevel[] = getSupportedThinkingLevels(modelInfo);
		if (isThinkingLevel(current) && supported.includes(current)) return current;
		return supported.includes("off") ? "off" : (supported[0] ?? "off");
	}

	private laneAgentName(): string | undefined {
		return this.agents[this.selectedAgentIndex]?.name;
	}

	private findLaneDraft(draftId: string | undefined): LaneDraft | undefined {
		if (draftId === undefined) return undefined;
		return this.laneDrafts.find((draft) => draft.id === draftId);
	}

	/** Union of project and user lanes for the selected role, with scope-qualified row ids. */
	private laneRows(): LaneRow[] {
		const agentName = this.laneAgentName();
		if (agentName === undefined) return [];
		const projectMap = this.projectLanes[agentName] ?? {};
		const projectNames = new Set(Object.keys(projectMap));
		const rows: LaneRow[] = [];
		for (const [name, definition] of Object.entries(projectMap)) {
			rows.push({
				id: `project:${name}`,
				scope: "project",
				name,
				model: definition.model,
				thinking: definition.thinking,
				draftId: undefined,
				shadowed: false,
				legacy: false,
			});
		}
		for (const draft of this.laneDrafts) {
			if (draft.agentName !== agentName) continue;
			rows.push({
				id: `user:${draft.id}`,
				scope: "user",
				name: draft.name,
				model: draft.model,
				thinking: draft.thinking,
				draftId: draft.id,
				shadowed: projectNames.has(draft.name),
				legacy: !isValidModelLaneName(draft.name),
			});
		}
		rows.sort((a, b) => {
			const byName = a.name.localeCompare(b.name);
			if (byName !== 0) return byName;
			if (a.scope === b.scope) return 0;
			return a.scope === "project" ? -1 : 1;
		});
		return rows;
	}

	/**
	 * Derive the minimal user-scope mutation list by diffing stable drafts against their
	 * originals. Removals are emitted first because the store rejects an upsert onto a lane
	 * name that still exists, so a freed name can be reused in the same batch. Rename targets
	 * still occupied by another pending draft are deferred until that draft has moved.
	 */
	private buildLaneMutations(): UserModelLaneMutation[] {
		const key = (agentName: string, laneName: string): string => `${agentName}\u0000${laneName}`;
		const liveOriginals = new Set<string>();
		for (const draft of this.laneDrafts) {
			if (draft.originalName !== undefined) liveOriginals.add(key(draft.agentName, draft.originalName));
		}

		const removes: UserModelLaneMutation[] = [];
		const occupied = new Set<string>();
		for (const original of this.originalUserLaneKeys) {
			const id = key(original.agentName, original.name);
			if (liveOriginals.has(id)) {
				occupied.add(id);
				continue;
			}
			removes.push({ kind: "remove", agentName: original.agentName, laneName: original.name });
		}

		const pending: { mutation: UserModelLaneMutation; targetKey: string; sourceKey: string | undefined }[] = [];
		for (const draft of this.laneDrafts) {
			const targetKey = key(draft.agentName, draft.name);
			if (draft.originalName === undefined) {
				const patch: ModelLanePatch = {};
				if (draft.model !== undefined) patch.model = draft.model;
				if (draft.thinking !== undefined) patch.thinking = draft.thinking;
				pending.push({
					mutation: { kind: "upsert", agentName: draft.agentName, laneName: draft.name, patch },
					targetKey,
					sourceKey: undefined,
				});
				continue;
			}
			const renamed = draft.name !== draft.originalName;
			const modelChanged = draft.model !== draft.originalModel;
			const thinkingChanged = draft.thinking !== draft.originalThinking;
			if (!renamed && !modelChanged && !thinkingChanged) continue;
			const patch: ModelLanePatch = {};
			if (modelChanged) patch.model = draft.model ?? null;
			if (thinkingChanged) patch.thinking = draft.thinking ?? null;
			pending.push({
				mutation: {
					kind: "upsert",
					agentName: draft.agentName,
					laneName: draft.name,
					originalLaneName: draft.originalName,
					patch,
				},
				targetKey,
				sourceKey: key(draft.agentName, draft.originalName),
			});
		}

		const upserts: UserModelLaneMutation[] = [];
		const remaining = [...pending];
		let progressed = true;
		while (remaining.length > 0 && progressed) {
			progressed = false;
			for (let i = 0; i < remaining.length; i++) {
				const entry = remaining[i];
				if (!entry) continue;
				const blocked = occupied.has(entry.targetKey) && entry.sourceKey !== entry.targetKey;
				if (blocked) continue;
				if (entry.sourceKey !== undefined) occupied.delete(entry.sourceKey);
				occupied.add(entry.targetKey);
				upserts.push(entry.mutation);
				remaining.splice(i, 1);
				progressed = true;
				break;
			}
		}
		// The ordering loop resolves every dependency it can. Anything left is a true rename
		// cycle, which the store resolves atomically; emit the remainder in draft order rather
		// than silently dropping a staged change. Do not break cycles here — that would
		// double-handle what the store already owns.
		for (const entry of remaining) upserts.push(entry.mutation);

		return [...removes, ...upserts];
	}

	/** Test seam: the lane mutations that Escape from main would return right now. */
	get stagedLaneMutations(): UserModelLaneMutation[] {
		return this.buildLaneMutations();
	}

	private pushLaneTransaction(): void {
		this.laneUndoStack.push({
			agentName: this.laneAgentName(),
			drafts: this.laneDrafts.map((draft) => ({ ...draft })),
			selectedRowId: this.selectedLaneRowId,
		});
	}

	/** True when the newest lane transaction was staged under the currently selected role. */
	private canUndoLaneAction(): boolean {
		const top = this.laneUndoStack[this.laneUndoStack.length - 1];
		return top !== undefined && top.agentName === this.laneAgentName();
	}

	/**
	 * Undo the latest staged lane action for the selected role (LIFO). A transaction staged
	 * under another role is left alone: popping it would discard staged work with no visible
	 * change in this view. Never touches the override-reset stack.
	 */
	undoLastLaneAction(): void {
		const agentName = this.laneAgentName();
		if (!this.canUndoLaneAction()) {
			this.laneMessage = `Nothing to undo for ${agentName ?? "this agent"}.`;
			this.invalidate();
			return;
		}
		const transaction = this.laneUndoStack.pop();
		if (!transaction) return;
		// Restore only this role's drafts; every other role keeps its staged state.
		const others = this.laneDrafts.filter((draft) => draft.agentName !== agentName);
		const restored = transaction.drafts
			.filter((draft) => draft.agentName === agentName)
			.map((draft) => ({ ...draft }));
		this.laneDrafts = [...others, ...restored];
		this.selectedLaneRowId = transaction.selectedRowId;
		this.laneMessage = undefined;
		this.invalidate();
	}

	// ── Lane view transitions (test seams) ──

	enterLaneList(): void {
		if (this.agents.length === 0) return;
		this.view = "lane-list";
		this.laneSelectList = null;
		this.laneMessage = undefined;
		const rows = this.laneRows();
		if (!rows.some((row) => row.id === this.selectedLaneRowId)) {
			this.selectedLaneRowId = rows[0]?.id;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	exitLaneList(): void {
		this.view = "main";
		this.laneSelectList = null;
		this.laneMessage = undefined;
		this.invalidate();
		this.tui.requestRender();
	}

	private returnToLaneList(): void {
		this.view = "lane-list";
		this.laneSelectList = null;
		// Any inline lane note belonged to the view we just left; it is no longer true here.
		this.laneMessage = undefined;
		this.resetLaneModelPickerState();
		this.invalidate();
		this.tui.requestRender();
	}

	private returnToLaneDetail(): void {
		this.view = "lane-detail";
		this.laneThinkingList = null;
		this.resetLaneModelPickerState();
		this.invalidate();
		this.tui.requestRender();
	}

	enterLaneDetail(rowId: string): void {
		const row = this.laneRows().find((candidate) => candidate.id === rowId);
		if (!row) return;
		this.laneDetailRowId = rowId;
		this.selectedLaneRowId = rowId;
		this.laneEditingDraftId = row.draftId;
		this.laneMessage = undefined;
		this.view = "lane-detail";
		this.invalidate();
		this.tui.requestRender();
	}

	enterLaneNameView(mode: "create" | "rename"): void {
		this.laneNameMode = mode;
		this.laneNameError = undefined;
		this.pendingLaneName = undefined;
		this.laneNameInput = mode === "rename" ? (this.findLaneDraft(this.laneEditingDraftId)?.name ?? "") : "";
		this.view = "lane-name";
		this.invalidate();
		this.tui.requestRender();
	}

	/** Validate the entered name; creation continues into the model picker before staging. */
	private submitLaneName(): void {
		const agentName = this.laneAgentName();
		if (agentName === undefined) return;
		// Validated exactly as typed: names are never silently normalized, so 'fast ' is
		// rejected inline rather than quietly saved as 'fast'.
		const name = this.laneNameInput;
		const draft = this.laneNameMode === "rename" ? this.findLaneDraft(this.laneEditingDraftId) : undefined;
		if (this.laneNameMode === "rename" && !draft) return;

		// An unchanged rename target keeps a legacy key exactly as it is on disk.
		const unchanged = draft !== undefined && name === draft.name;
		if (!unchanged) {
			if (!isValidModelLaneName(name)) {
				// Blank or whitespace-only input has no visible characters to echo back.
				const shown = name.trim() === "" ? "(empty)" : name;
				this.laneNameError = `Invalid lane name '${shown}' \u2014 use lowercase letters, digits, and hyphens.`;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			const duplicate = this.laneDrafts.some(
				(candidate) => candidate.agentName === agentName && candidate.name === name && candidate.id !== draft?.id,
			);
			if (duplicate) {
				this.laneNameError = `Lane '${name}' already exists for ${agentName}.`;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
		}

		this.laneNameError = undefined;
		if (this.laneNameMode === "create") {
			// Nothing is staged yet: a model choice is still required.
			this.pendingLaneName = name;
			this.enterLaneModelView();
			return;
		}
		if (draft && !unchanged) {
			this.pushLaneTransaction();
			draft.name = name;
			this.laneDetailRowId = `user:${draft.id}`;
			this.selectedLaneRowId = this.laneDetailRowId;
		}
		this.returnToLaneDetail();
	}

	private resetLaneModelPickerState(): void {
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = this.sortModelsByProvider([...this.availableModels]);
		this.modelSelectList = null;
	}

	enterLaneModelView(): void {
		this.view = "lane-model";
		this.resetLaneModelPickerState();
		const currentModel = this.pendingLaneName !== undefined
			? undefined
			: this.findLaneDraft(this.laneEditingDraftId)?.model;
		if (currentModel) {
			const { baseModel } = splitKnownThinkingSuffix(currentModel);
			const currentIndex = this.filteredModels.findIndex((m) => m.fullId === baseModel || m.id === baseModel);
			if (currentIndex >= 0) this.modelSelectedIndex = currentIndex;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	/** Stage the model choice: completes a create, or edits an existing draft with a clamp. */
	private applyLaneModelSelection(modelFullId: string): void {
		const agentName = this.laneAgentName();
		if (agentName === undefined) return;

		if (this.pendingLaneName !== undefined) {
			this.pushLaneTransaction();
			const created: LaneDraft = {
				id: `lane-${this.laneDraftCounter++}`,
				agentName,
				originalName: undefined,
				name: this.pendingLaneName,
				model: modelFullId,
				thinking: undefined,
				originalModel: undefined,
				originalThinking: undefined,
			};
			this.laneDrafts.push(created);
			this.pendingLaneName = undefined;
			this.laneEditingDraftId = created.id;
			this.selectedLaneRowId = `user:${created.id}`;
			this.returnToLaneList();
			return;
		}

		const draft = this.findLaneDraft(this.laneEditingDraftId);
		if (!draft) {
			this.returnToLaneList();
			return;
		}
		this.pushLaneTransaction();
		draft.model = modelFullId;
		draft.thinking = this.clampThinkingForModel(draft.thinking, modelFullId);
		this.laneDetailRowId = `user:${draft.id}`;
		this.selectedLaneRowId = this.laneDetailRowId;
		this.returnToLaneDetail();
	}

	enterLaneThinkingView(): void {
		if (!this.findLaneDraft(this.laneEditingDraftId)) return;
		this.view = "lane-thinking";
		this.laneThinkingList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	private applyLaneThinkingChange(value: string): void {
		const draft = this.findLaneDraft(this.laneEditingDraftId);
		if (!draft) return;
		const next = value === "inherit" ? undefined : (isThinkingLevel(value) ? value : undefined);
		if (next === draft.thinking) return;
		this.pushLaneTransaction();
		draft.thinking = next;
		this.tui.requestRender();
	}

	/** `d` on the lane list: project rows are read-only, user rows open the confirmation. */
	private requestLaneDelete(): void {
		const row = this.laneRows().find((candidate) => candidate.id === this.selectedLaneRowId);
		if (!row) return;
		if (row.scope === "project") {
			this.laneMessage = `Project lane '${row.name}' is read-only \u2014 edit it in the project settings file.`;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.laneEditingDraftId = row.draftId;
		this.view = "lane-delete-confirm";
		this.laneDeleteConfirmList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	private performLaneDelete(): void {
		const draft = this.findLaneDraft(this.laneEditingDraftId);
		if (!draft) {
			this.returnToLaneList();
			return;
		}
		this.pushLaneTransaction();
		this.laneDrafts = this.laneDrafts.filter((candidate) => candidate.id !== draft.id);
		this.laneEditingDraftId = undefined;
		this.selectedLaneRowId = this.laneRows()[0]?.id;
		this.returnToLaneList();
	}

	// ── Lane input handlers (public for testability) ──

	handleLaneListInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.exitLaneList();
			return;
		}
		// n/d/u are intercepted before list delegation so the list stays non-searchable.
		if (data === "n") {
			this.laneEditingDraftId = undefined;
			this.enterLaneNameView("create");
			return;
		}
		if (data === "d") {
			this.requestLaneDelete();
			return;
		}
		if (data === "u") {
			this.undoLastLaneAction();
			this.tui.requestRender();
			return;
		}
		if (this.laneSelectList) {
			this.laneSelectList.handleInput(data);
			this.tui.requestRender();
		}
	}

	handleLaneDetailInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.returnToLaneList();
			return;
		}
		// Project rows expose no mutation keys at all.
		if (!this.findLaneDraft(this.laneEditingDraftId)) return;
		if (data === "m") {
			this.enterLaneModelView();
			return;
		}
		if (data === "t") {
			this.enterLaneThinkingView();
			return;
		}
		if (data === "r") {
			this.enterLaneNameView("rename");
		}
	}

	handleLaneNameInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			const wasCreate = this.laneNameMode === "create";
			this.laneNameError = undefined;
			this.pendingLaneName = undefined;
			this.laneNameInput = "";
			if (wasCreate) this.returnToLaneList();
			else this.returnToLaneDetail();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.submitLaneName();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.laneNameInput.length > 0) this.laneNameInput = this.laneNameInput.slice(0, -1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data.length >= 1 && /^[\x20-\x7e]+$/.test(data)) {
			this.laneNameInput += data;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	handleLaneModelInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			// Cancelling a create stages nothing; cancelling an edit keeps the current model.
			const wasCreate = this.pendingLaneName !== undefined;
			this.pendingLaneName = undefined;
			if (wasCreate) this.returnToLaneList();
			else this.returnToLaneDetail();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			this.tui.requestRender();
			return;
		}
		if (data.length >= 1 && /^[\x20-\x7e]+$/.test(data)) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}
		if (this.modelSelectList) {
			this.modelSelectList.handleInput(data);
			this.tui.requestRender();
		}
	}

	handleLaneThinkingInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.returnToLaneDetail();
			return;
		}
		if (this.laneThinkingList) {
			this.laneThinkingList.handleInput?.(data);
			this.tui.requestRender();
		}
	}

	handleLaneDeleteConfirmInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
		if (matchesKey(data, "escape")) {
			this.returnToLaneList();
			return;
		}
		if (this.laneDeleteConfirmList) {
			this.laneDeleteConfirmList.handleInput(data);
			this.tui.requestRender();
		}
	}

	// ── Lane view builders ──

	private formatLaneRowDescription(row: LaneRow): string {
		const th = this.theme;
		const model = row.model ?? "(inherit)";
		const thinking = row.thinking ?? "inherit";
		const tags: string[] = [];
		if (row.scope === "project") tags.push(th.fg("accent", "effective \u00b7 read-only"));
		else if (row.shadowed) tags.push(th.fg("warning", "shadowed by project"));
		if (row.legacy) tags.push(th.fg("warning", "legacy name"));
		const tagText = tags.length > 0 ? `  \u00b7  ${tags.join(" \u00b7 ")}` : "";
		return `${model}  \u00b7  ${th.fg("dim", "thinking:")} ${thinking}${tagText}`;
	}

	/** Warn about a stored level the current lane model does not support, without dirtying it. */
	private laneThinkingWarning(model: string | undefined, thinking: ThinkingLevel | undefined): string | undefined {
		if (thinking === undefined || !model) return undefined;
		const modelInfo = findModelInfo(model, this.availableModels, this.preferredProvider);
		const supported: ThinkingLevel[] = getSupportedThinkingLevels(modelInfo);
		if (supported.includes(thinking)) return undefined;
		return `\u26a0 thinking '${thinking}' is not supported by ${model} \u2014 unchanged until you pick a level`;
	}

	private buildLaneListView(): Container {
		const th = this.theme;
		const container = new Container();
		const agentName = this.laneAgentName() ?? "unknown";
		const rows = this.laneRows();

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(
			th.fg("accent", th.bold(` Model Lanes (${agentName} \u00b7 ${rows.length} lane${rows.length === 1 ? "" : "s"})`)),
			1, 0,
		));
		container.addChild(new Spacer(1));

		if (rows.length === 0) {
			this.laneSelectList = null;
			container.addChild(new Text(th.fg("dim", " No lanes configured for this agent"), 1, 0));
		} else {
			const items: SelectItem[] = rows.map((row) => ({
				value: row.id,
				label: row.name,
				description: this.formatLaneRowDescription(row),
			}));
			const selectTheme = this.getSelectListTheme();
			// Non-searchable SelectList: printable shortcuts (n/d/u) must reach this component.
			this.laneSelectList = new SelectList(items, Math.min(items.length, 12), selectTheme);
			const selectedIndex = rows.findIndex((row) => row.id === this.selectedLaneRowId);
			this.laneSelectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
			this.laneSelectList.onSelectionChange = (item: SelectItem) => {
				this.selectedLaneRowId = item.value;
			};
			this.laneSelectList.onSelect = (item: SelectItem) => {
				this.enterLaneDetail(item.value);
			};
			this.laneSelectList.onCancel = () => {
				this.exitLaneList();
			};
			container.addChild(this.laneSelectList);
		}

		if (this.laneMessage) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(th.fg("warning", ` ${this.laneMessage}`), 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("\u2191\u2193", "navigate", "enter", "details", "n", "new", "d", "delete")
				+ (this.canUndoLaneAction() ? th.fg("dim", " \u2022 ") + rawKeyHint("u", "undo") : ""),
			1, 0,
		));
		container.addChild(new Text(this.formatFooter("esc", "agents", "ctrl+c", "cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildLaneDetailView(): Container {
		const th = this.theme;
		const container = new Container();
		const row = this.laneRows().find((candidate) => candidate.id === this.laneDetailRowId);

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		if (!row) {
			container.addChild(new Text(th.fg("dim", " Lane no longer available"), 1, 0));
			container.addChild(new Text(this.formatFooter("esc", "lanes", "ctrl+c", "cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
			return container;
		}

		container.addChild(new Text(
			th.fg("accent", th.bold(` Lane: ${row.name}`)) + th.fg("dim", ` \u2014 ${this.laneAgentName() ?? ""}`),
			1, 0,
		));
		container.addChild(new Spacer(1));
		container.addChild(new Text(th.fg("dim", " model:    ") + (row.model ?? "(inherit)"), 1, 0));
		container.addChild(new Text(th.fg("dim", " thinking: ") + (row.thinking ?? "inherit"), 1, 0));
		container.addChild(new Text(th.fg("dim", " source:   ") + (row.scope === "project" ? "project settings" : "user settings"), 1, 0));

		if (row.scope === "project") {
			container.addChild(new Text(th.fg("accent", " effective \u00b7 read-only"), 1, 0));
		} else if (row.shadowed) {
			container.addChild(new Text(th.fg("warning", " shadowed by project \u2014 the project lane still wins at dispatch"), 1, 0));
		}
		if (row.legacy) {
			container.addChild(new Text(th.fg("warning", " legacy name \u2014 editable in place; rename requires a valid name"), 1, 0));
		}
		const warning = this.laneThinkingWarning(row.model, row.thinking);
		if (warning) container.addChild(new Text(th.fg("warning", ` ${warning}`), 1, 0));

		container.addChild(new Spacer(1));
		if (row.scope === "user") {
			container.addChild(new Text(this.formatFooter("m", "model", "t", "thinking", "r", "rename"), 1, 0));
		} else {
			container.addChild(new Text(th.fg("dim", " read-only \u2014 project lanes are edited in the project settings file"), 1, 0));
		}
		container.addChild(new Text(this.formatFooter("esc", "lanes", "ctrl+c", "cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildLaneNameView(): Container {
		const th = this.theme;
		const container = new Container();
		const creating = this.laneNameMode === "create";
		const cursor = "\x1b[7m \x1b[27m";

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(
			th.fg("accent", th.bold(creating ? " New Lane" : " Rename Lane")) + th.fg("dim", ` \u2014 ${this.laneAgentName() ?? ""}`),
			1, 0,
		));
		container.addChild(new Text(th.fg("dim", " Name: ") + this.laneNameInput + cursor, 1, 0));
		container.addChild(new Text(th.fg("dim", " lowercase letters, digits, and hyphens"), 1, 0));
		if (this.laneNameError) {
			container.addChild(new Text(th.fg("warning", ` ${this.laneNameError}`), 1, 0));
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(this.formatFooter("enter", creating ? "choose model" : "save"), 1, 0));
		container.addChild(new Text(this.formatFooter("esc", "back", "ctrl+c", "cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildLaneModelView(): Container {
		const th = this.theme;
		const container = new Container();
		const laneName = this.pendingLaneName ?? this.findLaneDraft(this.laneEditingDraftId)?.name ?? "lane";
		const currentModel = this.pendingLaneName !== undefined
			? undefined
			: this.findLaneDraft(this.laneEditingDraftId)?.model;
		const cursor = "\x1b[7m \x1b[27m";

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(` Lane Model (${laneName})`)), 1, 0));
		container.addChild(new Text(th.fg("dim", " Search: ") + this.modelSearchQuery + cursor, 1, 0));
		container.addChild(new Text(th.fg("dim", " Current: ") + th.fg("warning", currentModel ?? "(none)"), 1, 0));
		container.addChild(new Spacer(1));

		if (this.filteredModels.length === 0) {
			this.modelSelectList = null;
			container.addChild(new Text(th.fg("muted", " No matching models"), 1, 0));
		} else {
			const items: SelectItem[] = this.filteredModels.map((model) => {
				const supported = getSupportedThinkingLevels(model);
				const levelsText = supported.length > 0 ? ` \u00b7 ${supported.join("/")}` : "";
				return {
					value: model.fullId,
					label: model.id,
					description: `[${model.provider}]${model.fullId === currentModel ? " current" : ""}${levelsText}`,
				};
			});
			const selectTheme = this.getSelectListTheme();
			if (!this.modelSelectList) {
				this.modelSelectList = new SelectList(items, Math.min(items.length, this.MODEL_SELECTOR_HEIGHT), selectTheme);
			}
			this.modelSelectList.setSelectedIndex(this.modelSelectedIndex);
			this.modelSelectList.onSelectionChange = (item: SelectItem) => {
				const idx = this.filteredModels.findIndex((m) => m.fullId === item.value);
				if (idx >= 0) this.modelSelectedIndex = idx;
			};
			this.modelSelectList.onSelect = (item: SelectItem) => {
				this.applyLaneModelSelection(item.value);
			};
			this.modelSelectList.onCancel = () => {
				const wasCreate = this.pendingLaneName !== undefined;
				this.pendingLaneName = undefined;
				if (wasCreate) this.returnToLaneList();
				else this.returnToLaneDetail();
			};
			container.addChild(this.modelSelectList);
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter(...(this.filteredModels.length > 0 ? ["enter", "select"] : []), "type", "search"),
			1, 0,
		));
		container.addChild(new Text(this.formatFooter("esc", "back", "ctrl+c", "cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildLaneThinkingView(): Container {
		const th = this.theme;
		const container = new Container();
		const draft = this.findLaneDraft(this.laneEditingDraftId);
		const model = draft?.model;
		const modelInfo = findModelInfo(model ?? "", this.availableModels, this.preferredProvider);
		const supported: string[] = getSupportedThinkingLevels(modelInfo);

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(` Lane Thinking (${draft?.name ?? "lane"})`)), 1, 0));
		container.addChild(new Spacer(1));

		const warning = this.laneThinkingWarning(model, draft?.thinking);
		if (warning) container.addChild(new Text(th.fg("warning", ` ${warning}`), 1, 0));

		// One row, non-searchable: `inherit` clears the lane override, plus supported levels only.
		const items: SettingItem[] = [{
			id: draft?.id ?? "lane",
			label: `${draft?.name ?? "lane"}  \u00b7  ${model ?? "(inherit)"}`,
			currentValue: draft?.thinking ?? "inherit",
			values: ["inherit", ...supported],
		}];
		this.laneThinkingList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(_id: string, newValue: string) => this.applyLaneThinkingChange(newValue),
			() => this.returnToLaneDetail(),
		);
		container.addChild(this.laneThinkingList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(this.formatFooter("enter", "cycle"), 1, 0));
		container.addChild(new Text(this.formatFooter("esc", "back", "ctrl+c", "cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildLaneDeleteConfirmView(): Container {
		const th = this.theme;
		const container = new Container();
		const draft = this.findLaneDraft(this.laneEditingDraftId);
		const laneName = draft?.name ?? "lane";

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(
			th.fg("accent", th.bold(" Delete Lane")) + th.fg("dim", ` \u2014 ${laneName}`),
			1, 0,
		));
		container.addChild(new Spacer(1));

		const items: SelectItem[] = [
			{ value: "delete", label: `Delete lane '${laneName}'`, description: "stage for removal on exit" },
			{ value: "cancel", label: "Cancel", description: "return without deleting" },
		];
		const selectTheme = this.getSelectListTheme();
		this.laneDeleteConfirmList = new SelectList(items, 2, selectTheme);
		this.laneDeleteConfirmList.setSelectedIndex(1); // default to Cancel for safety
		this.laneDeleteConfirmList.onSelect = (item: SelectItem) => {
			if (item.value === "delete") this.performLaneDelete();
			else this.returnToLaneList();
		};
		this.laneDeleteConfirmList.onCancel = () => {
			this.returnToLaneList();
		};
		container.addChild(this.laneDeleteConfirmList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("\u2191\u2193", "navigate", "enter", "confirm") + th.fg("dim", " \u2022 ") + this.formatFooter("esc", "back", "ctrl+c", "cancel"),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}
}
