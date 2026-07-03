import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.ts";
import { resolveModelPromptRoleBlock } from "./model-prompt-role.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;
const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-prompt-runtime.ts");
const FANOUT_CHILD_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "fanout-child.ts");
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SUBAGENT_FANOUT_CHILD_ENV = "PI_SUBAGENT_FANOUT_CHILD";
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = "PI_SUBAGENT_ORCHESTRATOR_TARGET";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_CHILD_INDEX_ENV = "PI_SUBAGENT_CHILD_INDEX";
// Nested route / fanout env vars (upstream v0.25.0)
export const SUBAGENT_PARENT_EVENT_SINK_ENV = "PI_SUBAGENT_PARENT_EVENT_SINK";
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = "PI_SUBAGENT_PARENT_CONTROL_INBOX";
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_ROOT_RUN_ID";
export const SUBAGENT_PARENT_RUN_ID_ENV = "PI_SUBAGENT_PARENT_RUN_ID";
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = "PI_SUBAGENT_PARENT_CHILD_INDEX";
export const SUBAGENT_PARENT_DEPTH_ENV = "PI_SUBAGENT_PARENT_DEPTH";
export const SUBAGENT_PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = "PI_SUBAGENT_PARENT_CAPABILITY_TOKEN";

interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	tools?: string[];
	disallowedTools?: string[];
	extensions?: string[];
	systemPrompt?: string | null;
	modelPromptRole?: string;
	modelPromptRoleFallbackModel?: string;
	mcpDirectTools?: string[];
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	parentEventSink?: string;
	parentControlInbox?: string;
	parentRootRunId?: string;
	parentRunId?: string;
	parentChildIndex?: number;
	parentDepth?: number;
	parentPath?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
	parentCapabilityToken?: string;
	skipContextFiles?: boolean;
	structuredOutput?: { schemaPath: string; outputPath: string };
	childAlwaysExtensions?: string[];
}

interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

/**
 * Read the child always-load extensions from settings
 * (settings.subagents.childAlwaysExtensions).
 * Reads user settings (from userSettingsPath or ~/.pi/agent/settings.json) and
 * optionally project settings (when cwd is provided). Merges both (user first, then project),
 * deduplicates, and filters to paths that exist on disk.
 * Entries should be ABSOLUTE paths — a relative entry is checked against the
 * current process cwd and silently skipped when absent.
 * Never throws; returns empty array on any error.
 */
export function readChildAlwaysExtensions(userSettingsPath?: string, cwd?: string): string[] {
	try {
		const extensions: string[] = [];
		const seen = new Set<string>();

		// Helper to read extensions from a settings file
		const readFromFile = (filePath: string | null | undefined) => {
			if (!filePath || !fs.existsSync(filePath)) return;
			try {
				const content = fs.readFileSync(filePath, "utf-8");
				const settings = JSON.parse(content);
				const alwaysExtensions = settings?.subagents?.childAlwaysExtensions;
				if (!Array.isArray(alwaysExtensions)) return;
				for (const ext of alwaysExtensions) {
					if (typeof ext === "string" && fs.existsSync(ext) && !seen.has(ext)) {
						extensions.push(ext);
						seen.add(ext);
					}
				}
			} catch {
				// Silently skip malformed files
			}
		};

		// Read user settings first
		const userPath = userSettingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
		readFromFile(userPath);

		// Read project settings if cwd provided
		if (cwd) {
			let projectRoot: string | null = cwd;
			let found = false;
			// Walk up to find .pi or .agents directory
			while (projectRoot && projectRoot !== path.dirname(projectRoot)) {
				if (fs.existsSync(path.join(projectRoot, ".pi")) || fs.existsSync(path.join(projectRoot, ".agents"))) {
					found = true;
					break;
				}
				projectRoot = path.dirname(projectRoot);
			}
			if (found && projectRoot) {
				const projectSettingsPath = path.join(projectRoot, ".pi", "settings.json");
				readFromFile(projectSettingsPath);
			}
		}

		return extensions;
	} catch {
		// Never throw; silently return empty array on any error
		return [];
	}
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

/**
 * Strip any known thinking suffix from a model string.
 * Used when an inline thinking override needs to remove a pre-existing suffix.
 */
export function stripKnownThinkingSuffix(model: string): string {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model.substring(0, colonIdx);
	return model;
}

/**
 * Apply effective thinking level to a model string, stripping any pre-existing known suffix first.
 * Handles "off" by stripping without re-appending.
 */
export function applyEffectiveThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model) return model;
	if (!thinking) return model;
	const stripped = stripKnownThinkingSuffix(model);
	if (thinking === "off") return stripped;
	return `${stripped}:${thinking}`;
}

export function buildModelThinkingOverride(
	modelOverride: string | undefined,
	thinking: string | undefined,
): { model?: string; thinking?: string } {
	const override: { model?: string; thinking?: string } = {};
	if (modelOverride) {
		override.model = thinking ? stripKnownThinkingSuffix(modelOverride) : modelOverride;
	}
	if (thinking) {
		override.thinking = thinking;
	}
	return override;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyEffectiveThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	const declaredBuiltinTools = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = [];
	if (input.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of input.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (input.disallowedTools?.length) {
			const denied = new Set(input.disallowedTools);
			const filtered = builtinTools.filter((t) => !denied.has(t));
			builtinTools.length = 0;
			builtinTools.push(...filtered);
		}
		if (builtinTools.length > 0) {
			if (input.mcpDirectTools?.length) {
				builtinTools.push(...resolveMcpDirectToolNames(input.mcpDirectTools, input.cwd));
			}
			if (input.structuredOutput && !builtinTools.includes("structured_output")) {
				builtinTools.push("structured_output");
			}
			args.push("--tools", builtinTools.join(","));
		}
	}

	const runtimeExtensions = fanoutAuthorized
		? [PROMPT_RUNTIME_EXTENSION_PATH, FANOUT_CHILD_EXTENSION_PATH]
		: [PROMPT_RUNTIME_EXTENSION_PATH];
	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		// Get child always-set extensions (either from override or by reading settings)
		const rawAlwaysExtensions =
			input.childAlwaysExtensions !== undefined
				? input.childAlwaysExtensions
				: readChildAlwaysExtensions(undefined, input.cwd);
		// Filter always-extensions to those that exist on disk
		const alwaysExtensions = rawAlwaysExtensions.filter((ext) => fs.existsSync(ext));
		for (const extPath of [
			...new Set([
				...runtimeExtensions,
				...toolExtensionPaths,
				...alwaysExtensions,
				...input.extensions,
			]),
		]) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths])]) {
			args.push("--extension", extPath);
		}
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);

		// Inject model prompt role block if applicable
		let finalSystemPrompt = input.systemPrompt;
		if (input.modelPromptRole) {
			const resolveModel = input.model ?? input.modelPromptRoleFallbackModel;
			const roleBlock = resolveModelPromptRoleBlock(resolveModel, input.modelPromptRole);
			if (roleBlock) {
				finalSystemPrompt = `${finalSystemPrompt}\n\n${roleBlock.block}`;
			}
		}

		fs.writeFileSync(promptPath, finalSystemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = fanoutAuthorized ? "1" : "0";
	env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = input.inheritProjectContext ? "1" : "0";
	if (input.skipContextFiles) {
		args.push("--no-context-files");
	}
	env.PI_SUBAGENT_INHERIT_SKILLS = input.inheritSkills ? "1" : "0";
	if (input.intercomSessionName) {
		env.PI_SUBAGENT_INTERCOM_SESSION_NAME = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	if (input.runId) {
		env[SUBAGENT_RUN_ID_ENV] = input.runId;
	}
	if (input.childAgentName) {
		env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
	}
	if (input.childIndex !== undefined) {
		env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	}
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}

	// Nested route env propagation (upstream v0.25.0)
	if (input.parentEventSink) env[SUBAGENT_PARENT_EVENT_SINK_ENV] = input.parentEventSink;
	if (input.parentControlInbox) env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = input.parentControlInbox;
	if (input.parentRootRunId) env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = input.parentRootRunId;
	if (input.parentRunId) env[SUBAGENT_PARENT_RUN_ID_ENV] = input.parentRunId;
	if (input.parentChildIndex !== undefined) env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = String(input.parentChildIndex);
	if (input.parentDepth !== undefined) env[SUBAGENT_PARENT_DEPTH_ENV] = String(input.parentDepth);
	if (input.parentPath) env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify(input.parentPath);
	if (input.parentCapabilityToken) env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = input.parentCapabilityToken;

	if (input.structuredOutput) {
		env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
		env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
	}

	return { args, env, tempDir };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}
