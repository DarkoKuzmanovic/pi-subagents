/**
 * Chain execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { formatUnknownAgentError } from "../../agents/agent-selection.ts";
import {
	ChainClarifyComponent,
	type ChainClarifyResult,
	type BehaviorOverride,
} from "./chain-clarify.ts";
import {
	currentModelFullId,
	toModelInfo,
	type ModelInfo,
} from "../../shared/model-info.ts";
import {
	resolveChainTemplates,
	createChainDir,
	removeChainDir,
	resolveStepBehavior,
	resolveParallelBehaviors,
	buildChainInstructions,
	writeInitialProgressFile,
	createParallelDirs,
	suppressProgressForReadOnlyTask,
	stripStaleAgentBlocks,
	isDynamicParallelStep,
	isParallelStep,
	type StepOverrides,
	type ChainStep,
	type ParallelStep,
	type SequentialStep,
	type ResolvedStepBehavior,
	type ResolvedTemplates,
} from "../../shared/settings.ts";
import {
	aggregateParallelOutputs,
	type ParallelTaskResult,
} from "../shared/parallel-utils.ts";
import {
	discoverAvailableSkills,
	normalizeSkillInput,
} from "../../agents/skills.ts";
import {
	shouldSkipContextFiles,
	type SubagentExecutionContext,
} from "../../shared/fork-context.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { runSync } from "./execution.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import {
	compactForegroundDetails,
	getSingleResultOutput,
	mapConcurrent,
	resolveChildCwd,
} from "../../shared/utils.ts";
import {
	ChainOutputValidationError,
	outputEntryFromResult,
	renderChainTemplate,
	validateChainOutputBindings,
} from "../shared/chain-outputs.ts";
import {
	collectDynamicResults,
	DynamicFanoutError,
	materializeDynamicParallelStep,
	resolveItemTemplate,
	validateDynamicCollection,
	type DynamicCollectedResult,
	type DynamicMaterializedItem,
} from "../shared/dynamic-fanout.ts";
import {
	SUBAGENT_BUDGET_EXHAUSTED_EVENT,
	type BudgetExhaustedEvent,
	type BudgetSummary,
	type ChainOutputMap,
} from "../../shared/types.ts";
import {
	buildGraderTask,
	GATE_VERDICT_SCHEMA,
	normalizeGateSpec,
	validateGateVerdictSemantics,
	type GateVerdict,
	type NormalizedGateSpec,
} from "../shared/acceptance-gate.ts";
import { GRADER_READ_ONLY_TOOLS } from "../shared/grader-boundary.ts";
import { recordRun } from "../shared/run-history.ts";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	formatWorktreeTaskCwdConflict,
	type WorktreeSetup,
} from "../shared/worktree.ts";
import {
	type ActivityState,
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type IntercomEventBus,
	type ResolvedControlConfig,
	type NestedRouteInfo,
	type SingleResult,
	MAX_CONCURRENCY,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { emptyUsage } from "../shared/usage.ts";
import {
	budgetSummary,
	createSessionTokenBudget,
	recordBudgetUsage,
	shouldDispatchWithBudget,
	type SessionTokenBudget,
} from "../shared/session-tokens.ts";

function formatChainStepStatus(
	agent: string,
	stepIndex: number,
	totalSteps: number,
	progress?: AgentProgress,
): string {
	const step = `[${stepIndex + 1}/${totalSteps}] ${agent}`;
	const parts: string[] = [step];
	if (progress) {
		if (progress.turnCount) parts.push(`turn ${progress.turnCount}`);
		if (progress.toolCount) parts.push(`${progress.toolCount} tools`);
		if (progress.durationMs) {
			const s = Math.floor(progress.durationMs / 1000);
			parts.push(s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
		}
		if (progress.currentTool) parts.push(`▸ ${progress.currentTool}`);
	}
	return parts.join(" · ");
}
interface ChainExecutionDetailsInput {
	results: SingleResult[];
	includeProgress?: boolean;
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	artifactsDir: string;
	chainAgents: string[];
	totalSteps: number;
	currentStepIndex?: number;
	budget?: BudgetSummary;
}

interface ParallelChainRunInput {
	step: ParallelStep;
	parallelTemplates: string[];
	rawParallelTemplates?: string[];
	dynamicItemName?: string;
	dynamicItems?: DynamicMaterializedItem[];
	parallelBehaviors: ResolvedStepBehavior[];
	agents: AgentConfig[];
	stepIndex: number;
	availableModels: ModelInfo[];
	chainDir: string;
	prev: string;
	context?: SubagentExecutionContext;
	outputs: ChainOutputMap;
	originalTask: string;
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	cwd?: string;
	runId: string;
	runStartedAt: number;
	globalTaskIndex: number;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	signal?: AbortSignal;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	};
	results: SingleResult[];
	allProgress: AgentProgress[];
	chainAgents: string[];
	totalSteps: number;
	worktreeSetup?: WorktreeSetup;
	maxSubagentDepth: number;
	inlineReads?: boolean;
}

function buildChainExecutionDetails(
	input: ChainExecutionDetailsInput,
): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: input.results,
		progress: input.includeProgress ? input.allProgress : undefined,
		artifacts: input.allArtifactPaths.length
			? { dir: input.artifactsDir, files: input.allArtifactPaths }
			: undefined,
		chainAgents: input.chainAgents,
		totalSteps: input.totalSteps,
		currentStepIndex: input.currentStepIndex,
		budget: input.budget,
	});
}

function buildChainExecutionErrorResult(
	message: string,
	input: ChainExecutionDetailsInput,
): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildChainExecutionDetails(input),
	};
}

function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (
		progressCreated ||
		!parallelBehaviors.some((behavior) => behavior.progress)
	) {
		return progressCreated;
	}
	writeInitialProgressFile(chainDir);
	return true;
}

function appendParallelWorktreeSummary(
	output: string,
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return output;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	if (!diffSummary) return output;
	return `${output}\n\n${diffSummary}`;
}

function formatGateDiffSummary(
	diffs: ReturnType<typeof diffWorktrees>,
): string {
	return (
		formatWorktreeDiffSummary(diffs) ||
		"=== Worktree Changes ===\n\n(no changes detected)"
	);
}

function formatGateReport(input: {
	grader: string;
	verdict?: GateVerdict;
	error?: string;
	diffSummary: string;
	producerFailed?: boolean;
}): string {
	const passed =
		input.verdict?.pass === true && !input.error && !input.producerFailed;
	const lines = [
		`=== Acceptance Gate: ${passed ? "PASS" : "FAIL"} ===`,
		`Grader: ${input.grader}`,
	];
	if (input.verdict) {
		lines.push(`Score: ${input.verdict.score}`);
		lines.push(`Grader note: ${input.verdict.feedback || "(no feedback)"}`);
		for (const [index, criterion] of input.verdict.criteria.entries()) {
			lines.push(
				`Criterion ${index + 1}: ${criterion.met ? "met" : "unmet"} — ${criterion.criterion}${criterion.note ? ` (${criterion.note})` : ""}`,
			);
		}
	} else {
		lines.push(
			`Grader verdict error: ${input.error || "missing structured verdict"}`,
		);
	}
	lines.push(
		"",
		input.diffSummary,
		"",
		"The attempt worktree was discarded. Apply the reported changes manually if accepted.",
	);
	return lines.join("\n");
}

async function runParallelChainTasks(
	input: ParallelChainRunInput,
): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	const parallelResults = await mapConcurrent(
		input.step.parallel,
		concurrency,
		async (task, taskIndex) => {
			if (aborted && failFast) {
				return {
					agent: task.agent,
					task: "(skipped)",
					exitCode: -1,
					messages: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					error: "Skipped due to fail-fast",
				} as SingleResult;
			}

			const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
			const rawTaskTemplate =
				input.rawParallelTemplates?.[taskIndex] ?? taskTemplate;
			const behavior = suppressProgressForReadOnlyTask(
				input.parallelBehaviors[taskIndex]!,
				rawTaskTemplate,
				input.originalTask,
			);
			const templateHasPrevious = rawTaskTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				input.chainDir,
				false,
				templateHasPrevious ? undefined : input.prev,
				input.inlineReads,
			);
			let taskStr = renderChainTemplate(
				taskTemplate,
				{
					task: input.originalTask,
					previous: input.prev,
					chain_dir: input.chainDir,
				},
				input.outputs,
			);
			const dynamicItem = input.dynamicItems?.[taskIndex];
			if (dynamicItem && input.dynamicItemName) {
				taskStr = resolveItemTemplate(
					taskStr,
					input.dynamicItemName,
					dynamicItem.item,
				);
			}
			const cleanTask = taskStr;
			taskStr = prefix + taskStr + suffix;

			const taskAgentConfig = input.agents.find(
				(agent) => agent.name === task.agent,
			);
			const effectiveModel =
				(task.model
					? resolveModelCandidate(
							task.model,
							input.availableModels,
							input.ctx.model?.provider,
						)
					: null) ??
				resolveModelCandidate(
					taskAgentConfig?.model,
					input.availableModels,
					input.ctx.model?.provider,
				) ??
				(behavior.thinking ? currentModelFullId(input.ctx.model) : undefined);
			const maxSubagentDepth = resolveChildMaxSubagentDepth(
				input.maxSubagentDepth,
				taskAgentConfig?.maxSubagentDepth,
			);

			const taskCwd = input.worktreeSetup
				? (() => {
						const worktree = input.worktreeSetup.worktrees[taskIndex];
						if (!worktree)
							throw new Error(
								`chain worktree dispatch: no worktree at index ${taskIndex} (have ${input.worktreeSetup.worktrees.length})`,
							);
						return worktree.agentCwd;
					})()
				: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);

			const outputPath =
				typeof behavior.output === "string"
					? path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(input.chainDir, behavior.output)
					: undefined;
			const interruptController = new AbortController();
			if (input.foregroundControl) {
				input.foregroundControl.currentAgent = task.agent;
				input.foregroundControl.currentIndex =
					input.globalTaskIndex + taskIndex;
				input.foregroundControl.currentActivityState = undefined;
				input.foregroundControl.updatedAt = Date.now();
				input.foregroundControl.interrupt = () => {
					if (interruptController.signal.aborted) return false;
					interruptController.abort();
					// fc captured at narrowing time (closure-narrowing safe).
					const fc = input.foregroundControl;
					if (fc) {
						fc.currentActivityState = undefined;
						fc.updatedAt = Date.now();
					}
					return true;
				};
			}

			const result = await runSync(
				input.ctx.cwd,
				input.agents,
				task.agent,
				taskStr,
				{
					cwd: taskCwd,
					outputSchema: task.outputSchema,
					signal: input.signal,
					interruptSignal: interruptController.signal,
					allowIntercomDetach:
						taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) ===
						true,
					intercomEvents: input.intercomEvents,
					runId: input.runId,
					runStartedAt: input.runStartedAt,
					index: input.globalTaskIndex + taskIndex,
					sessionDir: input.sessionDirForIndex(
						input.globalTaskIndex + taskIndex,
					),
					sessionFile: input.sessionFileForIndex?.(
						input.globalTaskIndex + taskIndex,
					),
					share: input.shareEnabled,
					artifactsDir: input.artifactConfig.enabled
						? input.artifactsDir
						: undefined,
					artifactConfig: input.artifactConfig,
					outputPath,
					outputMode: behavior.outputMode,
					maxSubagentDepth,
					skipContextFiles: shouldSkipContextFiles(input.context),
					controlConfig: input.controlConfig,
					onControlEvent: input.onControlEvent,
					intercomSessionName: input.childIntercomTarget?.(
						task.agent,
						input.globalTaskIndex + taskIndex,
					),
					orchestratorIntercomTarget: input.orchestratorIntercomTarget,
					modelOverride: effectiveModel,
					availableModels: input.availableModels,
					preferredModelProvider: input.ctx.model?.provider,
					skills: behavior.skills === false ? [] : behavior.skills,
					effectiveThinking: behavior.thinking,
					onUpdate: input.onUpdate
						? (progressUpdate) => {
								const stepResults = progressUpdate.details?.results || [];
								const stepProgress = progressUpdate.details?.progress || [];
								if (input.foregroundControl && stepProgress.length > 0) {
									const current = stepProgress[0];
									input.foregroundControl.currentAgent = task.agent;
									input.foregroundControl.currentIndex =
										input.globalTaskIndex + taskIndex;
									input.foregroundControl.currentActivityState =
										current?.activityState;
									input.foregroundControl.lastActivityAt =
										current?.lastActivityAt;
									input.foregroundControl.currentTool = current?.currentTool;
									input.foregroundControl.currentToolStartedAt =
										current?.currentToolStartedAt;
									input.foregroundControl.currentPath = current?.currentPath;
									input.foregroundControl.turnCount = current?.turnCount;
									input.foregroundControl.tokens = current?.tokens;
									input.foregroundControl.toolCount = current?.toolCount;
									input.foregroundControl.updatedAt = Date.now();
								}
								input.onUpdate?.({
									...progressUpdate,
									details: {
										mode: "chain",
										results: input.results.concat(stepResults),
										progress: input.allProgress.concat(stepProgress),
										controlEvents: progressUpdate.details?.controlEvents,
										chainAgents: input.chainAgents,
										totalSteps: input.totalSteps,
										currentStepIndex: input.stepIndex,
									},
								});
							}
						: undefined,
				},
			);
			if (
				input.foregroundControl?.currentIndex ===
				input.globalTaskIndex + taskIndex
			) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}

			if (result.exitCode !== 0 && failFast) {
				aborted = true;
			}
			recordRun(
				task.agent,
				cleanTask,
				result.exitCode,
				result.progressSummary?.durationMs ?? 0,
			);
			return result;
		},
	);

	return parallelResults;
}

interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		interrupt?: () => boolean;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
	};
	chainSkills?: string[];
	chainDir?: string;
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	context?: SubagentExecutionContext;
	inlineReads?: boolean;
	nestedRoute?: NestedRouteInfo;
	dynamicFanoutMaxItems?: number;
	budget?: number;
}

interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
	/** User requested async execution via TUI - caller should dispatch to executeAsyncChain */
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
}

function budgetSkippedResult(agent: string): SingleResult {
	return {
		agent,
		task: "(skipped — budget-exhausted)",
		exitCode: -1,
		messages: [],
		usage: emptyUsage(),
		finalOutput: "skipped(budget-exhausted)",
		error: "budget-exhausted",
	};
}

function appendBudgetSkippedChainSteps(
	results: SingleResult[],
	steps: ChainStep[],
	startIndex: number,
): void {
	for (let i = startIndex; i < steps.length; i++) {
		const step = steps[i]!;
		if (isParallelStep(step)) {
			for (const task of step.parallel)
				results.push(budgetSkippedResult(task.agent));
		} else if (isDynamicParallelStep(step)) {
			results.push(budgetSkippedResult(step.parallel.agent));
		} else {
			results.push(budgetSkippedResult((step as SequentialStep).agent));
		}
	}
}

function recordResultBudgetUsage(
	budget: SessionTokenBudget,
	result: SingleResult,
): void {
	if (result.exitCode === -1) return;
	recordBudgetUsage(budget, result.usage);
}

function emitBudgetExhausted(input: {
	intercomEvents?: IntercomEventBus;
	runId: string;
	budget: BudgetSummary;
	skippedFromStepIndex: number;
}): void {
	const payload: BudgetExhaustedEvent = {
		runId: input.runId,
		mode: "chain",
		budget: input.budget,
		skippedFromStepIndex: input.skippedFromStepIndex,
	};
	input.intercomEvents?.emit(SUBAGENT_BUDGET_EXHAUSTED_EVENT, payload);
}

/**
 * Execute a chain of subagent steps
 */
export async function executeChain(
	params: ChainExecutionParams,
): Promise<ChainExecutionResult> {
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		clarify,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
		context,
	} = params;
	const chainSkills = chainSkillsParam ?? [];

	try {
		validateChainOutputBindings(chainSteps, {
			maxItems: params.dynamicFanoutMaxItems,
		});
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [
					{
						type: "text",
						text: `Invalid chain output bindings: ${error.message}`,
					},
				],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
		throw error;
	}

	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];

	const chainAgents: string[] = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((t) => t.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `fanout[${step.collect.as}]`
				: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;

	const firstStep = chainSteps[0];
	if (!firstStep) throw new Error("chain-execution: chainSteps is empty");
	const originalTask =
		params.task ??
		(isParallelStep(firstStep)
			? (() => {
					const firstParallel = firstStep.parallel[0];
					if (!firstParallel)
						throw new Error("chain-execution: parallel step has no tasks");
					return firstParallel.task;
				})()
			: (firstStep as SequentialStep).task);

	const chainDir = createChainDir(runId, chainDirBase);
	const hasParallelSteps = chainSteps.some(
		(step) => isParallelStep(step) || isDynamicParallelStep(step),
	);
	let templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const shouldClarify = clarify !== false && ctx.hasUI && !hasParallelSteps;
	let tuiBehaviorOverrides: (BehaviorOverride | undefined)[] | undefined;
	const availableModels: ModelInfo[] = ctx.modelRegistry
		.getAvailable()
		.map(toModelInfo);
	const availableSkills = discoverAvailableSkills(cwd ?? ctx.cwd);

	if (shouldClarify) {
		const seqSteps = chainSteps as SequentialStep[];
		const agentConfigs: AgentConfig[] = [];
		for (const step of seqSteps) {
			const config = agents.find((a) => a.name === step.agent);
			if (!config) {
				removeChainDir(chainDir);
				return {
					content: [
						{ type: "text", text: formatUnknownAgentError(step.agent, agents) },
					],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
			agentConfigs.push(config);
		}

		const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
			output: step.output,
			outputMode: step.outputMode,
			reads: step.reads,
			progress: step.progress,
			skills: normalizeSkillInput(step.skill),
			model: step.model,
			thinking: step.thinking,
		}));

		const resolvedBehaviors = agentConfigs.map((config, i) =>
			resolveStepBehavior(config, stepOverrides[i]!, chainSkills),
		);
		const flatTemplates = templates as string[];

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui,
					theme,
					agentConfigs,
					flatTemplates,
					originalTask,
					chainDir,
					resolvedBehaviors,
					availableModels,
					ctx.model?.provider,
					availableSkills,
					done,
				),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
			},
		);

		if (!result || !result.confirmed) {
			removeChainDir(chainDir);
			return {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: { mode: "chain", results: [] },
			};
		}

		if (
			result.runInBackground &&
			chainSteps.some(
				(step) =>
					!isParallelStep(step) &&
					!isDynamicParallelStep(step) &&
					Boolean((step as SequentialStep).gate),
			)
		) {
			removeChainDir(chainDir);
			return {
				content: [
					{
						type: "text",
						text: "Acceptance gates are foreground-only in report-only v1; do not request background execution for a gated chain.",
					},
				],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}

		if (result.runInBackground) {
			removeChainDir(chainDir);
			const updatedChain: ChainStep[] = chainSteps.map((step, i) => {
				if (isParallelStep(step)) return step;
				const override = result.behaviorOverrides[i];
				return {
					...step,
					task: result.templates[i]!,
					...(override?.model ? { model: override.model } : {}),
					...(override?.thinking !== undefined
						? { thinking: override.thinking }
						: {}),
					...(override?.output !== undefined
						? { output: override.output }
						: {}),
					...("outputMode" in step && step.outputMode !== undefined
						? { outputMode: step.outputMode }
						: {}),
					...(override?.reads !== undefined ? { reads: override.reads } : {}),
					...(override?.progress !== undefined
						? { progress: override.progress }
						: {}),
					...(override?.skills !== undefined ? { skill: override.skills } : {}),
				};
			});
			return {
				content: [{ type: "text", text: "Launching in background..." }],
				details: { mode: "chain", results: [] },
				requestedAsync: { chain: updatedChain, chainSkills },
			};
		}

		templates = result.templates;
		tuiBehaviorOverrides = result.behaviorOverrides;
	}

	const runStartedAt = Date.now();
	const results: SingleResult[] = [];
	const gateReports: string[] = [];
	const outputs: ChainOutputMap = {};
	let prev = "";
	let globalTaskIndex = 0;
	let progressCreated = false;
	const tokenBudget = createSessionTokenBudget(runId, params.budget);
	const currentBudgetSummary = () => budgetSummary(tokenBudget);

	if (onUpdate) {
		const stepNames = chainSteps
			.map((s) =>
				isParallelStep(s)
					? `parallel[${s.parallel.length}]`
					: isDynamicParallelStep(s)
						? `fanout[${s.collect.as}]`
						: (s as SequentialStep).agent,
			)
			.join(" → ");
		const banner = [
			`┃  Chain ${runId}`,
			`┃  ${stepNames}`,
			`┃  ${chainDir}`,
		].join("\n");
		onUpdate({
			content: [{ type: "text", text: banner }],
			details: {
				mode: "chain" as const,
				results: [],
				chainAgents,
				totalSteps,
				currentStepIndex: 0,
				budget: currentBudgetSummary(),
			},
		});
	}

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		if (!shouldDispatchWithBudget(tokenBudget)) {
			const exhaustedBudget = currentBudgetSummary();
			if (exhaustedBudget) {
				emitBudgetExhausted({
					intercomEvents,
					runId,
					budget: exhaustedBudget,
					skippedFromStepIndex: stepIndex,
				});
			}
			appendBudgetSkippedChainSteps(results, chainSteps, stepIndex);
			break;
		}
		const stepTemplates = templates[stepIndex]!;

		if (isParallelStep(step)) {
			const parallelTemplates = stepTemplates as string[];
			const parallelCwd = resolveChildCwd(cwd ?? ctx.cwd, step.cwd);
			let worktreeSetup: WorktreeSetup | undefined;
			if (step.worktree) {
				const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(
					step.parallel,
					parallelCwd,
				);
				if (worktreeTaskCwdConflict) {
					return buildChainExecutionErrorResult(
						`parallel chain step ${stepIndex + 1}: ${formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, parallelCwd)}`,
						{
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						},
					);
				}
				try {
					worktreeSetup = createWorktrees(
						parallelCwd,
						`${runId}-s${stepIndex}`,
						step.parallel.length,
						{
							agents: step.parallel.map((task) => task.agent),
							setupHook: params.worktreeSetupHook
								? {
										hookPath: params.worktreeSetupHook,
										timeoutMs: params.worktreeSetupHookTimeoutMs,
									}
								: undefined,
						},
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					return buildChainExecutionErrorResult(message, {
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					});
				}
			}

			try {
				const agentNames = step.parallel.map((task) => task.agent);
				const parallelBehaviors = resolveParallelBehaviors(
					step.parallel,
					agents,
					stepIndex,
					chainSkills,
				).map((behavior, taskIndex) =>
					suppressProgressForReadOnlyTask(
						behavior,
						parallelTemplates[taskIndex] ?? step.parallel[taskIndex]?.task,
						originalTask,
					),
				);
				for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
					const behavior = parallelBehaviors[taskIndex]!;
					const outputPath =
						typeof behavior.output === "string"
							? path.isAbsolute(behavior.output)
								? behavior.output
								: path.join(chainDir, behavior.output)
							: undefined;
					const validationError = validateFileOnlyOutputMode(
						behavior.outputMode,
						outputPath,
						`Parallel chain step ${stepIndex + 1} task ${taskIndex + 1} (${step.parallel[taskIndex]?.agent ?? "<missing>"})`,
					);
					if (validationError)
						return buildChainExecutionErrorResult(validationError, {
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						});
				}
				progressCreated = ensureParallelProgressFile(
					chainDir,
					progressCreated,
					parallelBehaviors,
				);
				createParallelDirs(
					chainDir,
					stepIndex,
					step.parallel.length,
					agentNames,
				);

				const parallelResults = await runParallelChainTasks({
					step,
					context,
					parallelTemplates,
					parallelBehaviors,
					agents,
					stepIndex,
					availableModels,
					chainDir,
					prev,
					originalTask,
					outputs,
					ctx,
					intercomEvents,
					cwd,
					runId,
					runStartedAt,
					globalTaskIndex,
					sessionDirForIndex,
					sessionFileForIndex,
					shareEnabled,
					artifactConfig,
					artifactsDir,
					signal,
					onUpdate,
					results,
					allProgress,
					chainAgents,
					totalSteps,
					controlConfig,
					onControlEvent,
					childIntercomTarget,
					orchestratorIntercomTarget,
					foregroundControl,
					worktreeSetup,
					maxSubagentDepth: params.maxSubagentDepth,
					inlineReads: params.inlineReads,
				});
				globalTaskIndex += step.parallel.length;

				for (let i = 0; i < parallelResults.length; i++) {
					const result = parallelResults[i]!;
					results.push(result);
					if (result.progress) allProgress.push(result.progress);
					if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
					recordResultBudgetUsage(tokenBudget, result);
					const asName = step.parallel[i]?.as;
					if (asName && result.exitCode === 0 && !result.error) {
						outputs[asName] = outputEntryFromResult(result, stepIndex);
					}
				}

				const interrupted = parallelResults.find(
					(result) => result.interrupted,
				);
				if (interrupted) {
					return {
						content: [
							{
								type: "text",
								text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.`,
							},
						],
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
					};
				}
				const detachedIndexInStep = parallelResults.findIndex(
					(result) => result.detached,
				);
				const detached =
					detachedIndexInStep >= 0
						? parallelResults[detachedIndexInStep]
						: undefined;
				if (detached) {
					return {
						content: [
							{
								type: "text",
								text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.`,
							},
						],
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
					};
				}

				const failures = parallelResults
					.map((result, originalIndex) => ({ ...result, originalIndex }))
					.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
				if (failures.length > 0) {
					const failureSummary = failures
						.map(
							(failure) =>
								`- Task ${failure.originalIndex + 1} (${failure.agent}): ${failure.error || "failed"}`,
						)
						.join("\n");
					const errorMsg = `Parallel step ${stepIndex + 1} failed:\n${failureSummary}`;
					const recoveredParts = failures
						.map((f) => {
							const out = getSingleResultOutput(f).trim();
							return out
								? `[Task ${f.originalIndex + 1} (${f.agent})]:\n${out}`
								: null;
						})
						.filter(Boolean);
					const recoveredOutput =
						recoveredParts.length > 0 ? recoveredParts.join("\n\n") : undefined;
					const summary = buildChainSummary(
						chainSteps,
						results,
						chainDir,
						"failed",
						{
							index: stepIndex,
							error: errorMsg,
							recoveredOutput,
						},
					);
					return {
						content: [{ type: "text", text: summary }],
						isError: true,
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
					};
				}

				const taskResults: ParallelTaskResult[] = parallelResults.map(
					(result, i) => {
						const outputTarget = parallelBehaviors[i]?.output;
						const outputTargetPath =
							typeof outputTarget === "string"
								? path.isAbsolute(outputTarget)
									? outputTarget
									: path.join(chainDir, outputTarget)
								: undefined;
						return {
							agent: result.agent,
							taskIndex: i,
							output: getSingleResultOutput(result),
							exitCode: result.exitCode,
							error: result.error,
							outputTargetPath,
							outputTargetExists: outputTargetPath
								? fs.existsSync(outputTargetPath)
								: undefined,
						};
					},
				);
				prev = stripStaleAgentBlocks(aggregateParallelOutputs(taskResults));
				prev = appendParallelWorktreeSummary(
					prev,
					worktreeSetup,
					path.join(chainDir, "worktree-diffs", `step-${stepIndex}`),
					agentNames,
				);
			} finally {
				if (worktreeSetup) cleanupWorktrees(worktreeSetup);
			}
		} else if (isDynamicParallelStep(step)) {
			let materialized: ReturnType<typeof materializeDynamicParallelStep>;
			try {
				materialized = materializeDynamicParallelStep(
					step,
					outputs,
					stepIndex,
					{ maxItems: params.dynamicFanoutMaxItems },
				);
			} catch (error) {
				const message =
					error instanceof DynamicFanoutError
						? error.message
						: error instanceof Error
							? error.message
							: String(error);
				return buildChainExecutionErrorResult(message, {
					results,
					includeProgress,
					allProgress,
					allArtifactPaths,
					artifactsDir,
					chainAgents,
					totalSteps,
					currentStepIndex: stepIndex,
				});
			}

			if (materialized.parallel.length === 0) {
				const collection: DynamicCollectedResult[] = [];
				try {
					validateDynamicCollection(step.collect.outputSchema, collection);
				} catch (error) {
					const message =
						error instanceof DynamicFanoutError
							? error.message
							: error instanceof Error
								? error.message
								: String(error);
					return buildChainExecutionErrorResult(message, {
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					});
				}
				outputs[step.collect.as] = {
					text: JSON.stringify(collection),
					structured: collection,
					agent: step.parallel.agent,
					stepIndex,
				};
				prev = "Dynamic fanout produced 0 results.";
				continue;
			}

			const dynamicParallelStep: ParallelStep = {
				parallel: materialized.parallel,
				concurrency: step.concurrency,
				failFast: step.failFast,
			};
			const dynParallelTemplates = materialized.parallel.map(
				() => step.parallel.task ?? "{previous}",
			);
			const dynAgentNames = dynamicParallelStep.parallel.map(
				(task) => task.agent,
			);
			const dynParallelBehaviors = resolveParallelBehaviors(
				dynamicParallelStep.parallel,
				agents,
				stepIndex,
				chainSkills,
			).map((behavior, taskIndex) =>
				suppressProgressForReadOnlyTask(
					behavior,
					dynParallelTemplates[taskIndex] ??
						dynamicParallelStep.parallel[taskIndex]?.task,
					originalTask,
				),
			);

			for (
				let taskIndex = 0;
				taskIndex < dynamicParallelStep.parallel.length;
				taskIndex++
			) {
				const behavior = dynParallelBehaviors[taskIndex]!;
				const outputPath =
					typeof behavior.output === "string"
						? path.isAbsolute(behavior.output)
							? behavior.output
							: path.join(chainDir, behavior.output)
						: undefined;
				const validationError = validateFileOnlyOutputMode(
					behavior.outputMode,
					outputPath,
					`Dynamic chain step ${stepIndex + 1} item ${taskIndex + 1} (${dynamicParallelStep.parallel[taskIndex]?.agent ?? "<missing>"})`,
				);
				if (validationError)
					return buildChainExecutionErrorResult(validationError, {
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					});
			}

			progressCreated = ensureParallelProgressFile(
				chainDir,
				progressCreated,
				dynParallelBehaviors,
			);
			createParallelDirs(
				chainDir,
				stepIndex,
				dynamicParallelStep.parallel.length,
				dynAgentNames,
			);

			const parallelResults = await runParallelChainTasks({
				step: dynamicParallelStep,
				context,
				parallelTemplates: dynParallelTemplates,
				rawParallelTemplates: materialized.parallel.map(
					() => step.parallel.task ?? "{previous}",
				),
				parallelBehaviors: dynParallelBehaviors,
				dynamicItemName: step.expand.item ?? "item",
				dynamicItems: materialized.items,
				agents,
				stepIndex,
				availableModels,
				chainDir,
				prev,
				originalTask,
				outputs,
				ctx,
				intercomEvents,
				cwd,
				runId,
				runStartedAt,
				globalTaskIndex,
				sessionDirForIndex,
				sessionFileForIndex,
				shareEnabled,
				artifactConfig,
				artifactsDir,
				signal,
				onUpdate,
				results,
				allProgress,
				chainAgents,
				totalSteps,
				controlConfig,
				onControlEvent,
				childIntercomTarget,
				orchestratorIntercomTarget,
				foregroundControl,
				maxSubagentDepth: params.maxSubagentDepth,
				inlineReads: params.inlineReads,
			});
			globalTaskIndex += dynamicParallelStep.parallel.length;

			for (const result of parallelResults) {
				results.push(result);
				if (result.progress) allProgress.push(result.progress);
				if (result.artifactPaths) allArtifactPaths.push(result.artifactPaths);
				recordResultBudgetUsage(tokenBudget, result);
			}

			const interrupted = parallelResults.find((result) => result.interrupted);
			if (interrupted) {
				return {
					content: [
						{
							type: "text",
							text: `Chain paused after interrupt at step ${stepIndex + 1} (${interrupted.agent}). Waiting for explicit next action.`,
						},
					],
					details: buildChainExecutionDetails({
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					}),
				};
			}
			const detached = parallelResults.find((result) => result.detached);
			if (detached) {
				return {
					content: [
						{
							type: "text",
							text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${detached.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.`,
						},
					],
					details: buildChainExecutionDetails({
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					}),
				};
			}

			const failures = parallelResults
				.map((result, originalIndex) => ({ ...result, originalIndex }))
				.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
			if (failures.length > 0) {
				const failureSummary = failures
					.map(
						(failure) =>
							`- Item ${failure.originalIndex + 1} (${failure.agent}, key ${materialized.items[failure.originalIndex]?.key ?? failure.originalIndex}): ${failure.error || "failed"}`,
					)
					.join("\n");
				const errorMsg = `Dynamic step ${stepIndex + 1} failed:\n${failureSummary}`;
				const summary = buildChainSummary(
					chainSteps,
					results,
					chainDir,
					"failed",
					{
						index: stepIndex,
						error: errorMsg,
					},
				);
				return {
					content: [{ type: "text", text: summary }],
					isError: true,
					details: buildChainExecutionDetails({
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					}),
				};
			}

			const collected = collectDynamicResults(
				step,
				materialized.items,
				parallelResults,
			);
			try {
				validateDynamicCollection(step.collect.outputSchema, collected);
			} catch (error) {
				const message =
					error instanceof DynamicFanoutError
						? error.message
						: error instanceof Error
							? error.message
							: String(error);
				return buildChainExecutionErrorResult(message, {
					results,
					includeProgress,
					allProgress,
					allArtifactPaths,
					artifactsDir,
					chainAgents,
					totalSteps,
					currentStepIndex: stepIndex,
				});
			}
			outputs[step.collect.as] = {
				text: JSON.stringify(collected),
				structured: collected,
				agent: step.parallel.agent,
				stepIndex,
			};
			prev = `Dynamic fanout collected ${collected.length} result(s) into ${step.collect.as}.`;
		} else {
			const seqStep = step as SequentialStep;
			const stepTemplate = stepTemplates as string;

			const agentConfig = agents.find((a) => a.name === seqStep.agent);
			if (!agentConfig) {
				removeChainDir(chainDir);
				return {
					content: [
						{
							type: "text",
							text: formatUnknownAgentError(seqStep.agent, agents),
						},
					],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}

			const gateSpec: NormalizedGateSpec | undefined = seqStep.gate
				? normalizeGateSpec(seqStep.gate)
				: undefined;
			const graderConfig = gateSpec
				? agents.find((agent) => agent.name === gateSpec.grader)
				: undefined;
			if (gateSpec && !graderConfig) {
				return buildChainExecutionErrorResult(
					`Acceptance gate step ${stepIndex + 1}: grader agent '${gateSpec.grader}' is not configured; no child was launched.`,
					{
						results,
						includeProgress,
						allProgress,
						allArtifactPaths,
						artifactsDir,
						chainAgents,
						totalSteps,
						currentStepIndex: stepIndex,
					},
				);
			}

			const tuiOverride = tuiBehaviorOverrides?.[stepIndex];
			const stepOverride: StepOverrides = {
				output:
					tuiOverride?.output !== undefined
						? tuiOverride.output
						: seqStep.output,
				outputMode: seqStep.outputMode,
				reads:
					tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
				progress:
					tuiOverride?.progress !== undefined
						? tuiOverride.progress
						: seqStep.progress,
				thinking:
					tuiOverride?.thinking !== undefined
						? tuiOverride.thinking
						: seqStep.thinking,
				skills:
					tuiOverride?.skills !== undefined
						? tuiOverride.skills
						: normalizeSkillInput(seqStep.skill),
			};
			const behavior = suppressProgressForReadOnlyTask(
				resolveStepBehavior(agentConfig, stepOverride, chainSkills),
				stepTemplate,
				originalTask,
			);

			const isFirstProgress = behavior.progress && !progressCreated;
			if (isFirstProgress) {
				progressCreated = true;
			}

			const templateHasPrevious = stepTemplate.includes("{previous}");
			const { prefix, suffix } = buildChainInstructions(
				behavior,
				chainDir,
				isFirstProgress,
				templateHasPrevious ? undefined : prev,
				params.inlineReads,
			);
			// Single-pass render: resolve {outputs.X} and {task}/{previous}/{chain_dir} in ONE scan so
			// neither an output's text nor a {previous} value can inject the other's tokens (H6).
			let stepTask = renderChainTemplate(
				stepTemplate,
				{ task: originalTask, previous: prev, chain_dir: chainDir },
				outputs,
			);
			const cleanTask = stepTask;
			stepTask = prefix + stepTask + suffix;

			const effectiveModel =
				tuiOverride?.model ??
				(seqStep.model
					? resolveModelCandidate(
							seqStep.model,
							availableModels,
							ctx.model?.provider,
						)
					: null) ??
				resolveModelCandidate(
					agentConfig.model,
					availableModels,
					ctx.model?.provider,
				) ??
				(behavior.thinking ? currentModelFullId(ctx.model) : undefined);

			const outputPath =
				typeof behavior.output === "string"
					? path.isAbsolute(behavior.output)
						? behavior.output
						: path.join(chainDir, behavior.output)
					: undefined;
			const validationError = validateFileOnlyOutputMode(
				behavior.outputMode,
				outputPath,
				`Chain step ${stepIndex + 1} (${seqStep.agent})`,
			);
			if (validationError) {
				return buildChainExecutionErrorResult(validationError, {
					results,
					includeProgress,
					allProgress,
					allArtifactPaths,
					artifactsDir,
					chainAgents,
					totalSteps,
					currentStepIndex: stepIndex,
				});
			}

			let gateSetup: WorktreeSetup | undefined;
			if (gateSpec) {
				const gateCwd = resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd);
				try {
					gateSetup = createWorktrees(
						gateCwd,
						`${runId}-gate-s${stepIndex}`,
						1,
						{
							agents: [seqStep.agent],
							setupHook: params.worktreeSetupHook
								? {
										hookPath: params.worktreeSetupHook,
										timeoutMs: params.worktreeSetupHookTimeoutMs,
									}
								: undefined,
						},
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					return buildChainExecutionErrorResult(
						`Acceptance gate step ${stepIndex + 1} refused before child dispatch: ${message}`,
						{
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						},
					);
				}
			}

			try {
				const maxSubagentDepth = resolveChildMaxSubagentDepth(
					params.maxSubagentDepth,
					agentConfig.maxSubagentDepth,
				);
				const interruptController = new AbortController();
				if (foregroundControl) {
					foregroundControl.currentAgent = seqStep.agent;
					foregroundControl.currentIndex = globalTaskIndex;
					foregroundControl.currentActivityState = undefined;
					foregroundControl.updatedAt = Date.now();
					foregroundControl.interrupt = () => {
						if (interruptController.signal.aborted) return false;
						interruptController.abort();
						foregroundControl.currentActivityState = undefined;
						foregroundControl.updatedAt = Date.now();
						return true;
					};
				}

				const r = await runSync(ctx.cwd, agents, seqStep.agent, stepTask, {
					cwd:
						gateSetup?.worktrees[0]?.agentCwd ??
						resolveChildCwd(cwd ?? ctx.cwd, seqStep.cwd),
					signal,
					interruptSignal: interruptController.signal,
					allowIntercomDetach:
						agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
					intercomEvents,
					runId,
					runStartedAt,
					index: globalTaskIndex,
					sessionDir: sessionDirForIndex(globalTaskIndex),
					sessionFile: sessionFileForIndex?.(globalTaskIndex),
					share: shareEnabled,
					artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
					artifactConfig,
					outputPath,
					outputMode: behavior.outputMode,
					maxSubagentDepth,
					skipContextFiles: shouldSkipContextFiles(context),
					outputSchema: seqStep.outputSchema,
					controlConfig,
					onControlEvent,
					intercomSessionName: childIntercomTarget?.(
						seqStep.agent,
						globalTaskIndex,
					),
					orchestratorIntercomTarget,
					modelOverride: effectiveModel,
					availableModels,
					preferredModelProvider: ctx.model?.provider,
					skills: behavior.skills === false ? [] : behavior.skills,
					effectiveThinking: behavior.thinking,
					onUpdate: onUpdate
						? (p) => {
								const stepResults = p.details?.results || [];
								const stepProgress = p.details?.progress || [];
								if (foregroundControl && stepProgress.length > 0) {
									const current = stepProgress[0];
									foregroundControl.currentAgent = seqStep.agent;
									foregroundControl.currentIndex = globalTaskIndex;
									foregroundControl.currentActivityState =
										current?.activityState;
									foregroundControl.lastActivityAt = current?.lastActivityAt;
									foregroundControl.currentTool = current?.currentTool;
									foregroundControl.currentToolStartedAt =
										current?.currentToolStartedAt;
									foregroundControl.currentPath = current?.currentPath;
									foregroundControl.turnCount = current?.turnCount;
									foregroundControl.tokens = current?.tokens;
									foregroundControl.toolCount = current?.toolCount;
									foregroundControl.updatedAt = Date.now();
								}
								const statusLine = formatChainStepStatus(
									seqStep.agent,
									stepIndex,
									totalSteps,
									stepProgress[stepProgress.length - 1],
								);
								const origText =
									p.content?.[0]?.type === "text" ? p.content[0].text : "";
								onUpdate({
									...p,
									content: [
										{ type: "text", text: `${statusLine}\n${origText}` },
									],
									details: {
										mode: "chain",
										results: results.concat(stepResults),
										progress: allProgress.concat(stepProgress),
										controlEvents: p.details?.controlEvents,
										chainAgents,
										totalSteps,
										currentStepIndex: stepIndex,
									},
								});
							}
						: undefined,
				});
				if (foregroundControl?.currentIndex === globalTaskIndex) {
					foregroundControl.interrupt = undefined;
					foregroundControl.updatedAt = Date.now();
				}
				recordRun(
					seqStep.agent,
					cleanTask,
					r.exitCode,
					r.progressSummary?.durationMs ?? 0,
				);

				globalTaskIndex++;
				results.push(r);
				recordResultBudgetUsage(tokenBudget, r);
				if (r.progress) allProgress.push(r.progress);
				if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

				if (gateSpec && gateSetup && graderConfig) {
					const gateWorktree = gateSetup.worktrees[0];
					if (!gateWorktree)
						throw new Error(
							`Acceptance gate step ${stepIndex + 1}: worktree setup returned no worktree.`,
						);
					const diffsDir = path.join(
						chainDir,
						"worktree-diffs",
						`step-${stepIndex}`,
					);
					const initialDiffs = diffWorktrees(
						gateSetup,
						[seqStep.agent],
						diffsDir,
					);
					const changedFiles = initialDiffs[0]?.changedFiles ?? [];
					const graderTask = buildGraderTask({
						rubric: gateSpec.rubric,
						threshold: gateSpec.threshold,
						producerOutput: getSingleResultOutput(r),
						changedFiles,
						// Both public evidence values are worktree-scoped in report-only v1.
						evidence: "worktree",
					});
					const graderAgent: AgentConfig = {
						...graderConfig,
						tools: [...GRADER_READ_ONLY_TOOLS],
						mcpDirectTools: undefined,
						disallowedTools: undefined,
						extensions: [],
					};
					const graderResult = await runSync(
						ctx.cwd,
						[graderAgent],
						gateSpec.grader,
						graderTask,
						{
							cwd: gateWorktree.agentCwd,
							signal,
							runId,
							runStartedAt,
							index: globalTaskIndex,
							maxSubagentDepth: resolveChildMaxSubagentDepth(
								params.maxSubagentDepth,
								graderConfig.maxSubagentDepth,
							),
							skipContextFiles: true,
							outputSchema: GATE_VERDICT_SCHEMA,
							graderAllowedRoot: gateWorktree.path,
							availableModels,
							preferredModelProvider: ctx.model?.provider,
							controlConfig,
							onControlEvent,
						},
					);
					recordRun(
						gateSpec.grader,
						graderTask,
						graderResult.exitCode,
						graderResult.progressSummary?.durationMs ?? 0,
					);
					recordResultBudgetUsage(tokenBudget, graderResult);
					globalTaskIndex++;

					let verdict: GateVerdict | undefined;
					let verdictError: string | undefined;
					if (graderResult.exitCode !== 0 || graderResult.error) {
						verdictError =
							graderResult.error ||
							`grader exited with code ${graderResult.exitCode}`;
					} else if (graderResult.structuredOutput === undefined) {
						verdictError = "grader completed without a structured GateVerdict";
					} else {
						const semanticValidation = validateGateVerdictSemantics(
							graderResult.structuredOutput,
							gateSpec.rubric.length,
						);
						if (semanticValidation.status === "invalid") {
							verdictError = `invalid GateVerdict: ${semanticValidation.message}`;
						} else {
							verdict = graderResult.structuredOutput as GateVerdict;
						}
					}

					const finalDiffs = diffWorktrees(
						gateSetup,
						[seqStep.agent],
						diffsDir,
					);
					const gateReport = formatGateReport({
						grader: gateSpec.grader,
						verdict,
						error: verdictError,
						producerFailed: r.exitCode !== 0 || Boolean(r.error),
						diffSummary: formatGateDiffSummary(
							finalDiffs.length > 0 ? finalDiffs : initialDiffs,
						),
					});
					gateReports.push(gateReport);
					const gatePassed =
						verdict?.pass === true &&
						!verdictError &&
						r.exitCode === 0 &&
						!r.error;
					if (!gatePassed) {
						const summary = buildChainSummary(
							chainSteps,
							results,
							chainDir,
							"failed",
							{
								index: stepIndex,
								error: "Acceptance gate returned FAIL.",
							},
						);
						return {
							content: [{ type: "text", text: `${summary}\n\n${gateReport}` }],
							isError: true,
							details: buildChainExecutionDetails({
								results,
								includeProgress,
								allProgress,
								allArtifactPaths,
								artifactsDir,
								chainAgents,
								totalSteps,
								currentStepIndex: stepIndex,
							}),
						};
					}
				}

				if (r.interrupted) {
					return {
						content: [
							{
								type: "text",
								text: `Chain paused after interrupt at step ${stepIndex + 1} (${r.agent}). Waiting for explicit next action.`,
							},
						],
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
					};
				}
				if (r.detached) {
					return {
						content: [
							{
								type: "text",
								text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${r.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.`,
							},
						],
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
					};
				}

				if (r.exitCode !== 0) {
					const recovered = getSingleResultOutput(r).trim();
					const summary = buildChainSummary(
						chainSteps,
						results,
						chainDir,
						"failed",
						{
							index: stepIndex,
							error: r.error || "Chain failed",
							recoveredOutput: recovered || undefined,
						},
					);
					return {
						content: [{ type: "text", text: summary }],
						details: buildChainExecutionDetails({
							results,
							includeProgress,
							allProgress,
							allArtifactPaths,
							artifactsDir,
							chainAgents,
							totalSteps,
							currentStepIndex: stepIndex,
						}),
						isError: true,
					};
				}

				if (behavior.output) {
					try {
						const expectedPath = path.isAbsolute(behavior.output)
							? behavior.output
							: path.join(chainDir, behavior.output);
						if (!fs.existsSync(expectedPath)) {
							const dirFiles = fs.readdirSync(chainDir);
							const mdFiles = dirFiles.filter(
								(file) => file.endsWith(".md") && file !== "progress.md",
							);
							const warning =
								mdFiles.length > 0
									? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
									: `Agent did not create expected output file: ${behavior.output}`;
							r.error = r.error ? `${r.error}\n${warning}` : warning;
						}
					} catch {
						// Ignore validation errors; this diagnostic should not mask successful chain output.
					}
				}

				if (seqStep.as && r.exitCode === 0 && !r.error)
					outputs[seqStep.as] = outputEntryFromResult(r, stepIndex);
				prev = stripStaleAgentBlocks(getSingleResultOutput(r));
			} finally {
				if (gateSetup) cleanupWorktrees(gateSetup);
			}
		}
	}

	const summary = buildChainSummary(chainSteps, results, chainDir, "completed");
	const output =
		gateReports.length > 0
			? `${summary}\n\n${gateReports.join("\n\n")}`
			: summary;

	return {
		content: [{ type: "text", text: output }],
		details: buildChainExecutionDetails({
			results,
			includeProgress,
			allProgress,
			allArtifactPaths,
			artifactsDir,
			chainAgents,
			totalSteps,
			budget: currentBudgetSummary(),
		}),
	};
}
