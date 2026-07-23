/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { OutputMode } from "../shared/types.ts";
import type { MemoryScope } from "../shared/memory.ts";
export type { MemoryScope } from "../shared/memory.ts";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseChain } from "./chain-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";
type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork" | "lineage";

export function defaultSystemPromptMode(_name: string): SystemPromptMode {
	return "replace";
}

export function defaultInheritProjectContext(_name: string): boolean {
	return false;
}

export function defaultInheritSkills(): boolean {
	return false;
}

export interface BuiltinAgentOverrideBase {
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	modelPromptRole?: string;
	disabled?: boolean;
	systemPrompt: string;
	skills?: string[];
	tools?: string[];
	mcpDirectTools?: string[];
	disallowedTools?: string[];
	/** Persistent agent memory scope — agents with memory get a persistent directory and MEMORY.md */
	memory?: MemoryScope;
}

interface BuiltinAgentOverrideConfig {
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext | false;
	modelPromptRole?: string | false;
	disabled?: boolean;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
	addTools?: string[];
	disallowedTools?: string[] | false;
	memory?: MemoryScope | false;
}

interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	/** Tool denylist — these built-in tools are removed even if `tools` includes them. */
	disallowedTools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	modelPromptRole?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	memory?: MemoryScope;
	interactive?: boolean;
	maxSubagentDepth?: number;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
}

interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	disableBuiltins?: boolean;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

export interface ChainStepConfig {
	agent: string;
	task: string;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
}

export interface ChainConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function getUserChainDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "chains");
}

function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const mcpDirectTools: string[] = [];
	const tools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			mcpDirectTools.push(tool.slice(4));
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

function joinToolList(config: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined {
	const joined = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	return joined.length > 0 ? joined : undefined;
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		modelPromptRole: agent.modelPromptRole,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		mcpDirectTools: agent.mcpDirectTools ? [...agent.mcpDirectTools] : undefined,
		disallowedTools: agent.disallowedTools ? [...agent.disallowedTools] : undefined,
		memory: agent.memory,
	};
}

function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
	return {
		...(override.model !== undefined ? { model: override.model } : {}),
		...(override.fallbackModels !== undefined
			? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
			: {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
		...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
		...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
		...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
		...(override.modelPromptRole !== undefined ? { modelPromptRole: override.modelPromptRole } : {}),
		...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
		...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
		...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
		...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
		...(override.addTools !== undefined ? { addTools: [...override.addTools] } : {}),
		...(override.disallowedTools !== undefined
			? { disallowedTools: override.disallowedTools === false ? false : [...override.disallowedTools] }
			: {}),
		...(override.memory !== undefined ? { memory: override.memory } : {}),
	};
}

function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"))) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function getUserAgentSettingsPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getProjectAgentSettingsPath(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? path.join(projectRoot, ".pi", "settings.json") : null;
}

export function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const content = JSON.stringify(settings, null, 2) + "\n";
	const tmpPath = `${filePath}.tmp.${process.pid}`;
	try {
		fs.writeFileSync(tmpPath, content, "utf-8");
		try {
			fs.renameSync(tmpPath, filePath);
		} catch (renameErr: unknown) {
			// On Windows, rename may throw EEXIST when the target exists.
			// Fall back to remove-then-rename only in that case.
			if (renameErr && typeof renameErr === "object" && "code" in renameErr && (renameErr as { code: string }).code === "EEXIST") {
				fs.unlinkSync(filePath);
				fs.renameSync(tmpPath, filePath);
			} else {
				throw renameErr;
			}
		}
	} catch (error) {
		// Clean up temp file on failure
		try { fs.unlinkSync(tmpPath); } catch {}
		throw error;
	}
}

function parseOverrideStringArrayOrFalse(
	value: unknown,
	meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
	if (value === undefined) return undefined;
	if (value === false) return false;
	if (!Array.isArray(value)) {
		throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
		}
		const trimmed = item.trim();
		if (trimmed) items.push(trimmed);
	}
	return items;
}

function parseBuiltinOverrideEntry(
	name: string,
	value: unknown,
	filePath: string,
): BuiltinAgentOverrideConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
	}

	const input = value as Record<string, unknown>;
	const override: BuiltinAgentOverrideConfig = {};

	if ("model" in input) {
		if (typeof input.model === "string" || input.model === false) override.model = input.model;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
	}

	if ("thinking" in input) {
		if (typeof input.thinking === "string" || input.thinking === false) override.thinking = input.thinking;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
	}

	if ("systemPromptMode" in input) {
		if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
			override.systemPromptMode = input.systemPromptMode;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
		}
	}

	if ("inheritProjectContext" in input) {
		if (typeof input.inheritProjectContext === "boolean") {
			override.inheritProjectContext = input.inheritProjectContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
		}
	}

	if ("inheritSkills" in input) {
		if (typeof input.inheritSkills === "boolean") {
			override.inheritSkills = input.inheritSkills;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
		}
	}

	if ("defaultContext" in input) {
		if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === "lineage" || input.defaultContext === false) {
			override.defaultContext = input.defaultContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', 'lineage', or false.`);
		}
	}

	if ("modelPromptRole" in input) {
		if (input.modelPromptRole === false) {
			override.modelPromptRole = false;
		} else if (typeof input.modelPromptRole === "string") {
			const trimmed = input.modelPromptRole.trim();
			override.modelPromptRole = trimmed || undefined;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'modelPromptRole'; expected a string or false.`);
		}
	}

	if ("disabled" in input) {
		if (typeof input.disabled === "boolean") {
			override.disabled = input.disabled;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
		}
	}

	if ("systemPrompt" in input) {
		if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
	}

	const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, { filePath, name, field: "fallbackModels" });
	if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

	const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
	if (skills !== undefined) override.skills = skills;

	const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
	if (tools !== undefined) override.tools = tools;

	if ("addTools" in input) {
		if (input.addTools === undefined) {
			// undefined is fine, just skip
		} else if (!Array.isArray(input.addTools)) {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'addTools'; expected an array of strings.`);
		} else {
			const items: string[] = [];
			for (const item of input.addTools) {
				if (typeof item !== "string") {
					throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'addTools'; expected an array of strings.`);
				}
				const trimmed = item.trim();
				if (trimmed) items.push(trimmed);
			}
			if (items.length > 0) override.addTools = items;
		}
	}

	const disallowedTools = parseOverrideStringArrayOrFalse(input.disallowedTools, { filePath, name, field: "disallowedTools" });
	if (disallowedTools !== undefined) override.disallowedTools = disallowedTools;

	if ("memory" in input) {
		if (input.memory === "project" || input.memory === false) override.memory = input.memory;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'memory'; expected 'project' or false.`);
	}

	return Object.keys(override).length > 0 ? override : undefined;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
	if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return EMPTY_SUBAGENT_SETTINGS;

	const subagentsObject = subagents as Record<string, unknown>;
	let disableBuiltins: boolean | undefined;
	if ("disableBuiltins" in subagentsObject) {
		if (typeof subagentsObject.disableBuiltins === "boolean") {
			disableBuiltins = subagentsObject.disableBuiltins;
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
		}
	}

	const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
	const agentOverrides = subagentsObject.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		return { overrides: parsed, disableBuiltins };
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		const override = parseBuiltinOverrideEntry(name, value, filePath);
		if (override) parsed[name] = override;
	}
	return { overrides: parsed, disableBuiltins };
}

function applyBuiltinOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = {
		...agent,
		override: { ...meta, base: cloneOverrideBase(agent) },
	};

	if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
	if (override.fallbackModels !== undefined) {
		next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
	}
	if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
	if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
	if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
	if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
	if (override.defaultContext !== undefined) next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
	if (override.modelPromptRole !== undefined) next.modelPromptRole = override.modelPromptRole === false ? undefined : override.modelPromptRole;
	if (override.disabled !== undefined) next.disabled = override.disabled;
	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
	if (override.tools !== undefined) {
		const { tools, mcpDirectTools } = splitToolList(override.tools === false ? [] : override.tools);
		next.tools = tools;
		next.mcpDirectTools = mcpDirectTools;
	}

	if (override.addTools !== undefined && override.addTools.length > 0) {
		// addTools is only applied if we have a defined baseline (tools or mcpDirectTools)
		// If tools === undefined (no allowlist), addTools is a no-op
		if (next.tools !== undefined || next.mcpDirectTools !== undefined) {
			const { tools: addedTools, mcpDirectTools: addedMcpDirectTools } = splitToolList(override.addTools);
			const existingTools = new Set(next.tools ?? []);
			const existingMcpDirectTools = new Set(next.mcpDirectTools ?? []);

			// Add new regular tools, deduping against existing
			if (addedTools) {
				for (const tool of addedTools) {
					if (!existingTools.has(tool)) {
						existingTools.add(tool);
						if (!next.tools) next.tools = [];
						next.tools.push(tool);
					}
				}
			}

			// Add new mcp direct tools, deduping against existing
			if (addedMcpDirectTools) {
				for (const tool of addedMcpDirectTools) {
					if (!existingMcpDirectTools.has(tool)) {
						existingMcpDirectTools.add(tool);
						if (!next.mcpDirectTools) next.mcpDirectTools = [];
						next.mcpDirectTools.push(tool);
					}
				}
			}
		}
	}

	if (override.disallowedTools !== undefined) {
		next.disallowedTools = override.disallowedTools === false ? undefined : [...override.disallowedTools];
	}
	if (override.memory !== undefined) next.memory = override.memory === false ? undefined : override.memory;

	return next;
}

function applyBuiltinOverrides(
	builtinAgents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
	const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;

	return builtinAgents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}

		if (projectBulkDisabled && projectSettingsPath) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath });
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}

		if (userBulkDisabled) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath });
		}

		return agent;
	});
}

/**
 * Apply per-agent overrides from settings.json to non-builtin (user/project) agents.
 * Same merge semantics as applyBuiltinOverrides but without the disableBuiltins logic,
 * which only applies to builtin agents.
 *
 * Overrides keyed by a builtin agent name are intended for the builtin, not for a
 * user/project agent that shadows it by name. We skip agents whose name collides
 * with a builtin to preserve the shadowing contract.
 */
function applySettingsOverridesToAgents(
	agents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
	builtinNames: Set<string>,
): AgentConfig[] {
	return agents.map((agent) => {
		// Skip agents that shadow a builtin — the override is meant for the builtin,
		// not the user/project agent with the same name.
		if (builtinNames.has(agent.name)) return agent;

		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}
		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}
		return agent;
	});
}
export function buildBuiltinOverrideConfig(
	base: BuiltinAgentOverrideBase,
	draft: Pick<AgentConfig, "model" | "fallbackModels" | "thinking" | "systemPromptMode" | "inheritProjectContext" | "inheritSkills" | "defaultContext" | "modelPromptRole" | "disabled" | "systemPrompt" | "skills" | "tools" | "mcpDirectTools" | "disallowedTools" | "memory">,
): BuiltinAgentOverrideConfig | undefined {
	const override: BuiltinAgentOverrideConfig = {};

	if (draft.model !== base.model) override.model = draft.model ?? false;
	if (!arraysEqual(draft.fallbackModels, base.fallbackModels)) override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
	if (draft.thinking !== base.thinking) override.thinking = draft.thinking ?? false;
	if (draft.systemPromptMode !== base.systemPromptMode) override.systemPromptMode = draft.systemPromptMode;
	if (draft.inheritProjectContext !== base.inheritProjectContext) override.inheritProjectContext = draft.inheritProjectContext;
	if (draft.inheritSkills !== base.inheritSkills) override.inheritSkills = draft.inheritSkills;
	if (draft.defaultContext !== base.defaultContext) override.defaultContext = draft.defaultContext ?? false;
	if (draft.modelPromptRole !== base.modelPromptRole) override.modelPromptRole = draft.modelPromptRole ?? false;
	if (draft.disabled !== base.disabled) override.disabled = draft.disabled ?? false;
	if (draft.systemPrompt !== base.systemPrompt) override.systemPrompt = draft.systemPrompt;
	if (!arraysEqual(draft.skills, base.skills)) override.skills = draft.skills ? [...draft.skills] : false;

	const baseTools = joinToolList(base);
	const draftTools = joinToolList(draft);
	if (!arraysEqual(draftTools, baseTools)) override.tools = draftTools ? [...draftTools] : false;

	if (!arraysEqual(draft.disallowedTools, base.disallowedTools)) override.disallowedTools = draft.disallowedTools ? [...draft.disallowedTools] : false;
	if (draft.memory !== base.memory) override.memory = draft.memory ?? false;

	return Object.keys(override).length > 0 ? override : undefined;
}

export function saveBuiltinAgentOverride(
	cwd: string,
	name: string,
	scope: "user" | "project",
	override: BuiltinAgentOverrideConfig,
): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? { ...(settings.subagents as Record<string, unknown>) }
		: {};
	const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
		? { ...(subagents.agentOverrides as Record<string, unknown>) }
		: {};

	// Merge into the existing entry so that fields not present in the incoming
	// override (e.g. tools, skills, fallbackModels, memory) are preserved.
	const existingRaw = agentOverrides[name];
	const existing = (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw))
		? existingRaw as Record<string, unknown>
		: {};
	agentOverrides[name] = { ...existing, ...cloneOverrideValue(override) };
	subagents.agentOverrides = agentOverrides;
	settings.subagents = subagents;
	writeSettingsFile(filePath, settings);
	return filePath;
}

export function removeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project"): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");
	if (!fs.existsSync(filePath)) return filePath;

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return filePath;
	const nextSubagents = { ...(subagents as Record<string, unknown>) };
	const agentOverrides = nextSubagents.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) return filePath;

	const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
	const entry = nextOverrides[name];
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		// Only strip model/thinking keys — preserve tools, skills, fallbackModels, etc.
		const nextEntry = { ...(entry as Record<string, unknown>) };
		delete nextEntry.model;
		delete nextEntry.thinking;
		if (Object.keys(nextEntry).length > 0) {
			nextOverrides[name] = nextEntry;
		} else {
			delete nextOverrides[name];
		}
	} else {
		delete nextOverrides[name];
	}
	if (Object.keys(nextOverrides).length > 0) nextSubagents.agentOverrides = nextOverrides;
	else delete nextSubagents.agentOverrides;

	if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
	else delete settings.subagents;

	writeSettingsFile(filePath, settings);
	return filePath;
}

function listMarkdownFilesRecursive(dir: string, predicate: (fileName: string) => boolean): string[] {
	const files: string[] = [];
	if (!fs.existsSync(dir)) return files;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return files;
	}

	for (const entry of entries) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listMarkdownFilesRecursive(filePath, predicate));
			continue;
		}
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!predicate(entry.name)) continue;
		files.push(filePath);
	}
	return files;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	for (const filePath of listMarkdownFilesRecursive(dir, (fileName) => fileName.endsWith(".md") && !fileName.endsWith(".chain.md") && fileName !== "SKILL.md")) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const localName = frontmatter.name;
		const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
		if (parsedPackage.error) continue;
		const packageName = parsedPackage.packageName;
		const runtimeName = buildRuntimeName(localName, packageName);

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		const rawDisallowedTools = frontmatter.disallowedTools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const memory = frontmatter.memory === "project"
			? "project" as const
			: undefined;
		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const fallbackModels = frontmatter.fallbackModels
			?.split(",")
			.map((model) => model.trim())
			.filter(Boolean);
		const systemPromptMode = frontmatter.systemPromptMode === "replace"
			? "replace"
			: frontmatter.systemPromptMode === "append"
				? "append"
				: defaultSystemPromptMode(localName);
		const inheritProjectContext = frontmatter.inheritProjectContext === "true"
			? true
			: frontmatter.inheritProjectContext === "false"
				? false
				: defaultInheritProjectContext(localName);
		const inheritSkills = frontmatter.inheritSkills === "true"
			? true
			: frontmatter.inheritSkills === "false"
				? false
				: defaultInheritSkills();
		const defaultContext = frontmatter.defaultContext === "fork"
			? "fork" as const
			: frontmatter.defaultContext === "lineage"
				? "lineage" as const
				: frontmatter.defaultContext === "fresh"
					? "fresh" as const
					: undefined;

		const modelPromptRole = typeof frontmatter.modelPromptRole === "string" && frontmatter.modelPromptRole.trim()
			? frontmatter.modelPromptRole.trim()
			: undefined;

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			// The frontmatter parser is plain key:value, so YAML-flow lists
			// ("[]", "[a.ts, b.ts]") arrive as strings — strip the brackets so
			// `extensions: []` means "empty list", not a literal "[]" path.
			let raw = frontmatter.extensions.trim();
			if (raw.startsWith("[") && raw.endsWith("]")) raw = raw.slice(1, -1);
			extensions = raw
				.split(",")
				.map((e) => {
					let trimmed = e.trim();
					// Strip one pair of matching surrounding quotes (single or double)
					if (
						trimmed.length >= 2 &&
						((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
							(trimmed.startsWith("'") && trimmed.endsWith("'")))
					) {
						trimmed = trimmed.slice(1, -1);
					}
					return trimmed;
				})
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);

		agents.push({
			name: runtimeName,
			localName,
			packageName,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			disallowedTools: rawDisallowedTools && rawDisallowedTools.length > 0 ? rawDisallowedTools : undefined,
			memory,
			model: frontmatter.model,
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			thinking: frontmatter.thinking,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			defaultContext,
			modelPromptRole,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			disabled: frontmatter.disabled === "true" ? true : undefined,
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth:
				Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
					? parsedMaxSubagentDepth
					: undefined,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
	const chains: ChainConfig[] = [];

	for (const filePath of listMarkdownFilesRecursive(dir, (fileName) => fileName.endsWith(".chain.md"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source as Exclude<AgentSource, "builtin">, filePath));
		} catch (error) {
			// A malformed chain file silently vanishing means the user's chain
			// "doesn't exist" with zero feedback. Surface the parse failure.
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`[pi-subagents] Skipping malformed chain file '${filePath}': ${message}`);
		}
	}

	return chains;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const legacyDir = path.join(projectRoot, ".agents");
	const preferredDir = path.join(projectRoot, ".pi", "agents");
	const readDirs: string[] = [];
	if (isDirectory(legacyDir)) readDirs.push(legacyDir);
	if (isDirectory(preferredDir)) readDirs.push(preferredDir);

	return {
		readDirs,
		preferredDir,
	};
}

function resolveNearestProjectChainDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const projectRoot = findNearestProjectRoot(cwd);
	if (!projectRoot) return { readDirs: [], preferredDir: null };

	const preferredDir = path.join(projectRoot, ".pi", "chains");
	return {
		readDirs: isDirectory(preferredDir) ? [preferredDir] : [],
		preferredDir,
	};
}
const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
const BUILTIN_CHAINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "chains");

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(projectSettingsPath);

	const rawBuiltins = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const builtinNames = new Set(rawBuiltins.map((a) => a.name));
	const builtinAgents = applyBuiltinOverrides(
		rawBuiltins,
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgentsOld = scope === "project" ? [] : loadAgentsFromDir(userDirOld, "user");
	const userAgentsNew = scope === "project" ? [] : loadAgentsFromDir(userDirNew, "user");
	const userAgents = applySettingsOverridesToAgents(
		[...userAgentsOld, ...userAgentsNew],
		userSettings, projectSettings, userSettingsPath, projectSettingsPath,
		builtinNames,
	);

	const projectAgents = applySettingsOverridesToAgents(
		scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")),
		userSettings, projectSettings, userSettingsPath, projectSettingsPath,
		builtinNames,
	);
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents)
		.filter((agent) => agent.disabled !== true);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
	userChainDir: string;
	projectChainDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
} {
	const userDirOld = path.join(os.homedir(), ".pi", "agent", "agents");
	const userDirNew = path.join(os.homedir(), ".agents");
	const userChainDir = getUserChainDir();
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = readSubagentSettings(userSettingsPath);
	const projectSettings = readSubagentSettings(projectSettingsPath);

	const rawBuiltins = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const builtinNames = new Set(rawBuiltins.map((a) => a.name));
	const builtin = applyBuiltinOverrides(
		rawBuiltins,
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = applySettingsOverridesToAgents(
		[
			...loadAgentsFromDir(userDirOld, "user"),
			...loadAgentsFromDir(userDirNew, "user"),
		],
		userSettings, projectSettings, userSettingsPath, projectSettingsPath,
		builtinNames,
	);
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = applySettingsOverridesToAgents(
		Array.from(projectMap.values()),
		userSettings, projectSettings, userSettingsPath, projectSettingsPath,
		builtinNames,
	);

	const chainMap = new Map<string, ChainConfig>();
	for (const dir of projectChainDirs) {
		for (const chain of loadChainsFromDir(dir, "project")) {
			chainMap.set(chain.name, chain);
		}
	}
	const chains = [
		...loadChainsFromDir(BUILTIN_CHAINS_DIR, "builtin"),
		...loadChainsFromDir(userChainDir, "user"),
		...Array.from(chainMap.values()),
	];

	const userDir = fs.existsSync(userDirNew) ? userDirNew : userDirOld;

	return { builtin, user, project, chains, userDir, projectDir, userChainDir, projectChainDir, userSettingsPath, projectSettingsPath };
}
