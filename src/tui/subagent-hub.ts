import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, TUI } from "@earendil-works/pi-tui";
import { Container, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, type ModelInfo, type ThinkingLevel } from "../shared/model-info.ts";
import {
	resolveModelCandidate,
} from "../runs/shared/model-fallback.ts";

export interface SubagentHubResult {
	overrides: Map<string, string>; // agent name → model override string
	thinkingOverrides?: Map<string, string>; // agent name → thinking level override
	resetAgents?: Set<string>; // agent names whose overrides should be removed
}

/** Discriminated view state — each phase adds cases as needed. */
type HubView = "main" | "model";

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

	// SelectList instances are created per main-view rebuild because pi-tui's SelectList has no setItems();
	// selection is restored by index after each rebuild. They are reused only for navigation within a stable view.
	private agentSelectList: SelectList | null = null;
	private modelSelectList: SelectList | null = null;

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
			// Re-dirtied after reset — the latest edit wins, so remove from resets
			this.resetAgents.delete(name);
		}
		return { overrides, thinkingOverrides, resetAgents: this.resetAgents.size > 0 ? new Set(this.resetAgents) : undefined };
	}

	dispose(): void {}

	// ── Rendering ─────────────────────────────────────────────

	invalidate(): void {
		this.needsRebuild = true;
		// Invalidate existing child caches so theme changes take effect.
		this.activeContainer?.invalidate();
		this.agentSelectList?.invalidate();
		this.modelSelectList?.invalidate();
	}

	render(width: number): string[] {
		if (this.needsRebuild || !this.activeContainer) {
			this.activeContainer = this.view === "model"
				? this.buildModelSelectorView()
				: this.buildMainView();
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

		// Agent list: delegate navigation/selection to SelectList
		if (this.agentSelectList) {
			// ctrl+c = hard cancel (discard all overrides)
			if (matchesKey(data, "ctrl+c")) {
				this.done({ overrides: new Map() });
				return;
			}
			// esc = done (apply only dirty overrides)
			if (matchesKey(data, "escape")) {
				this.done(this.buildDirtyResult());
				return;
			}
			if (matchesKey(data, "tab")) {
				this.cycleThinkingLevel();
				this.tui.requestRender();
				return;
			}
			if (data === "x" || data === "X") {
				this.resetSelectedAgent();
				this.tui.requestRender();
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
				this.modelSelectedIndex = 0;
			}
			this.tui.requestRender();
			return;
		}

		// Printable characters (single keystroke or paste): append to search query
		if (data.length >= 1 && /^[\x20-\x7e]+$/.test(data)) {
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
			const { baseModel } = splitKnownThinkingSuffix(effectiveModel);
			const overriddenThinking = this.agentThinkingOverrides.get(agent.name);
			const effectiveThinking = overriddenThinking ?? agent.thinking ?? "";
			const thinkingDisplay = effectiveThinking && effectiveThinking !== "off" ? effectiveThinking : "off";
			const modelDisplay = baseModel || "(host default)";
			// Show ✎ only for agents with a persisted settings override or edited this session
			const hasOverride = agent.override !== undefined || this.dirtyAgents.has(agent.name);
			const fallbackCount = agent.fallbackModels?.length ?? 0;
			const fallbackTag = fallbackCount > 0 ? `  +${fallbackCount} fallback${fallbackCount > 1 ? "s" : ""}` : "";
			const desc = hasOverride
				? `${modelDisplay} ✎  ·  thinking: ${thinkingDisplay}${fallbackTag}`
				: `${modelDisplay}  ·  thinking: ${thinkingDisplay}${fallbackTag}`;
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
			this.formatFooter("↑↓", "navigate", "enter", "model", "tab", "thinking", "x", "reset", "esc", "done", "ctrl+c", "cancel"),
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
		container.addChild(new Text(th.fg("dim", " Current: ") + th.fg("warning", currentModel), 1, 0));
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

					// Clamp the separate thinking override if the new model doesn't support it
					const currentThinking = this.agentThinkingOverrides.get(selectedAgent.name);
					if (currentThinking && !supportedLevels.includes(currentThinking as ThinkingLevel)) {
						this.agentThinkingOverrides.set(selectedAgent.name, "off");
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
			this.formatFooter(...(this.filteredModels.length > 0 ? ["enter", "select"] : []), "esc", "back", "ctrl+c", "cancel", "type", "search"),
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

	/** Cycle thinking level for the selected agent */
	cycleThinkingLevel(): void {
		const agent = this.agents[this.selectedAgentIndex];
		if (!agent) return;

		const effectiveModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
		const modelInfo = findModelInfo(effectiveModel, this.availableModels, this.preferredProvider);
		const availableLevels: ThinkingLevel[] = getSupportedThinkingLevels(modelInfo);

		// Get current effective thinking
		const { thinkingSuffix } = splitKnownThinkingSuffix(effectiveModel);
		const suffixThinking = thinkingSuffix ? thinkingSuffix.slice(1) : undefined;
		const overridden = this.agentThinkingOverrides.get(agent.name);
		const currentThinking = (overridden ?? agent.thinking ?? suffixThinking ?? "off") as ThinkingLevel;

		// Cycle to next level
		const currentIndex = availableLevels.indexOf(currentThinking);
		if (availableLevels.length === 0) return;
		if (currentIndex >= 0 && availableLevels.length === 1) return;
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % availableLevels.length;
		const nextLevel = availableLevels[nextIndex];

		this.agentThinkingOverrides.set(agent.name, nextLevel);
		this.dirtyAgents.add(agent.name);

		// Ensure the resolved model is also persisted so that a thinking-only
		// change doesn't get saved without its companion model override.
		// Only pin when the agent actually has a configured model — model-less
		// agents inherit the host default and should not get a fabricated override.
		if (!this.agentModelOverrides.has(agent.name) && agent.model) {
			const { baseModel } = splitKnownThinkingSuffix(effectiveModel);
			this.agentModelOverrides.set(agent.name, baseModel);
		}

		this.needsRebuild = true;
	}

	/** Reset the selected agent's override back to its base config */
	private resetSelectedAgent(): void {
		const agent = this.agents[this.selectedAgentIndex];
		if (!agent) return;
		// Only meaningful for agents that actually have a persisted override
		if (!agent.override) return;
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
		this.filteredModels = [...this.availableModels];
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
