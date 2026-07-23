export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

const LEGACY_FALLBACK_THINKING_LEVELS = THINKING_LEVELS.filter((level) => level !== "max");

export interface ModelInfo {
	provider: string;
	id: string;
	fullId: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface RegistryModelLike {
	provider: string;
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

export function toModelInfo(model: RegistryModelLike): ModelInfo {
	return {
		provider: model.provider,
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
	};
}

export function currentModelFullId(model: unknown): string | undefined {
	if (!model || typeof model !== "object") return undefined;
	const record = model as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider : undefined;
	const id = typeof record.id === "string"
		? record.id
		: typeof record.modelId === "string"
			? record.modelId
			: undefined;
	return provider && id ? `${provider}/${id}` : undefined;
}

export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
	if (!suffix) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: `:${suffix}`,
	};
}

export function findModelInfo(model: string | undefined, availableModels: ModelInfo[] | undefined, preferredProvider?: string): ModelInfo | undefined {
	if (!model || !availableModels || availableModels.length === 0) return undefined;
	const { baseModel } = splitKnownThinkingSuffix(model);
	const exact = availableModels.find((entry) => entry.fullId === baseModel);
	if (exact) return exact;

	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferred = matches.find((entry) => entry.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
	if (!model) return [...LEGACY_FALLBACK_THINKING_LEVELS];
	if (model.reasoning === false) return ["off"];

	if (!model.thinkingLevelMap) return [...LEGACY_FALLBACK_THINKING_LEVELS];

	const levels = THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
	return levels;
}
