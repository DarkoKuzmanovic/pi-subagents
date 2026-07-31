import { THINKING_LEVELS } from "../shared/model-info.ts";
import type { ThinkingLevel } from "../shared/model-info.ts";
import { getProjectAgentSettingsPath, getUserAgentSettingsPath, readSettingsFileStrict, writeSettingsFile } from "./agents.ts";

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

	const rawModel = value.model;
	if (rawModel !== undefined && typeof rawModel !== "string") {
		throw new Error(`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has invalid 'model'; expected a string.`);
	}
	if (typeof rawModel === "string" && rawModel.trim() === "") {
		throw new Error(`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has an empty 'model'; provide a non-blank model name or omit it.`);
	}
	const model = rawModel as string | undefined;

	const rawThinking = value.thinking;
	if (rawThinking !== undefined) {
		if (typeof rawThinking !== "string" || !THINKING_LEVELS.includes(rawThinking as ThinkingLevel)) {
			throw new Error(
				`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has invalid 'thinking'; expected one of: ${THINKING_LEVELS.join(", ")}.`,
			);
		}
	}
	const thinking = rawThinking as ThinkingLevel | undefined;

	return {
		...(model !== undefined ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
	};
}

function parseModelLanes(filePath: string, subagents: unknown): ModelLaneMap {
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
			setOwnKey(laneMap, laneName, parseModelLaneDefinition(filePath, agentName, laneName, laneValue));
		}
		setOwnKey(parsed, agentName, laneMap);
	}

	return parsed;
}

export function readModelLanesFromSettingsFile(filePath: string | null): ModelLaneMap {
	if (!filePath) return {};
	const settings = readSettingsFileStrict(filePath);
	return parseModelLanes(filePath, settings.subagents);
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

/** Lane names created or renamed through managed UI must be lowercase, digit/hyphen separated. */
export const MODEL_LANE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validates a lane name for creation/rename targets only. Existing free-form lane
 * names stay readable, editable in place, and deletable; this is never applied by the reader.
 */
export function isValidModelLaneName(name: string): boolean {
	return MODEL_LANE_NAME_PATTERN.test(name);
}

/** Field patch for a lane upsert; `null` clears the field, `undefined` leaves it untouched. */
export interface ModelLanePatch {
	model?: string | null;
	thinking?: ThinkingLevel | null;
}

export interface UpsertUserModelLaneMutation {
	kind: "upsert";
	agentName: string;
	laneName: string;
	/** Existing key being edited or renamed; omit to create a new lane. */
	originalLaneName?: string;
	patch: ModelLanePatch;
}

export interface RemoveUserModelLaneMutation {
	kind: "remove";
	agentName: string;
	laneName: string;
}

export type UserModelLaneMutation = UpsertUserModelLaneMutation | RemoveUserModelLaneMutation;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

/**
 * Define an own data property instead of assigning it.
 *
 * Plain assignment invokes inherited setters, so `map["__proto__"] = value`
 * would silently replace the object's prototype rather than store a lane (or an
 * agent) under that name. `JSON.parse` produces `__proto__` as an own property,
 * so a legacy settings file can genuinely contain such a key on either the agent
 * map or a lane map, and it must round-trip as data on both read and write.
 */
function setOwnKey(map: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Clones a nested map entry by own key only. `in` and bare indexing consult the prototype
 * chain, so names the managed rule accepts (`constructor`) or legacy files may hold
 * (`__proto__`) would otherwise read an inherited value instead of a missing one.
 */
function cloneOwnRecord(map: Record<string, unknown>, key: string): Record<string, unknown> {
	return Object.hasOwn(map, key) ? cloneRecord(map[key]) : {};
}

function requireName(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`Model lane mutation has an invalid ${label}; expected a non-blank string.`);
	}
	return value;
}

/**
 * Applies a batch of lane mutations to the user settings file only. The target path is
 * resolved internally, so no caller can direct a lane write at project scope.
 *
 * The current file is read once, its existing lane shape is validated with the same parser
 * reads use, every mutation is applied to a raw copy in memory, and the result is written
 * once atomically. Unrelated root fields, sibling `subagents` fields, sibling roles/lanes,
 * and unrelated properties on a targeted lane are preserved. A malformed file is rejected
 * without being written.
 *
 * Renames inside one batch are applied as a set rather than in sequence, so a swap or a
 * longer rename cycle persists in one call. Every other conflict still rejects the whole
 * batch: a create colliding with a lane nothing renames away, two renames converging on one
 * target, a stale removal, and an original lane that no longer exists.
 *
 * @returns the user settings path that was inspected (and written when mutations applied).
 */
export function applyUserModelLaneMutations(mutations: readonly UserModelLaneMutation[]): string {
	const filePath = getUserAgentSettingsPath();
	if (mutations.length === 0) return filePath;

	const settings = readSettingsFileStrict(filePath);
	// Reject a malformed lane tree before touching anything; the file stays byte-identical.
	parseModelLanes(filePath, settings.subagents);

	const root: Record<string, unknown> = { ...settings };
	const subagents = cloneRecord(root.subagents);
	const modelLanes = cloneRecord(subagents.modelLanes);
	const agentMaps = new Map<string, Record<string, unknown>>();

	const agentMapFor = (agentName: string): Record<string, unknown> => {
		const existing = agentMaps.get(agentName);
		if (existing) return existing;
		const map = cloneOwnRecord(modelLanes, agentName);
		agentMaps.set(agentName, map);
		return map;
	};

	// A batch can rename lanes in a cycle (swap `normal` and `hard`, or a -> b -> c -> a).
	// No sequential ordering of those upserts exists, so every rename source is vacated up
	// front and snapshotted as it was on disk. That makes the batch order-independent: each
	// rename target is free when its upsert runs, and each rename reads its original lane
	// rather than whatever later occupied that key. Snapshots are consumed once, so a second
	// rename off the same source still hits the stale-original rejection below.
	const renameSnapshots = new Map<string, Map<string, Record<string, unknown>>>();
	for (const mutation of mutations) {
		if (mutation.kind !== "upsert") continue;
		const { agentName, laneName, originalLaneName } = mutation;
		if (typeof agentName !== "string" || typeof laneName !== "string") continue;
		if (typeof originalLaneName !== "string" || originalLaneName === laneName) continue;
		const laneMap = agentMapFor(agentName);
		if (!Object.hasOwn(laneMap, originalLaneName)) continue;
		let agentSnapshots = renameSnapshots.get(agentName);
		if (!agentSnapshots) {
			agentSnapshots = new Map<string, Record<string, unknown>>();
			renameSnapshots.set(agentName, agentSnapshots);
		}
		if (agentSnapshots.has(originalLaneName)) continue;
		agentSnapshots.set(originalLaneName, cloneOwnRecord(laneMap, originalLaneName));
		delete laneMap[originalLaneName];
	}

	for (const mutation of mutations) {
		const agentName = requireName(mutation.agentName, "agent name");
		const laneName = requireName(mutation.laneName, "lane name");
		const laneMap = agentMapFor(agentName);

		if (mutation.kind === "remove") {
			if (!Object.hasOwn(laneMap, laneName)) {
				throw new Error(`Cannot remove model lane '${laneName}' for agent '${agentName}' in '${filePath}'; no such user lane exists.`);
			}
			delete laneMap[laneName];
			continue;
		}

		const patch = mutation.patch;
		if (!isRecord(patch)) {
			throw new Error(`Model lane '${laneName}' for agent '${agentName}' has an invalid patch; expected an object.`);
		}

		const originalLaneName = mutation.originalLaneName === undefined
			? undefined
			: requireName(mutation.originalLaneName, "original lane name");
		const laneExists = Object.hasOwn(laneMap, laneName);
		const editsInPlace = originalLaneName === laneName && laneExists;

		if (!editsInPlace) {
			// Creation and changed rename targets must satisfy the managed name rule.
			if (!isValidModelLaneName(laneName)) {
				throw new Error(
					`Invalid model lane name '${laneName}' for agent '${agentName}' in '${filePath}'; use lowercase letters, digits, and hyphens starting with a letter or digit.`,
				);
			}
			// `laneMap` already reflects earlier mutations in this batch and has had every rename
			// source vacated, so this still rejects an existing on-disk lane that nothing renames
			// away, a duplicate create/rename target, and two renames converging on one name.
			if (laneExists) {
				throw new Error(`Model lane '${laneName}' already exists for agent '${agentName}' in '${filePath}'; choose a different name.`);
			}
		}

		// Consume the pre-scan snapshot for a rename source, so a cycle reads the original lane.
		const agentSnapshots = renameSnapshots.get(agentName);
		let snapshot: Record<string, unknown> | undefined;
		if (originalLaneName !== undefined && originalLaneName !== laneName && agentSnapshots) {
			snapshot = agentSnapshots.get(originalLaneName);
			if (snapshot !== undefined) agentSnapshots.delete(originalLaneName);
		}

		// Any declared original must still be reachable. This also covers an in-place edit
		// (`originalLaneName === laneName`) whose lane vanished from disk while the overlay was
		// open: without it the lane would be resurrected holding only the patched field.
		if (originalLaneName !== undefined && snapshot === undefined && !Object.hasOwn(laneMap, originalLaneName)) {
			throw new Error(
				`Cannot edit lane '${originalLaneName}' for agent '${agentName}' in '${filePath}'; it no longer exists (possibly renamed earlier in this batch).`,
			);
		}

		const sourceKey = originalLaneName !== undefined && Object.hasOwn(laneMap, originalLaneName) ? originalLaneName : laneName;
		const nextLane = snapshot !== undefined ? { ...snapshot } : cloneOwnRecord(laneMap, sourceKey);

		if ("model" in patch) {
			const model = patch.model;
			if (model === null) delete nextLane.model;
			else if (typeof model !== "string" || model.trim() === "") {
				throw new Error(`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has an invalid 'model'; provide a non-blank model name or null to clear it.`);
			} else nextLane.model = model;
		}

		if ("thinking" in patch) {
			const thinking = patch.thinking;
			if (thinking === null) delete nextLane.thinking;
			else if (!isThinkingLevel(thinking)) {
				throw new Error(
					`Model lane '${laneName}' for agent '${agentName}' in '${filePath}' has an invalid 'thinking'; expected null or one of: ${THINKING_LEVELS.join(", ")}.`,
				);
			} else nextLane.thinking = thinking;
		}

		// Only vacate the source here when no snapshot was used. The pre-scan already removed
		// snapshotted sources, and in a cycle that key may now hold another leg's target.
		if (snapshot === undefined && originalLaneName !== undefined && originalLaneName !== laneName) {
			delete laneMap[originalLaneName];
		}
		setOwnKey(laneMap, laneName, nextLane);
	}

	for (const [agentName, laneMap] of agentMaps) {
		// Drop an emptied agent map, but keep `modelLanes` itself so removals are not reseeded.
		if (Object.keys(laneMap).length === 0) delete modelLanes[agentName];
		else setOwnKey(modelLanes, agentName, laneMap);
	}

	subagents.modelLanes = modelLanes;
	root.subagents = subagents;
	writeSettingsFile(filePath, root);
	return filePath;
}
