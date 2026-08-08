import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlConfig, ControlEventType, ControlNotificationChannel, ExtensionConfig, IntercomBridgeConfig } from "../shared/types.ts";
import { sanitizeToolBudget } from "../runs/shared/tool-budget.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sanitizeControlConfig(value: unknown): ControlConfig | undefined {
	if (!isRecord(value)) return undefined;
	const control: ControlConfig = {};
	if (typeof value.enabled === "boolean") control.enabled = value.enabled;
	for (const key of ["needsAttentionAfterMs", "activeNoticeAfterMs", "activeNoticeAfterTurns", "activeNoticeAfterTokens", "failedToolAttemptsBeforeAttention", "stepInactivityTimeoutMs", "runWallClockTimeoutMs", "escalationGraceMs"] as const) {
		const parsed = positiveInt(value[key]);
		if (parsed !== undefined) control[key] = parsed;
	}
	if (value.timeoutAction === "notify" || value.timeoutAction === "auto_kill" || value.timeoutAction === "escalate_then_kill") control.timeoutAction = value.timeoutAction;
	const notifyOn = Array.isArray(value.notifyOn)
		? value.notifyOn.filter((entry): entry is ControlEventType => typeof entry === "string" && ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"].includes(entry))
		: [];
	if (notifyOn.length > 0) control.notifyOn = [...new Set(notifyOn)];
	const notifyChannels = Array.isArray(value.notifyChannels)
		? value.notifyChannels.filter((entry): entry is ControlNotificationChannel => typeof entry === "string" && ["event", "async", "intercom"].includes(entry))
		: [];
	if (notifyChannels.length > 0) control.notifyChannels = [...new Set(notifyChannels)];
	return control;
}

function sanitizeIntercomBridge(value: unknown): IntercomBridgeConfig | undefined {
	if (!isRecord(value)) return undefined;
	const bridge: IntercomBridgeConfig = {};
	if (value.mode === "off" || value.mode === "fork-only" || value.mode === "always") bridge.mode = value.mode;
	if (typeof value.instructionFile === "string") bridge.instructionFile = value.instructionFile;
	return bridge;
}

export function sanitizeConfig(value: unknown): ExtensionConfig {
	if (!isRecord(value)) return {};
	const config: ExtensionConfig = {};
	for (const key of ["asyncByDefault", "forceTopLevelAsync"] as const) {
		if (typeof value[key] === "boolean") config[key] = value[key];
	}
	for (const key of ["maxSubagentDepth", "sessionTokenBudget", "worktreeSetupHookTimeoutMs", "inlineReadMaxBytes", "dynamicFanoutMaxItems"] as const) {
		const parsed = positiveInt(value[key]);
		if (parsed !== undefined) config[key] = parsed;
	}
	for (const key of ["defaultSessionDir", "worktreeSetupHook"] as const) {
		if (typeof value[key] === "string") config[key] = value[key];
	}
	const control = sanitizeControlConfig(value.control);
	if (control) config.control = control;
	if (isRecord(value.parallel)) {
		const parallel: NonNullable<ExtensionConfig["parallel"]> = {};
		for (const key of ["maxTasks", "concurrency"] as const) {
			const parsed = positiveInt(value.parallel[key]);
			if (parsed !== undefined) parallel[key] = parsed;
		}
		config.parallel = parallel;
	}
	const intercomBridge = sanitizeIntercomBridge(value.intercomBridge);
	if (intercomBridge) config.intercomBridge = intercomBridge;
	const toolBudget = sanitizeToolBudget(value.toolBudget);
	if (toolBudget) config.toolBudget = toolBudget;
	return config;
}

export function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) return sanitizeConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")));
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}
