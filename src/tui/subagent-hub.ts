import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo } from "../shared/model-info.ts";
import {
	resolveModelCandidate,
	splitThinkingSuffix,
} from "../runs/shared/model-fallback.ts";
import {
	pad,
	row,
	renderHeader,
	renderFooter,
	formatScrollInfo,
} from "./render-helpers.ts";

export interface SubagentHubResult {
	overrides: Map<string, string>; // agent name → model override string
}

export class SubagentHubComponent implements Component {
	readonly width = 84;
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
	private selectedAgentIndex = 0;
	private editingAgentIndex: number | null = null; // null = main nav, number = in model picker for that agent
	private modelSearchQuery = "";
	private modelSelectedIndex = 0;
	private filteredModels: ModelInfo[] = [];
	private agentModelOverrides: Map<string, string> = new Map(); // agent name → preferred fullId

	invalidate(): void {}
	dispose(): void {}

	render(width: number): string[] {
		if (this.editingAgentIndex !== null) {
			return this.renderModelSelector();
		}
		return this.renderMainView();
	}

	handleInput(data: string): void {
		if (this.editingAgentIndex !== null) {
			this.handleModelSelectorInput(data);
			return;
		}

		// Main navigation
		if (matchesKey(data, "up")) {
			if (this.agents.length > 0) {
				this.selectedAgentIndex =
					this.selectedAgentIndex === 0
						? this.agents.length - 1
						: this.selectedAgentIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.agents.length > 0) {
				this.selectedAgentIndex =
					this.selectedAgentIndex === this.agents.length - 1
						? 0
						: this.selectedAgentIndex + 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "m")) {
			if (this.agents.length > 0) {
				this.enterModelSelector(this.selectedAgentIndex);
			}
			return;
		}

		if (matchesKey(data, "return")) {
			const result: SubagentHubResult = {
				overrides: this.agentModelOverrides,
			};
			this.done(result);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ overrides: new Map() });
			return;
		}
	}

	// ── Render methods ──────────────────────────────────────────

	private renderMainView(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const headerText = " Subagent Models ";
		lines.push(renderHeader(headerText, this.width, th));
		lines.push(row("", this.width, th));

		if (this.agents.length === 0) {
			lines.push(row(` ${th.fg("dim", "No subagents found")}`, this.width, th));
			const footerText = " [Esc] Cancel ";
			lines.push(renderFooter(footerText, this.width, th));
			return lines;
		}

		for (let i = 0; i < this.agents.length; i++) {
			const agent = this.agents[i]!;
			const isSelected = i === this.selectedAgentIndex;

			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";

			const override = this.agentModelOverrides.get(agent.name);
			const effectiveModel = override ?? this.resolveAgentEffectiveModel(agent);
			const isOverridden = override !== undefined || agent.model !== undefined;

			// Build model display
			let modelDisplay: string;
			if (isOverridden) {
				modelDisplay = th.fg("warning", effectiveModel) + th.fg("dim", " ✎");
			} else {
				modelDisplay = th.fg("dim", effectiveModel || "(none)");
			}

			// Build line: prefix + agent name padded + model
			const nameMaxLen = 26;
			const agentName = agent.name.length > nameMaxLen
				? truncateToWidth(agent.name, nameMaxLen - 1) + "…"
				: agent.name;

			const lineLeft = th.fg(color, `${prefix}${agentName}`);
			const paddedLeft = pad(lineLeft, nameMaxLen + 3); // +3 for prefix
			const innerW = this.width - 2;
			const modelMaxLen = innerW - (nameMaxLen + 3) - 2; // -2 for spacing
			const clippedModel = truncateToWidth(modelDisplay, modelMaxLen);

			lines.push(row(` ${paddedLeft}  ${clippedModel}`, this.width, th));
		}

		const contentLines = lines.length;
		// Pad to at least 18 lines
		const targetHeight = 18;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(row("", this.width, th));
		}

		const footerText = " [Enter] Confirm • [Esc] Cancel • m Model • ↑↓ Navigate ";
		lines.push(renderFooter(footerText, this.width, th));

		return lines;
	}

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

	/** Enter model selector mode */
	private enterModelSelector(agentIndex: number): void {
		this.editingAgentIndex = agentIndex;
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];

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

		this.tui.requestRender();
	}

	/** Exit model selector and return to main view */
	private exitModelSelector(): void {
		this.editingAgentIndex = null;
		this.tui.requestRender();
	}

	/** Filter models based on search query */
	private filterModels(): void {
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
	}

	private handleModelSelectorInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitModelSelector();
			return;
		}

		if (matchesKey(data, "return")) {
			const selected = this.filteredModels[this.modelSelectedIndex];
			if (selected && this.editingAgentIndex !== null) {
				const agent = this.agents[this.editingAgentIndex]!;
				const currentModel = this.agentModelOverrides.get(agent.name) ?? this.resolveAgentEffectiveModel(agent);
				const { thinkingSuffix } = splitThinkingSuffix(currentModel);
				const requestedLevel = thinkingSuffix.slice(1);
				const selectedModelInfo = findModelInfo(selected.fullId, this.availableModels, this.preferredProvider);
				const suffix = getSupportedThinkingLevels(selectedModelInfo).some((level) => level === requestedLevel) ? thinkingSuffix : "";
				this.agentModelOverrides.set(agent.name, `${selected.fullId}${suffix}`);
			}
			this.exitModelSelector();
			return;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex =
					this.modelSelectedIndex === 0
						? this.filteredModels.length - 1
						: this.modelSelectedIndex - 1;
			}
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex =
					this.modelSelectedIndex === this.filteredModels.length - 1
						? 0
						: this.modelSelectedIndex + 1;
			}
			this.tui.requestRender();
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

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelSearchQuery += data;
			this.filterModels();
			this.tui.requestRender();
			return;
		}
	}

	/** Render the model selector view */
	private renderModelSelector(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const agentName =
			this.editingAgentIndex !== null
				? (this.agents[this.editingAgentIndex]?.name ?? "unknown")
				: "unknown";
		const headerText = ` Select Model (${agentName}) `;
		lines.push(renderHeader(headerText, this.width, th));
		lines.push(row("", this.width, th));

		const searchPrefix = th.fg("dim", "Search: ");
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		const searchDisplay = this.modelSearchQuery + cursor;
		lines.push(row(` ${searchPrefix}${searchDisplay}`, this.width, th));
		lines.push(row("", this.width, th));

		const agent =
			this.editingAgentIndex !== null
				? this.agents[this.editingAgentIndex]!
				: null;
		const currentModel = agent
			? (this.agentModelOverrides.get(agent.name) ??
					this.resolveAgentEffectiveModel(agent))
			: "";
		const currentLabel = th.fg("dim", "Current: ");
		lines.push(
			row(` ${currentLabel}${th.fg("warning", currentModel)}`, this.width, th),
		);
		lines.push(row("", this.width, th));

		if (this.filteredModels.length === 0) {
			lines.push(
				row(` ${th.fg("dim", "No matching models")}`, this.width, th),
			);
		} else {
			const maxVisible = this.MODEL_SELECTOR_HEIGHT;
			let startIdx = 0;

			if (this.filteredModels.length > maxVisible) {
				startIdx = Math.max(
					0,
					this.modelSelectedIndex - Math.floor(maxVisible / 2),
				);
				startIdx = Math.min(
					startIdx,
					this.filteredModels.length - maxVisible,
				);
			}

			const endIdx = Math.min(
				startIdx + maxVisible,
				this.filteredModels.length,
			);

			if (startIdx > 0) {
				lines.push(
					row(` ${th.fg("dim", `  ${formatScrollInfo(startIdx, 0)}`)}`, this.width, th),
				);
			}

			for (let i = startIdx; i < endIdx; i++) {
				const model = this.filteredModels[i]!;
				const isSelected = i === this.modelSelectedIndex;
				const currentModelBase = splitThinkingSuffix(currentModel).baseModel;
				const isCurrent =
					model.fullId === currentModelBase ||
					model.id === currentModelBase;
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const modelText = isSelected
					? th.fg("accent", model.id)
					: model.id;
				const providerBadge = th.fg("dim", ` [${model.provider}]`);
				const currentBadge = isCurrent
					? th.fg("success", " current")
					: "";

				lines.push(
					row(
						` ${prefix}${modelText}${providerBadge}${currentBadge}`,
						this.width,
						th,
					),
				);
			}

			const remaining = this.filteredModels.length - endIdx;
			if (remaining > 0) {
				lines.push(
					row(` ${th.fg("dim", `  ${formatScrollInfo(0, remaining)}`)}`, this.width, th),
				);
			}
		}

		const contentLines = lines.length;
		const targetHeight = 18;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(row("", this.width, th));
		}

		const footerText =
			" [Enter] Select • [Esc] Cancel • Type to search ";
		lines.push(renderFooter(footerText, this.width, th));

		return lines;
	}
}