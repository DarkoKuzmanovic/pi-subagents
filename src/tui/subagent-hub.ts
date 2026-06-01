import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { Container, SelectList, Spacer, Text, matchesKey } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo } from "../shared/model-info.ts";
import {
	resolveModelCandidate,
	splitThinkingSuffix,
} from "../runs/shared/model-fallback.ts";

export interface SubagentHubResult {
	overrides: Map<string, string>; // agent name → model override string
	thinkingOverrides?: Map<string, string>; // agent name → thinking level override
}

export class SubagentHubComponent implements Component {
	private readonly MODEL_SELECTOR_HEIGHT = 10;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly agents: AgentConfig[],
		private readonly availableModels: ModelInfo[],
		private readonly preferredProvider: string | undefined,
		private readonly done: (result: SubagentHubResult) => void,
		private readonly cwd: string,
	) {
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
	}

	// State
	selectedAgentIndex = 0;
	editingAgentIndex: number | null = null; // null = main nav, number = in model picker for that agent
	modelSearchQuery = "";
	modelSelectedIndex = 0;
	filteredModels: ModelInfo[] = [];
	agentModelOverrides: Map<string, string> = new Map(); // agent name → preferred fullId
	agentThinkingOverrides: Map<string, string> = new Map(); // agent name → thinking level

	// Persisted SelectList instances (delegated input handling)
	private agentSelectList: SelectList | null = null;
	private modelSelectList: SelectList | null = null;

	// Render cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.agentSelectList?.invalidate();
		this.modelSelectList?.invalidate();
	}

	dispose(): void {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const container = this.editingAgentIndex !== null
			? this.buildModelSelectorView()
			: this.buildMainView();

		this.cachedLines = container.render(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	handleInput(data: string): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;

		if (this.editingAgentIndex !== null) {
			this.handleModelSelectorInput(data);
			return;
		}

		// Agent list: delegate navigation/selection to SelectList
		if (this.agentSelectList) {
			// ctrl+c = hard cancel (discard all overrides)
			if (matchesKey(data, "ctrl+c")) {
				this.done({ overrides: new Map() });
				return;
			}
			// esc = done (apply all overrides)
			if (matchesKey(data, "escape")) {
				this.done({ overrides: this.agentModelOverrides, thinkingOverrides: this.agentThinkingOverrides });
				return;
			}
			if (matchesKey(data, "tab")) {
				this.cycleThinkingLevel();
				return;
			}
			// Everything else (up/down/enter/search) goes to SelectList
			this.agentSelectList?.handleInput(data);
			this.tui.requestRender();
			return;
		}

		// No SelectList (shouldn't happen, but fallback)
		if (matchesKey(data, "escape")) {
		this.done({ overrides: this.agentModelOverrides, thinkingOverrides: this.agentThinkingOverrides });
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
				this.modelSelectedIndex = 0;
			}
			this.tui.requestRender();
			return;
		}

		// Printable character: append to search query
		if (data.length === 1 && data >= " " && data <= "~") {
			this.modelSearchQuery += data;
			this.filterModels();
			this.modelSelectedIndex = 0;
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

	// ── View builders ──────────────────────────────────────────

	private buildMainView(): Container {
		const th = this.theme;
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(" Subagent Models")), 1, 0));
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
			const isOverridden = override !== undefined || agent.model !== undefined;
			const { thinkingSuffix } = splitThinkingSuffix(effectiveModel);
			const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
			const overriddenThinking = this.agentThinkingOverrides.get(agent.name);
			const effectiveThinking = overriddenThinking ?? suffixThinking ?? agent.thinking ?? "";
			const thinkingDisplay = effectiveThinking && effectiveThinking !== "off" ? effectiveThinking : "off";
			const desc = isOverridden
				? `${effectiveModel} ✎  ·  thinking: ${thinkingDisplay}`
				: `${effectiveModel || "(none)"}  ·  thinking: ${thinkingDisplay}`;
			return {
				value: agent.name,
				label: agent.name,
				description: desc,
			};
		});

		const selectTheme = this.getSelectListTheme();
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

		// Wire onCancel: SelectList cancel (esc) = done, apply overrides
		this.agentSelectList.onCancel = () => {
				this.done({ overrides: this.agentModelOverrides, thinkingOverrides: this.agentThinkingOverrides });
		};

		container.addChild(this.agentSelectList);

		container.addChild(new Spacer(1));
		container.addChild(new Text(
			this.formatFooter("enter", "model", "tab", "thinking", "esc", "done", "ctrl+c", "cancel"),
			1, 0,
		));
		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));

		return container;
	}

	private buildModelSelectorView(): Container {
		const th = this.theme;
		const container = new Container();

		const agentName =
			this.editingAgentIndex !== null
				? (this.agents[this.editingAgentIndex]?.name ?? "unknown")
				: "unknown";

		container.addChild(new DynamicBorder((s: string) => th.fg("accent", s)));
		container.addChild(new Text(th.fg("accent", th.bold(` Select Model (${agentName})`)), 1, 0));

		// Search line
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		container.addChild(new Text(th.fg("dim", " Search: ") + this.modelSearchQuery + cursor, 1, 0));

		// Current model
		const agent =
			this.editingAgentIndex !== null
				? this.agents[this.editingAgentIndex]!
				: null;
		const currentModel = agent
			? (this.agentModelOverrides.get(agent.name) ??
					this.resolveAgentEffectiveModel(agent))
			: "";
		container.addChild(new Text(th.fg("dim", " Current: ") + th.fg("warning", currentModel), 1, 0));
		container.addChild(new Spacer(1));

		if (this.filteredModels.length === 0) {
			this.modelSelectList = null;
			container.addChild(new Text(th.fg("muted", " No matching models"), 1, 0));
		} else {
			const { baseModel } = splitThinkingSuffix(currentModel);
			const items: SelectItem[] = this.filteredModels.map((model) => {
				const isCurrent =
					model.fullId === baseModel ||
					model.id === baseModel;
				const desc = `[${model.provider}]${isCurrent ? " current" : ""}`;
				return {
					value: model.fullId,
					label: model.id,
					description: desc,
				};
			});

			const selectTheme = this.getSelectListTheme();
			this.modelSelectList = new SelectList(items, Math.min(items.length, this.MODEL_SELECTOR_HEIGHT), selectTheme);
		this.modelSelectList.setSelectedIndex(this.modelSelectedIndex);

			// Sync modelSelectedIndex when user navigates up/down
			this.modelSelectList.onSelectionChange = (item: SelectItem) => {
				const idx = this.filteredModels.findIndex((m) => m.fullId === item.value);
				if (idx >= 0) this.modelSelectedIndex = idx;
			};

			// Wire onSelect: enter selects model and returns to agent list
			this.modelSelectList.onSelect = (item: SelectItem) => {
				if (this.editingAgentIndex !== null) {
					const agent = this.agents[this.editingAgentIndex]!;
					const currentModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
					const { thinkingSuffix } = splitThinkingSuffix(currentModel);
					const requestedLevel = thinkingSuffix.slice(1);
					const selectedModelInfo = findModelInfo(item.value, this.availableModels, this.preferredProvider);
					const suffix = getSupportedThinkingLevels(selectedModelInfo).some((level) => level === requestedLevel) ? thinkingSuffix : "";
					this.agentModelOverrides.set(agent.name, `${item.value}${suffix}`);
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
			this.formatFooter("enter", "select", "esc", "back", "type", "search"),
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
			const key = pairs[i]!;
			const desc = pairs[i + 1]!;
			hints.push(rawKeyHint(key, desc));
		}
		return hints.join(separator);
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
		// If no model configured, return first available or fallback
		if (this.availableModels.length > 0) {
			const first = this.availableModels[0]!;
			return first.fullId;
		}
		return "";
	}

	/** Cycle thinking level for the selected agent */
	cycleThinkingLevel(): void {
		const agent = this.agents[this.selectedAgentIndex];
		if (!agent) return;

		const effectiveModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
		const modelInfo = findModelInfo(effectiveModel, this.availableModels, this.preferredProvider);
		const availableLevels = getSupportedThinkingLevels(modelInfo);
		if (availableLevels.length === 0) return;

		// Get current effective thinking
		const { thinkingSuffix } = splitThinkingSuffix(effectiveModel);
		const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
		const overridden = this.agentThinkingOverrides.get(agent.name);
		const currentThinking = (overridden ?? suffixThinking ?? agent.thinking ?? "off") as import("../shared/model-info.ts").ThinkingLevel;

		// Cycle to next level
		const currentIndex = availableLevels.indexOf(currentThinking);
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % availableLevels.length;
		const nextLevel = availableLevels[nextIndex]!;

		this.agentThinkingOverrides.set(agent.name, nextLevel);
	}

	/** Enter model selector mode */
	enterModelSelector(agentIndex: number): void {
		this.editingAgentIndex = agentIndex;
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];
		this.modelSelectList = null;

		// Find current model of that agent in list
		const agent = this.agents[agentIndex]!;
		const currentModel = this.agentModelOverrides.get(agent.name) ??
			this.resolveAgentEffectiveModel(agent);
		const { baseModel } = splitThinkingSuffix(currentModel);
		const currentIndex = this.filteredModels.findIndex(
			(m) => m.fullId === baseModel || m.id === baseModel,
		);
		if (currentIndex >= 0) {
			this.modelSelectedIndex = currentIndex;
		}

		this.invalidate();
		this.tui.requestRender();
	}

	/** Exit model selector and return to main view */
	exitModelSelector(): void {
		this.editingAgentIndex = null;
		this.modelSelectList = null;
		this.invalidate();
		this.tui.requestRender();
	}

	/** Filter models based on search query */
	filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		if (!query) {
			this.filteredModels = [...this.availableModels];
		} else {
			this.filteredModels = this.availableModels.filter(
				(m) =>
					m.fullId.toLowerCase().includes(query) ||
					m.id.toLowerCase().includes(query) ||
					m.provider.toLowerCase().includes(query),
			);
		}
		this.modelSelectedIndex = Math.min(
			this.modelSelectedIndex,
			Math.max(0, this.filteredModels.length - 1),
		);
		this.invalidate();
	}
}