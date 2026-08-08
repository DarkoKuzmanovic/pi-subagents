/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export type OutputMode = "inline" | "file-only";

export type JsonSchemaObject = Record<string, unknown>;

export interface ChainOutputMapEntry {
	text: string;
	structured?: unknown;
	agent: string;
	stepIndex: number;
}

export type ChainOutputMap = Record<string, ChainOutputMapEntry>;

export interface SavedOutputReference {
	path: string;
	bytes: number;
	lines: number;
	message: string;
}

interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention" | "timed_out_escalating" | "timed_out";
export type ControlEventType = ActivityState | "timeout_killed";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
	stepInactivityTimeoutMs?: number;
	runWallClockTimeoutMs?: number;
	timeoutAction?: "notify" | "escalate_then_kill" | "auto_kill";
	escalationGraceMs?: number;
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
	stepInactivityTimeoutMs: number;
	runWallClockTimeoutMs: number;
	timeoutAction: "notify" | "escalate_then_kill" | "auto_kill";
	escalationGraceMs: number;
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold" | "step_inactivity_timeout" | "run_wall_clock_timeout" | "timeout_killed";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "detached";
export type SubagentRunMode = "single" | "parallel" | "chain";

export interface SubagentResultIntercomChild {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
	children?: PublicNestedRunSummary[];
}

export interface SubagentResultIntercomPayload {
	[key: string]: unknown;
	to: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
}

// ============================================================================
// Durable Async OM Protocol (M6.1 foundation)
// ============================================================================

export interface OriginParentBindingV1 {
	sessionFile: string;
	sessionHeaderId: string;
	rootEntryId: string;
	launchLeafId: string;
	launchCwd: string;
}

export interface AsyncOmConsumerRegistrationV1 {
	consumerId: typeof ASYNC_OM_CONSUMER_ID;
	contractVersion: typeof ASYNC_OM_CONTRACT_VERSION;
	originParent: OriginParentBindingV1;
}

export interface AsyncChildDeliveryBindingV1 {
	deliveryId: string;
	runId: string;
	runNonce: string;
	childId: string;
	consumer: AsyncOmConsumerRegistrationV1;
}

export interface AsyncChildSlotV1 {
	logicalChildKey: string;
	childId: string;
	agentName: string;
	allocation: "static" | "dynamic";
}

export interface AsyncOmLaunchManifestV1 {
	schemaVersion: typeof ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION;
	runId: string;
	runNonce: string;
	consumer: AsyncOmConsumerRegistrationV1;
	nextChildSequence: number;
	childSlots: Record<string, AsyncChildSlotV1>;
}

export interface AsyncOmCompletionOutboxV1 {
	schemaVersion: typeof ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION;
	delivery: AsyncChildDeliveryBindingV1;
	completedAt: string;
	snapshot: {
		entries: unknown[];
		sha256: string;
		byteLength: number;
	};
}

export interface AsyncOmCompletionReceiptV1 {
	schemaVersion: typeof ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION;
	consumerId: typeof ASYNC_OM_CONSUMER_ID;
	contractVersion: typeof ASYNC_OM_CONTRACT_VERSION;
	delivery: AsyncChildDeliveryBindingV1;
	importedAt: string;
	snapshotSha256: string;
	snapshotByteLength: number;
	outboxSha256: string;
	inboxSha256: string;
	receiptSha256: string;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index?: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

export interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
	status?: AgentProgress["status"];
	index?: number;
	agent?: string;
	task?: string;
	skills?: string[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentTools?: AgentProgress["recentTools"];
	recentOutput?: string[];
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	/** Non-fatal note: the child was drain-killed after its clean final message and had stderr output (preserved tail). */
	drainWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	/** Validated structured output value, present when the step declared an outputSchema and the child called structured_output. */
	structuredOutput?: unknown;
}

export interface BudgetSummary {
	limit: number;
	spentOutput: number;
	remainingOutput: number;
	exhausted: boolean;
	overshootOutput: number;
}

export interface BudgetExhaustedEvent {
	runId: string;
	mode: "single" | "parallel" | "chain";
	budget: BudgetSummary;
	skippedFromStepIndex?: number;
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	context?: "fresh" | "fork" | "lineage";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	budget?: BudgetSummary;
	budgetExhausted?: boolean;
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["recon", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export interface AsyncStartedEvent {
	id?: string;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	nestedRoute?: NestedRouteInfo;
}

export interface AsyncStatus {
	runId: string;
	sessionId?: string;
	mode: SubagentRunMode;
	state: "queued" | "running" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: Array<{
		agent: string;
		/** Note: both "complete" and "completed" accepted for backwards compatibility. Prefer "complete" when setting. */
		status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
		sessionFile?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
	error?: string;
	children?: NestedRunSummary[];
}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed" | "paused";
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode?: SubagentRunMode;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	controlEventCursor?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	status: SubagentResultStatus;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
}

export interface ForegroundControl {
	runId: string;
	mode: SubagentRunMode;
	startedAt: number;
	updatedAt: number;
	currentAgent?: string;
	currentIndex?: number;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	tokens?: number;
	nestedChildren?: NestedRunSummary[];
	children?: NestedRunSummary[];
	nestedRoute?: NestedRouteInfo;
	interrupt?: () => boolean;
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	foregroundRuns: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, ForegroundControl>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices: Map<string, NodeJS.Timeout>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: NodeJS.Timeout | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";
export const SUBAGENT_BUDGET_EXHAUSTED_EVENT = "subagent:budget-exhausted";
export const ASYNC_OM_CONSUMER_ID = "observational-memory";
export const ASYNC_OM_CONTRACT_VERSION = 1;
export const ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION = 1;
export const ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION = 1;
export const ASYNC_OM_DELIVERY_PREFIX = "om-async-v1";
export const ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION = 1;

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	/** Shared foreground-run start timestamp used to enforce one wall-clock deadline across retries, siblings, and queued work. */
	runStartedAt?: number;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Current parent-session full model id (format: "provider/id") for modelPromptRole fallback */
	currentModelFullId?: string;
	/** Inline thinking level override for this dispatch (overrides agent config) */
	effectiveThinking?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	/** Skip loading context files (AGENTS.md etc.) for fresh-context children */
	skipContextFiles?: boolean;
	nestedRoute?: NestedRouteInfo;
	/** When set, the child must finish by calling structured_output with a schema-valid value; the validated value is attached to the result. */
	outputSchema?: JsonSchemaObject;
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

/** Per-child tool-call budget. Enforcement lives in src/runs/shared/tool-budget.ts, inside the child process. */
export interface ToolBudget {
	/** Nudge the child once it has made this many tool calls. Ignored unless it is below `hard`. */
	soft?: number;
	/** Once this many tool calls have been made, budgeted tools are blocked for the rest of the run. */
	hard: number;
	/** Tool names to block at the hard limit. Omit to block everything except the always-allowed tools. */
	block?: string[];
}
export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	/** Default per-run output-token launch budget. Prevents new children from starting once spent output tokens reach the ceiling; in-flight children are never killed. */
	sessionTokenBudget?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	intercomBridge?: IntercomBridgeConfig;
	inlineReadMaxBytes?: number;
	/** Default cap on dynamic-fanout expanded items when a step omits expand.maxItems. */
	dynamicFanoutMaxItems?: number;
	/** Per-child tool-call budget, enforced inside the child process. See src/runs/shared/tool-budget.ts. */
	toolBudget?: ToolBudget;
}
// ============================================================================
// Nested run types (upstream v0.25.0 fanout feature)
// ============================================================================

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused";

export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedStepSummary {
	agent: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "paused";
	sessionFile?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt?: number;
	endedAt?: number;
	error?: string;
	children?: NestedRunSummary[];
}

// Public projection of NestedStepSummary for intercom payloads
export type PublicNestedStepSummary = Pick<
	NestedStepSummary,
	"agent" | "status" | "sessionFile" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "startedAt" | "endedAt" | "error"
> & {
	children?: PublicNestedRunSummary[];
};

export interface NestedRunSummary extends NestedRunAddress {
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: NestedStepSummary[];
	children?: NestedRunSummary[];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	startedAt?: number;
	endedAt?: number;
	lastUpdate?: number;
	error?: string;
}

// Public projection of NestedRunSummary for intercom payloads
export type PublicNestedRunSummary = Pick<
	NestedRunSummary,
	| "id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path"
	| "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget"
	| "ownerState" | "mode" | "state" | "agent" | "agents" | "currentStep" | "chainStepCount" | "parallelGroups"
	| "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath"
	| "turnCount" | "toolCount" | "totalTokens" | "startedAt" | "endedAt" | "lastUpdate" | "error"
> & {
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	steps?: PublicNestedStepSummary[];
	children?: PublicNestedRunSummary[];
};

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}

export interface NestedRunMatch {
	rootRunId: string;
	route: NestedRouteInfo;
	run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
	routes: NestedRouteInfo[];
	descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

// ============================================================================
// Live control (M12.1) — direct acknowledged child-control transport spike.
// Internal only: no public subagent tool action or UI consumes these yet.
// ============================================================================

export type LiveControlMode = "steer" | "followUp";

export type LiveControlRequestState = "submitted" | "delivery-attempted" | "accepted-by-pi" | "rejected" | "outcome-unknown";

export type LiveControlDisposition = "started-turn" | "queued-steer" | "queued-follow-up";

/** Child-generated, atomically published ownership marker for one (rootRunId, childKey) slot. */
export interface LiveControlOwnerEpoch {
	schemaVersion: 2;
	rootRunId: string;
	capabilityToken: string;
	childKey: string;
	epoch: string;
	pid: number;
	startedAt: number;
	closedAt?: number;
}

/** One durable steer/follow-up control request, bound to an exact owner epoch and sequence. */
export interface LiveControlRequestRecord {
	schemaVersion: 2;
	type: "subagent.live-control.request";
	rootRunId: string;
	capabilityToken: string;
	childKey: string;
	epoch: string;
	sequence: number;
	requestId: string;
	mode: LiveControlMode;
	text: string;
	ts: number;
}

/** Durable terminal (or in-flight) state for one live control request. Never claims model delivery. */
export interface LiveControlResultRecord {
	schemaVersion: 2;
	type: "subagent.live-control.result";
	rootRunId: string;
	capabilityToken: string;
	childKey: string;
	epoch: string;
	sequence: number;
	requestId: string;
	state: LiveControlRequestState;
	disposition?: LiveControlDisposition;
	message: string;
	ts: number;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024,
	lines: 5000,
};

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid")
		? options.getuid
		: process.getuid?.bind(process);
	if (typeof getuid === "function") {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo")
		? options.userInfo
		: os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env.USERPROFILE ?? env.HOME;
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir")
		? options.homedir
		: os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = path.join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const SUBAGENT_ACTIONS = ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "steer", "follow-up", "wrap-up", "recover", "inspect", "attach", "detach", "doctor"] as const;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
): number {
	return normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
}

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function normalizeMaxSubagentDepth(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return normalizeMaxSubagentDepth(process.env.PI_SUBAGENT_MAX_DEPTH)
		?? normalizeMaxSubagentDepth(configMaxDepth)
		?? DEFAULT_SUBAGENT_MAX_DEPTH;
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(maxDepth?: number): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(normalizeMaxSubagentDepth(maxDepth) ?? resolveCurrentMaxSubagentDepth()),
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	if (bytes <= config.bytes && lines.length <= config.lines) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (lines.length > config.lines) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	const keptLines = result.split("\n").length;
	const marker = `[TRUNCATED: showing first ${keptLines} of ${lines.length} lines, ${formatBytes(Buffer.byteLength(result))} of ${formatBytes(bytes)}${artifactPath ? ` - full output at ${artifactPath}` : ""}]\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
	};
}
