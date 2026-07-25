import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "../../shared/types.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
// `timed_out_escalating` is on by default because it is the last warning before a child
// is killed — the parent can still `wrap-up` on it. Terminal `timed_out`/`timeout_killed`
// stay off: by then the outcome is already visible in the run result.
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention", "timed_out_escalating"];

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 120_000,
	activeNoticeAfterMs: 240_000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
	stepInactivityTimeoutMs: 300_000,
	runWallClockTimeoutMs: 1_800_000,
	timeoutAction: "escalate_then_kill",
	escalationGraceMs: 30_000,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs)
		?? parsePositiveInt(globalConfig?.needsAttentionAfterMs)
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const activeNoticeAfterMs = parsePositiveInt(override?.activeNoticeAfterMs)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterMs)
		?? DEFAULT_CONTROL_CONFIG.activeNoticeAfterMs;
	const activeNoticeAfterTurns = parsePositiveInt(override?.activeNoticeAfterTurns)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTurns);
	const activeNoticeAfterTokens = parsePositiveInt(override?.activeNoticeAfterTokens)
		?? parsePositiveInt(globalConfig?.activeNoticeAfterTokens);
	const failedToolAttemptsBeforeAttention = parsePositiveInt(override?.failedToolAttemptsBeforeAttention)
		?? parsePositiveInt(globalConfig?.failedToolAttemptsBeforeAttention)
		?? DEFAULT_CONTROL_CONFIG.failedToolAttemptsBeforeAttention;
	const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES)
		?? parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES)
		?? DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? DEFAULT_CONTROL_CONFIG.notifyChannels;

	const stepInactivityTimeoutMs = parsePositiveInt(override?.stepInactivityTimeoutMs)
		?? parsePositiveInt(globalConfig?.stepInactivityTimeoutMs)
		?? DEFAULT_CONTROL_CONFIG.stepInactivityTimeoutMs;
	const runWallClockTimeoutMs = parsePositiveInt(override?.runWallClockTimeoutMs)
		?? parsePositiveInt(globalConfig?.runWallClockTimeoutMs)
		?? DEFAULT_CONTROL_CONFIG.runWallClockTimeoutMs;
	const timeoutAction = override?.timeoutAction ?? globalConfig?.timeoutAction ?? DEFAULT_CONTROL_CONFIG.timeoutAction;
	const escalationGraceMs = parsePositiveInt(override?.escalationGraceMs)
		?? parsePositiveInt(globalConfig?.escalationGraceMs)
		?? DEFAULT_CONTROL_CONFIG.escalationGraceMs;
	return {
		enabled,
		needsAttentionAfterMs,
		activeNoticeAfterMs,
		activeNoticeAfterTurns,
		activeNoticeAfterTokens,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
		stepInactivityTimeoutMs,
		runWallClockTimeoutMs,
		timeoutAction,
		escalationGraceMs,
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);

	// Check timeout thresholds first (higher priority than needs_attention)
	if (ageMs > input.config.stepInactivityTimeoutMs) {
		if (input.config.timeoutAction === "auto_kill") return "timed_out";
		if (input.config.timeoutAction === "escalate_then_kill") return "timed_out_escalating";
		// notify action falls through to needs_attention
	}

	if (ageMs > input.config.needsAttentionAfterMs) return "needs_attention";
	return undefined;
}

/**
 * Whether the pre-deadline wrap-up nudge is due for a run.
 *
 * Fires once at `runWallClockTimeoutMs - escalationGraceMs`, i.e. before the deadline
 * rather than after it, so a live child gets a real window to checkpoint and the parent
 * gets a warning it can still act on (`wrap-up`) instead of a corpse.
 *
 * Nudging *after* the deadline was rejected: the deadline also terminates queued work and
 * marks the run failed, so a post-deadline grace window would leave children running
 * against durable `failed` state and would break the synchronous stop that dispatch
 * gating depends on.
 *
 * Only `escalate_then_kill` nudges. `auto_kill` opts out of warning; `notify` never
 * terminates, so there is nothing to warn about.
 */
export function runTimeoutNudgeDue(
	config: ResolvedControlConfig,
	metrics: { startedAt: number; now: number },
): boolean {
	if (config.timeoutAction !== "escalate_then_kill") return false;
	const nudgeAfterMs = config.runWallClockTimeoutMs - config.escalationGraceMs;
	// A grace window at least as long as the deadline leaves no room to warn early.
	if (nudgeAfterMs <= 0) return false;
	return metrics.now - metrics.startedAt > nudgeAfterMs;
}

/**
 * Whether an already-expired run deadline should stop new work from starting.
 *
 * Applies where no child is in flight yet (run entry, and between model-fallback
 * attempts), so there is nothing to nudge and escalation is meaningless: the choice
 * is only enforce or don't. Under `notify` the deadline is advisory, so new work
 * proceeds and the run has no duration backstop — stop it with `interrupt` instead.
 */
export function runTimeoutBlocksNewWork(config: ResolvedControlConfig): boolean {
	return config.timeoutAction !== "notify";
}

export function buildControlEvent(input: {
	type?: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
	message?: string;
	reason?: ControlEvent["reason"];
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const type = input.type ?? (input.to === "active_long_running" ? "active_long_running" : "needs_attention");
	const elapsedMs = input.elapsedMs ?? (input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined);
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const message = input.message ?? (type === "active_long_running"
		? `${input.agent} is still active but long-running`
		: elapsedSeconds !== undefined
			? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
			: `${input.agent} needs attention`);
	return {
		type,
		...(input.from ? { from: input.from } : {}),
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		...(input.index !== undefined ? { index: input.index } : {}),
		message,
		reason: input.reason ?? (type === "active_long_running" ? "active_long_running" : "idle"),
		...(input.turns !== undefined ? { turns: input.turns } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.toolCount !== undefined ? { toolCount: input.toolCount } : {}),
		...(input.currentTool ? { currentTool: input.currentTool } : {}),
		...(input.currentToolDurationMs !== undefined ? { currentToolDurationMs: input.currentToolDurationMs } : {}),
		...(input.currentPath ? { currentPath: input.currentPath } : {}),
		...(elapsedMs !== undefined ? { elapsedMs } : {}),
		...(input.recentFailureSummary ? { recentFailureSummary: input.recentFailureSummary } : {}),
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	const childKey = childIntercomTarget ?? (event.index !== undefined ? `${event.runId}:${event.index}` : event.runId);
	return `${childKey}:${event.type}:${event.reason ?? "idle"}`;
}

export function claimControlNotification(config: ResolvedControlConfig, event: ControlEvent, seenKeys: Set<string>, childIntercomTarget?: string): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

function formatLongRunningFacts(event: ControlEvent): string | undefined {
	const facts: string[] = [];
	if (event.elapsedMs !== undefined) facts.push(`elapsed ${Math.floor(Math.max(0, event.elapsedMs) / 1000)}s`);
	if (event.turns !== undefined) facts.push(`${event.turns} turns`);
	if (event.tokens !== undefined) facts.push(`${event.tokens} tokens`);
	if (event.toolCount !== undefined) facts.push(`${event.toolCount} tools`);
	if (event.currentTool) facts.push(`tool ${event.currentTool}${event.currentToolDurationMs !== undefined ? ` ${Math.floor(Math.max(0, event.currentToolDurationMs) / 1000)}s` : ""}`);
	if (event.currentPath) facts.push(`path ${event.currentPath}`);
	return facts.length > 0 ? facts.join(" | ") : undefined;
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string, escalationGraceMs = DEFAULT_CONTROL_CONFIG.escalationGraceMs): string {
	const runTarget = event.runId;
	if (event.reason === "completion_guard") {
		return [
			`Subagent failed: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Next: read the output artifact or session from the subagent result, then retry with a more explicit implementation prompt or handle the fix directly.",
			childIntercomTarget ? `Run intercom target (may be inactive): ${childIntercomTarget}` : undefined,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	const nudgeCommand = childIntercomTarget
		? `intercom({ action: "send", to: "${childIntercomTarget}", message: "What are you blocked on? Reply with the smallest next step or ask for a decision." })`
		: undefined;
	if (event.type === "active_long_running") {
		const facts = formatLongRunningFacts(event);
		return [
			`Subagent active but long-running: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			facts ? `Facts: ${facts}` : undefined,
			"Hint: Inspect status, then nudge if the work seems stuck.",
			childIntercomTarget
				? `Nudge: ${nudgeCommand}`
				: "Nudge: no child message route registered",
			`Status: subagent({ action: "status", id: "${runTarget}" })`,
			`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	// --- NEW: timeout escalation notice ---
	if (event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout") {
		const elapsedSeconds = event.elapsedMs !== undefined ? Math.floor(Math.max(0, event.elapsedMs) / 1000) : undefined;
		return [
			`Subagent idle timeout: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			elapsedSeconds !== undefined ? `Idle for: ${elapsedSeconds}s` : undefined,
			childIntercomTarget
				? "Action: Nudge sent via intercom. Will terminate if no response within grace period."
				: "Action: no child message route registered. Will terminate after the grace period.",
			`Grace: subagent will be killed if no activity within ${Math.ceil(escalationGraceMs / 1000)}s`,
			`Interrupt now: subagent({ action: "interrupt", id: "${runTarget}" })`,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	// --- NEW: timeout killed notice ---
	if (event.type === "timeout_killed" || event.reason === "timeout_killed") {
		return [
			`Subagent killed (inactivity timeout): ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Action: Process terminated after inactivity timeout.",
			"The run will continue with remaining steps (if any).",
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		event.recentFailureSummary ? `Recent failures: ${event.recentFailureSummary}` : undefined,
		"Hint: Inspect status first unless the run is clearly blocked.",
		childIntercomTarget
			? `Nudge: ${nudgeCommand}`
			: "Nudge: no child message route registered",
		`Status: subagent({ action: "status", id: "${runTarget}" })`,
		`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const statusLabel = event.reason === "completion_guard"
		? "subagent failed"
		: event.type === "active_long_running"
			? "subagent active but long-running"
			: event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout"
				? "subagent idle timeout \u2014 escalating"
				: event.type === "timeout_killed" || event.reason === "timeout_killed"
					? "subagent killed (inactivity timeout)"
					: "subagent needs attention";

	return [
		statusLabel,
		"",
		event.reason === "completion_guard"
			? `${event.agent} failed in run ${event.runId}.`
			: event.type === "active_long_running"
				? `${event.agent} is still active but long-running in run ${event.runId}.`
				: event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout"
					? `${event.agent} idle timeout in run ${event.runId}. Nudge sent; will kill if no response.`
					: event.type === "timeout_killed" || event.reason === "timeout_killed"
						? `${event.agent} killed (inactivity timeout) in run ${event.runId}.`
						: `${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
