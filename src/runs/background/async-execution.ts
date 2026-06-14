/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { formatUnknownAgentError } from "../../agents/agent-selection.ts";
import { applyEffectiveThinkingSuffix } from "../shared/pi-args.ts";
import { injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveModelCandidate, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import {
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	type ResolvedControlConfig,
	type SubagentRunMode,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();
/**
 * Resolve the path to `jiti`'s CLI script. Pi spawns a Node subprocess against
 * this script to run TypeScript async runners.
 *
 * Probe ladder, in order:
 *  1. Extension-bundled `jiti` (newer, preferred)
 *  2. Extension-bundled `@earendil-works/jiti` (legacy fork)
 *  3. Pi-bundled `@earendil-works/jiti`
 *  4. Pi-bundled `jiti`
 *
 * Local candidates win because the extension's own dependency tree is the
 * source of truth for its async runner. Pi-bundled fallbacks let the
 * extension run when installed without a hoisted local jiti.
 *
 * Exported for testing.
 */
/** Minimal subset of `NodeRequire` used by the resolver. */
export interface RequireLike {
	resolve: (id: string) => string;
}

export interface JitiResolverDeps {
	localRequire: RequireLike;
	piRequire: RequireLike | undefined;
	fileExists: (p: string) => boolean;
}

export function resolveJitiCliPath(deps: JitiResolverDeps): string | undefined {
	const { localRequire, piRequire, fileExists } = deps;
	const probes: Array<[RequireLike | undefined, string]> = [
		[localRequire, "jiti"],
		[localRequire, "@earendil-works/jiti"],
		[piRequire, "@earendil-works/jiti"],
		[piRequire, "jiti"],
	];
	for (const [req, pkg] of probes) {
		if (!req) continue;
		try {
			const cliPath = path.join(path.dirname(req.resolve(`${pkg}/package.json`)), "lib/jiti-cli.mjs");
			if (fileExists(cliPath)) return cliPath;
		} catch {
			// Package not resolvable in this require context; continue probing.
		}
	}
	return undefined;
}

function createPiRequire(): RequireLike | undefined {
	try {
		const piEntry = fs.realpathSync(process.argv[1]);
		return createRequire(piEntry);
	} catch {
		return undefined;
	}
}

const jitiCliPath: string | undefined = resolveJitiCliPath({
	localRequire: require,
	piRequire: createPiRequire(),
	fileExists: fs.existsSync,
});

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
	currentModel?: string;
}

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	resultMode?: SubagentRunMode;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	nestedRoute?: import("../../shared/types.ts").NestedRouteInfo;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	modelOverride?: string;
	thinking?: string;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	nestedRoute?: import("../../shared/types.ts").NestedRouteInfo;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.",
	].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

/**
 * Spawn the async runner process
 */
function spawnRunner(cfg: object, suffix: string, cwd: string, asyncDir?: string): { pid?: number; error?: string } {
	if (!jitiCliPath) {
		return { error: "jiti for TypeScript execution could not be found" };
	}

	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	// Capture the detached runner's own stdout/stderr to a log file instead of discarding
	// them. The runner's crash handlers (uncaughtException/unhandledRejection/runSubagent
	// .catch) write a stack trace via console.error; with stdio:"ignore" those vanished,
	// making a runner crash look like "process disappeared" with no diagnosis. Routing to
	// <asyncDir>/runner-stderr.log preserves the trace next to the run's other artifacts.
	let logFd: number | undefined;
	if (asyncDir) {
		try {
			logFd = fs.openSync(path.join(asyncDir, "runner-stderr.log"), "a");
		} catch {
			// Best effort: fall back to ignoring stdio if the log cannot be opened.
			logFd = undefined;
		}
	}

	const proc = spawn(process.execPath, [jitiCliPath, runner, cfgPath], {
		cwd,
		detached: true,
		stdio: logFd !== undefined ? ["ignore", logFd, logFd] : "ignore",
		windowsHide: true,
	});
	// The child inherited its own dup of the fd; release the parent's copy.
	if (logFd !== undefined) {
		try {
			fs.closeSync(logFd);
		} catch {
			// Best effort.
		}
	}
	proc.on("error", (error) => {
		console.error(`[pi-subagents] async spawn failed: ${error.message}`);
	});
	if (typeof proc.pid !== "number") {
		return { error: `async runner did not produce a pid for cwd: ${cwd}` };
	}
	proc.unref();
	return { pid: proc.pid };
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep) ? firstStep.parallel[0]?.task : (firstStep as SequentialStep).task)
		: undefined);

	// TODO(async-fanout): dynamic fanout (expand/collect) is rejected in async mode below.
	// Lifting this needs runtime task-count scaffolding in the background runner (the static
	// pre-baked session-file/status/index slots have no room for runtime-materialized items).
	// See PLAN-structured-output-fanout.md "Follow-up: Async dynamic fanout".
	const dynamicStepIndex = chain.findIndex((s) => isDynamicParallelStep(s));
	if (dynamicStepIndex >= 0) {
		return {
			content: [{ type: "text", text: `Dynamic fanout (expand/collect) at chain step ${dynamicStepIndex + 1} is not yet supported in async mode. Run this chain in the foreground (omit async), where dynamic fanout is fully supported.` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: formatUnknownAgentError(agentName, agents) }],
					isError: true,
					details: { mode: resultMode, results: [] },
				};
			}
		}
	}

	try {
		validateChainOutputBindings(chain);
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: { mode: resultMode, results: [] },
			};
		}
		throw error;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
			...(s.thinking ? { thinking: s.thinking } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, stepCwd, ctx.cwd);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, runnerCwd, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${s.task ?? "{previous}"}${progressInstructions.suffix}`, outputPath);

		const primaryModel = resolveModelCandidate(behavior.model ?? a.model, availableModels, ctx.currentModelProvider) ?? (behavior.thinking ? ctx.currentModel : undefined);
		return {
			agent: s.agent,
			task,
			cwd: stepCwd,
			model: applyEffectiveThinkingSuffix(primaryModel, behavior.thinking ?? a.thinking),
			modelCandidates: Array.from(
				new Set(buildModelCandidates(behavior.model ?? a.model, a.fallbackModels, availableModels, ctx.currentModelProvider).concat(primaryModel ? [primaryModel] : [])),
			).map((candidate) => applyEffectiveThinkingSuffix(candidate, behavior.thinking ?? a.thinking)),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			outputSchema: s.outputSchema,
			as: s.as,
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	let steps: RunnerStep[];
	try {
		steps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree) writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex);
							} catch {
								behaviorCwd = undefined;
							}
						}
						return buildSeqStep(t, nextSessionFile(), behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex]);
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			return buildSeqStep(s as SequentialStep, nextSessionFile());
		});
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if ("parallel" in step) {
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				nestedRoute: params.nestedRoute,
			},
			id,
			runnerCwd,
			asyncDir,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: [(firstStep as SequentialStep).agent];
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
			),
			chainStepCount: chain.length,
			parallelGroups,
			cwd: runnerCwd,
			asyncDir,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir },
	};
}

/**
 * Execute a single agent asynchronously.
 * Thin wrapper — pre-normalizes output and delegates to executeAsyncChain.
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const { agent, agentConfig, skills, output, outputMode, modelOverride, thinking } = params;

	// Pre-normalize output — chain path uses resolveStepBehavior which has different
	// default-fallback logic. Explicit false suppresses chain's fallback to agentConfig.output.
	const normalizedOutput = normalizeSingleOutputOverride(output, agentConfig.output);

	const step: SequentialStep = {
		agent,
		task: params.task,
		output: normalizedOutput ?? false, // undefined → false (suppress chain default)
		outputMode: outputMode ?? "inline",
		reads: false, // single path has no read instructions
		progress: false, // single path has no progress instructions
		skill: skills,
		model: modelOverride,
		thinking,
	};

	return executeAsyncChain(id, {
		chain: [step],
		task: params.task,
		resultMode: "single",
		agents: [agentConfig],
		ctx: params.ctx,
		cwd: params.cwd,
		maxOutput: params.maxOutput,
		artifactsDir: params.artifactsDir,
		artifactConfig: params.artifactConfig,
		shareEnabled: params.shareEnabled,
		sessionRoot: params.sessionRoot,
		chainSkills: [],
		sessionFilesByFlatIndex: params.sessionFile ? [params.sessionFile] : [],
		maxSubagentDepth: params.maxSubagentDepth,
		worktreeSetupHook: params.worktreeSetupHook,
		worktreeSetupHookTimeoutMs: params.worktreeSetupHookTimeoutMs,
		controlConfig: params.controlConfig,
		controlIntercomTarget: params.controlIntercomTarget,
		childIntercomTarget: params.childIntercomTarget,
		availableModels: params.availableModels,
	});
}
