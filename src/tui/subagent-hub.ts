import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme, rawKeyHint } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem, SettingItem, TUI } from "@earendil-works/pi-tui";
import { Container, SelectList, SettingsList, Spacer, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, splitKnownThinkingSuffix, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../shared/model-info.ts";
import {
	resolveModelCandidate,
} from "../runs/shared/model-fallback.ts";

/** Type guard for a supported thinking-level string. */
function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.some((level) => level === value);
}
export interface SubagentHubResult {
	overrides: Map<string, string>; // agent name → model override string
	thinkingOverrides?: Map<string, string>; // agent name → thinking level override
	resetAgents?: Set<string>; // agent names whose overrides should be removed
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

/** Discriminated view state — each phase adds cases as needed. */
type HubView = "main" | "model" | "thinking" | "reset-confirm";

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

	/** Undo stack: each x (single) or confirmed X (bulk) pushes one transaction. u pops LIFO. */
	private undoStack: ResetTransaction[] = [];

	// SelectList instances are created per main-view rebuild because pi-tui's SelectList has no setItems();
	// selection is restored by index after each rebuild. They are reused only for navigation within a stable view.
	private agentSelectList: SelectList | null = null;
	private modelSelectList: SelectList | null = null;
	private thinkingSelectList: SettingsList | null = null;
	private resetConfirmSelectList: SelectList | null = null;

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
		return {
			overrides,
			thinkingOverrides,
			resetAgents: prunedResets.size > 0 ? prunedResets : undefined,
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
	}

	render(width: number): string[] {
		if (this.needsRebuild || !this.activeContainer) {
			if (this.view === "model") {
				this.activeContainer = this.buildModelSelectorView();
			} else if (this.view === "thinking") {
				this.activeContainer = this.buildThinkingView();
			} else if (this.view === "reset-confirm") {
				this.activeContainer = this.buildResetConfirmView();
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
		const modifiedCount = new Set([...this.dirtyAgents, ...this.resetAgents]).size;
		container.addChild(new Text(th.fg("accent", th.bold(` Subagent Models (${this.agents.length} agents · ${modifiedCount} modified)`)), 1, 0));
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
			this.formatFooter("↑↓", "navigate", "enter", "model", "tab", "thinking", "x", "reset", "X", "bulk")
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
					if (currentThinking && !(isThinkingLevel(currentThinking) && supportedLevels.includes(currentThinking))) {
						const fallbackLevel = supportedLevels.includes("off")
							? "off"
							: (supportedLevels[0] ?? "off");
						this.agentThinkingOverrides.set(selectedAgent.name, fallbackLevel);
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
}
