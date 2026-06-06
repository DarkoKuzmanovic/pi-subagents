import { THINKING_LEVELS } from "../shared/model-info.ts";
import type { ThinkingLevel } from "../shared/model-info.ts";
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSettingsFileStrict } from "./agents.ts";

export interface ModelLaneDefinition {
	model?: string;
	thinking?: ThinkingLevel;
}

export type ModelLaneMap = Record<string, Record<string, ModelLaneDefinition>>;

export interface ResolvedModelLaneFound {
	found: true;
	agentName: string;
	laneName: string;
	value: ModelLaneDefinition;
	scope: "user" | "project";
	filePath: string;
}

export interface ResolvedModelLaneMissing {
	found: false;
	agentName: string;
	laneName: string;
	error: string;
}

export type ResolvedModelLane = ResolvedModelLaneFound | ResolvedModelLaneMissing;

export interface RequestedModelLaneOverrides {
	agentName: string;
	laneName?: string;
	model?: string;
	thinking?: ThinkingLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseModelLaneDefinition(filePath: string, agentName: string, laneName: string, value: unknown): ModelLaneDefinition {
	if (!isRecord(value)) {
		throw new Error(`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' must be an object.`);
	}

	const model = value.model;
	if (model !== undefined && typeof model !== "string") {
		throw new Error(`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has invalid 'model'; expected a string.`);
	}

	const thinking = value.thinking;
	if (thinking !== undefined) {
		if (typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
			throw new Error(
				`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has invalid 'thinking'; expected one of: ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}

	return {
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking: thinking as ThinkingLevel } : {}),
	};
}

export function readModelLanesFromSettingsFile(filePath: string | null): ModelLaneMap {
	if (!filePath) return {};
	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (subagents === undefined) return {};
	if (!isRecord(subagents)) {
		throw new Error(`Subagent settings in '${filePath}' must be an object.`);
	}

	const modelLanes = subagents.modelLanes;
	if (modelLanes === undefined) return {};
	if (!isRecord(modelLanes)) {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'modelLanes'; expected an object mapping agent names to lane maps.`);
	}

	const parsed: ModelLaneMap = {};
	for (const [agentName, laneMapValue] of Object.entries(modelLanes)) {
		if (!isRecord(laneMapValue)) {
			throw new Error(`Model lanes for agent '${agentName}' in '${filePath}' must be an object mapping lane names to lane configs.`);
		}

		const laneMap: Record<string, ModelLaneDefinition> = {};
		for (const [laneName, laneValue] of Object.entries(laneMapValue)) {
			laneMap[laneName] = parseModelLaneDefinition(filePath, agentName, laneName, laneValue);
		}
		parsed[agentName] = laneMap;
	}

	return parsed;
}

export function resolveModelLane(cwd: string, agentName: string, laneName: string): ResolvedModelLane {
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const projectLanes = readModelLanesFromSettingsFile(projectSettingsPath);
	const projectLane = projectLanes[agentName]?.[laneName];
	if (projectLane) {
		return {
			found: true,
			agentName,
			laneName,
			value: projectLane,
			scope: "project",
			filePath: projectSettingsPath as string,
		};
	}

	const userSettingsPath = getUserAgentSettingsPath();
	const userLanes = readModelLanesFromSettingsFile(userSettingsPath);
	const userLane = userLanes[agentName]?.[laneName];
	if (userLane) {
		return {
			found: true,
			agentName,
			laneName,
			value: userLane,
			scope: "user",
			filePath: userSettingsPath,
		};
	}

	return {
		found: false,
		agentName,
		laneName,
		error: `No model lane '${laneName}' configured for agent '${agentName}'.`,
	};
}


export function resolveModelLaneOverrides(cwd: string, request: RequestedModelLaneOverrides): ModelLaneDefinition {
	if (!request.laneName) {
		return {
			...(request.model !== undefined ? { model: request.model } : {}),
			...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
		};
	}

	const resolved = resolveModelLane(cwd, request.agentName, request.laneName);
	if (!resolved.found) {
		throw new Error(`Unknown model lane '${request.laneName}' for agent '${request.agentName}'.`);
	}

	return {
		...(request.model !== undefined ? { model: request.model } : resolved.value.model !== undefined ? { model: resolved.value.model } : {}),
		...(request.thinking !== undefined ? { thinking: request.thinking } : resolved.value.thinking !== undefined ? { thinking: resolved.value.thinking } : {}),
	};
}
