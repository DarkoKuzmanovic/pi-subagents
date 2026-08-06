/**
 * Chain behavior, template resolution, and directory management
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import { normalizeSkillInput } from "../agents/skills.ts";
import { CHAIN_RUNS_DIR, type JsonSchemaObject, type OutputMode } from "./types.ts";
import { assertRelativeOutputPathWithinBase, materializeDirectoryWithinRoot, resolveOutputPathWithinBase } from "./path-containment.ts";
const CHAIN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_PROGRESS_CONTENT = "# Progress\n\n## Status\nIn Progress\n\n## Tasks\n\n## Files Changed\n\n## Notes\n";

// =============================================================================
// Behavior Resolution Types
// =============================================================================

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
	thinking?: string;
}

// `lane` is a pre-resolution dispatch hint. Executors resolve it to concrete
// model/thinking overrides before calling resolveStepBehavior; this module only
// carries the field through typed step shapes.
export interface StepOverrides {
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
	thinking?: string;
	lane?: string;
}

function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
	return output === "false" ? false : output;
}

// =============================================================================
// Chain Step Types
// =============================================================================

/** Sequential step: single agent execution */
export interface SequentialStep {
	agent: string;
	task?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	thinking?: string;
	lane?: string;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent: string;
	task?: string;
	label?: string;
	as?: string;
	outputSchema?: JsonSchemaObject;
	cwd?: string;
	count?: number;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
	thinking?: string;
	lane?: string;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	cwd?: string;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

/** Source array spec for dynamic fanout: expand an array from a prior step's structured output. */
export interface DynamicExpandSpec {
	from: {
		output: string;
		path: string;
	};
	item?: string;
	key?: string;
	maxItems?: number;
	onEmpty?: "skip" | "fail";
}

export type DynamicParallelTemplate = Omit<ParallelTaskItem, "as" | "count">;

export interface DynamicCollectSpec {
	as: string;
	outputSchema?: JsonSchemaObject;
}

/** Dynamic fanout step: expand a structured array, run one parallel template per item, collect results. */
export interface DynamicParallelStep {
	expand: DynamicExpandSpec;
	parallel: DynamicParallelTemplate;
	collect: DynamicCollectSpec;
	concurrency?: number;
	failFast?: boolean;
	label?: string;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep | DynamicParallelStep;

// =============================================================================
// Type Guards
// =============================================================================

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

export function isDynamicParallelStep(step: ChainStep): step is DynamicParallelStep {
	return "expand" in step && "collect" in step && "parallel" in step && !Array.isArray((step as { parallel?: unknown }).parallel);
}

/** Get all agent names in a step (single for sequential, multiple for parallel) */
export function getStepAgents(step: ChainStep): string[] {
	if (isDynamicParallelStep(step)) {
		return [step.parallel.agent];
	}
	if (isParallelStep(step)) {
		return step.parallel.map((t) => t.agent);
	}
	return [step.agent];
}

// =============================================================================
// Chain Directory Management
// =============================================================================

export function createChainDir(runId: string, baseDir?: string): string {
	const chainDir = path.join(baseDir ? path.resolve(baseDir) : CHAIN_RUNS_DIR, runId);
	fs.mkdirSync(chainDir, { recursive: true });
	return chainDir;
}

export function removeChainDir(chainDir: string): void {
	try {
		fs.rmSync(chainDir, { recursive: true });
	} catch {
		// Chain cleanup is best-effort. Runs can already have cleaned their temp dir.
	}
}

export function cleanupOldChainDirs(): void {
	if (!fs.existsSync(CHAIN_RUNS_DIR)) return;
	const now = Date.now();
	let dirs: string[];
	try {
		dirs = fs.readdirSync(CHAIN_RUNS_DIR);
	} catch {
		// Startup cleanup is best-effort. If the scoped temp root is unreadable,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		try {
			const dirPath = path.join(CHAIN_RUNS_DIR, dir);
			const stat = fs.statSync(dirPath);
			if (stat.isDirectory() && now - stat.mtimeMs > CHAIN_DIR_MAX_AGE_MS) {
				fs.rmSync(dirPath, { recursive: true });
			}
		} catch {
			// Skip directories that can't be processed; continue with others
		}
	}
}

// =============================================================================
// Template Resolution
// =============================================================================

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplates(
	steps: ChainStep[],
): ResolvedTemplates {
	return steps.map((step, i) => {
		if (isParallelStep(step)) {
			// Parallel step: resolve each task's template
			return step.parallel.map((task) => {
				if (task.task) return task.task;
				// Default for parallel tasks is {previous}
				return "{previous}";
			});
		}
		// Sequential step: existing logic
		const seq = step as SequentialStep;
		if (seq.task) return seq.task;
		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

// =============================================================================
// Behavior Resolution
// =============================================================================

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output =
		stepOutput !== undefined
			? stepOutput
			: normalizeOutputOverride(agentConfig.output) ?? false;

	// Reads: step override > frontmatter defaultReads > false (no reads)
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	// Progress: step override > frontmatter defaultProgress > false
	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	}

	const outputMode = stepOverrides.outputMode ?? "inline";
	const model = stepOverrides.model ?? agentConfig.model;
	const thinking = stepOverrides.thinking ?? agentConfig.thinking;
	return { output, outputMode, reads, progress, skills, model, thinking };
}

export function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined {
	if (!task) return originalTask;
	// Replacer function: a string replacement would interpret `$&` etc. in the task text.
	return originalTask ? task.replaceAll("{task}", () => originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return /\breview[- ]only\b/i.test(task)
		|| /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
		|| /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
		|| /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
		|| /\bleave\s+files?\s+unchanged\b/i.test(task);
}

export function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior {
	const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
	return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}

// =============================================================================
// Chain Instruction Injection
// =============================================================================

/**
 * Resolve a file path: absolute paths pass through, relative paths get chainDir prepended.
 */
function resolveChainPath(filePath: string, chainDir: string): string {
	const expanded = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath;
	return path.isAbsolute(expanded) ? expanded : path.join(chainDir, expanded);
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function writeInitialProgressFile(progressDir: string): void {
	fs.writeFileSync(path.join(progressDir, "progress.md"), INITIAL_PROGRESS_CONTENT);
}

// =============================================================================
// Inline Read Support
// =============================================================================

const DEFAULT_INLINE_READ_MAX_BYTES = 200 * 1024;
const GLOB_MAX_MATCHES = 50;
let inlineReadMaxBytes = DEFAULT_INLINE_READ_MAX_BYTES;

/**
 * Module-scoped cache for deduplicating inline reads across a single run.
 * Capped at CACHE_MAX_ENTRIES to prevent unbounded memory growth in long-lived processes.
 * LRU eviction: oldest entries are deleted when the cap is reached.
 */
const CACHE_MAX_ENTRIES = 128;
const inlineReadCache = new Map<string, string>();

/** Clear the inline read cache. Call at the start of each top-level run. */
export function clearInlineReadCache(): void {
	inlineReadCache.clear();
}

/** Set a cache entry with LRU eviction when the cap is reached. */
function cacheSet(key: string, value: string): void {
	// Map insertion order = iteration order; delete+set moves to end (newest)
	if (inlineReadCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = inlineReadCache.keys().next().value;
		if (oldest !== undefined) inlineReadCache.delete(oldest);
	}
	inlineReadCache.set(key, value);
}

/** Get the current inline read max bytes limit. */
export function getInlineReadMaxBytes(): number {
	return inlineReadMaxBytes;
}

/** Set the inline read max bytes limit with range guard. */
export function setInlineReadMaxBytes(value: number | undefined): void {
	if (value === undefined) {
		inlineReadMaxBytes = DEFAULT_INLINE_READ_MAX_BYTES;
		return;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		console.warn(`inlineReadMaxBytes: invalid value ${value}, using default ${DEFAULT_INLINE_READ_MAX_BYTES}`);
		inlineReadMaxBytes = DEFAULT_INLINE_READ_MAX_BYTES;
		return;
	}
	const clamped = Math.max(1024, Math.min(value, 8 * 1024 * 1024));
	if (clamped !== value) {
		console.warn(`inlineReadMaxBytes: ${value} out of range [1024, 8MB], clamped to ${clamped}`);
	}
	inlineReadMaxBytes = clamped;
}

/** Parse a read spec into file path and optional line range. Bug-D defense: if the literal spec exists as a file, treat it as a file, not a range. */
export function parseReadSpec(spec: string, chainDir: string): { filePath: string; range?: { start: number; end: number }; label: string } {
	const rangeMatch = spec.match(/^(.*):(\d+)-(\d+)$/);
	if (rangeMatch) {
		const resolvedLiteral = resolveChainPath(spec, chainDir);
		// Bug-D defense: if the literal spec (with colons) exists as a file, treat as file
		try {
			if (fs.statSync(resolvedLiteral).isFile()) {
				return { filePath: resolvedLiteral, label: spec };
			}
		} catch {
			// Not a file — proceed with range parsing
		}
		const [, base, startStr, endStr] = rangeMatch;
		const resolved = resolveChainPath(base!, chainDir);
		const start = Number(startStr);
		const end = Number(endStr);
		// Guard: inverted or zero-width ranges are treated as full-file reads
		if (start > end || start < 1) {
			return { filePath: resolved, label: spec };
		}
		return { filePath: resolved, range: { start, end }, label: `${base}:${start}-${end}` };
	}
	return { filePath: resolveChainPath(spec, chainDir), label: spec };
}

/** Read a single file for inline injection. Returns { label, body, ok }. */
export function readInlineRead(spec: string, chainDir: string): { label: string; body: string; ok: boolean } {
	const { filePath, range, label } = parseReadSpec(spec, chainDir);
	const MAX = getInlineReadMaxBytes();
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
		return { label, body: `[unreadable: ${code}: ${filePath}]`, ok: false };
	}
	if (!stat.isFile()) {
		return { label, body: `[not a file: ${filePath}]`, ok: false };
	}

	// Check cache
	const cacheKey = `${filePath}\0${stat.mtimeMs}\0${stat.size}`;
	const cached = inlineReadCache.get(cacheKey);
	if (cached !== undefined) {
		const raw = cached;
		return { label, body: applyRange(raw, range, MAX), ok: true };
	}

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
		return { label, body: `[unreadable: ${code}: ${filePath}]`, ok: false };
	}

	// Cache the full content
	cacheSet(cacheKey, raw);

	return { label, body: applyRange(raw, range, MAX), ok: true };
}

function applyRange(raw: string, range: { start: number; end: number } | undefined, maxBytes: number): string {
	let content = raw;
	if (range) {
		const lines = content.split("\n");
		const sliced = lines.slice(range.start - 1, range.end);
		content = sliced.join("\n");
	}
	// Bug C: compare encoded byte length, label as characters
	if (Buffer.byteLength(content, "utf8") > maxBytes) {
		content = content.slice(0, maxBytes);
		content += `\n... [truncated at ~${maxBytes} characters]`;
	}
	return content;
}

/** Check if a string contains glob characters. */
function hasGlobChars(s: string): boolean {
	return /[*?\[]/.test(s);
}

/** Expand glob patterns in read specs. Bug-D defense: if literal path with glob chars exists as file, treat as literal. Bug-F: expand ~ before globSync. */
export function expandReadGlobs(specs: string[], chainDir: string): { specs: string[]; emptyGlobs: string[] } {
	const result: string[] = [];
	const emptyGlobs: string[] = [];

	for (const spec of specs) {
		if (!hasGlobChars(spec)) {
			result.push(spec);
			continue;
		}

		// Bug-D defense: if the literal spec with glob chars exists as a real file, treat as literal
		const resolvedLiteral = resolveChainPath(spec, chainDir);
		try {
			if (fs.statSync(resolvedLiteral).isFile()) {
				result.push(spec);
				continue;
			}
		} catch {
			// Not a file — proceed with glob expansion
		}

		// Bug-F: expand ~ before glob matching
		const expanded = spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(2)) : spec;

		let cwd: string;
		let pattern: string;
		if (path.isAbsolute(expanded)) {
			cwd = path.dirname(expanded);
			pattern = path.basename(expanded);
		} else {
			cwd = chainDir;
			pattern = expanded;
		}

		let matches: string[];
		try {
			matches = fs.globSync(pattern, { cwd });
		} catch {
			matches = [];
		}

		if (matches.length === 0) {
			emptyGlobs.push(spec);
			continue;
		}

		// Lex-sort and cap
		matches.sort();
		if (matches.length > GLOB_MAX_MATCHES) {
			matches = matches.slice(0, GLOB_MAX_MATCHES);
		}

		for (const match of matches) {
			result.push(path.resolve(cwd, match));
		}
	}

	return { specs: result, emptyGlobs };
}

export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
	inlineReads?: boolean,
): { prefix: string; suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];

	// READS
	if (behavior.reads && behavior.reads.length > 0) {
		// Expand globs first
		const { specs: expandedSpecs, emptyGlobs } = expandReadGlobs(behavior.reads, chainDir);

		if (inlineReads) {
			// Inline mode: pre-load file contents, separate ok from failed
			const okEntries: { label: string; body: string }[] = [];
			const failedPaths: string[] = [];

			for (const spec of expandedSpecs) {
				const result = readInlineRead(spec, chainDir);
				if (result.ok) {
					okEntries.push({ label: result.label, body: result.body });
				} else {
					failedPaths.push(resolveChainPath(spec, chainDir));
				}
			}

			if (okEntries.length > 0) {
				const blocks = okEntries.map((e) => `### ${e.label}\n\n${e.body}`).join("\n\n");
			prefixParts.push(`Pre-loaded files (do not Read these — contents are below):\n\n${blocks}`);
			}
			if (failedPaths.length > 0) {
				prefixParts.push(`[Read from: ${failedPaths.join(", ")}]`);
			}
		} else {
			// Legacy mode: just list file paths
			const files = expandedSpecs.map((f) => resolveChainPath(f, chainDir));
			prefixParts.push(`[Read from: ${files.join(", ")}]`);
		}

		// Emit empty-glob hints
		for (const pattern of emptyGlobs) {
			prefixParts.push(`[Read from glob (no matches): ${pattern}]`);
		}
	}

	// OUTPUT - prepend so agent knows where to write
	if (behavior.output) {
		const outputPath = resolveOutputPathWithinBase(behavior.output, chainDir);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	// Progress instructions in suffix (less critical)
	if (behavior.progress) {
		const progressPath = path.join(chainDir, "progress.md");
		if (isFirstProgressAgent) {
			suffixParts.push(`Create and maintain progress at: ${progressPath}`);
		} else {
			suffixParts.push(`Update progress at: ${progressPath}`);
		}
	}

	// Include previous step's summary in suffix if available
	if (previousSummary && previousSummary.trim()) {
		suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
	}

	const prefix = prefixParts.length > 0
		? prefixParts.join("\n") + "\n\n"
		: "";

	const suffix = suffixParts.length > 0
		? "\n\n---\n" + suffixParts.join("\n")
		: "";

	return { prefix, suffix };
}

// =============================================================================
// Parallel Step Support
// =============================================================================

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	agentConfigs: AgentConfig[],
	stepIndex: number,
	chainSkills?: string[],
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		if (!config) {
			throw new Error(`Unknown agent: ${task.agent}`);
		}

		// Build subdirectory path for this parallel task
		const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);

		// Output: task override > agent default (namespaced) > false
		// Absolute paths pass through unchanged; relative paths get namespaced under subdir
		let output: string | false = false;
		const taskOutput = normalizeOutputOverride(task.output);
		const configOutput = normalizeOutputOverride(config.output);
		if (taskOutput !== undefined) {
			if (taskOutput === false) {
				output = false;
			} else if (path.isAbsolute(taskOutput)) {
				output = taskOutput; // Absolute path: use as-is
			} else {
				assertRelativeOutputPathWithinBase(taskOutput, subdir);
				output = path.join(subdir, taskOutput); // Relative: namespace under subdir
			}
		} else if (configOutput) {
			// Agent defaults are always relative, so namespace them
			assertRelativeOutputPathWithinBase(configOutput, subdir);
			output = path.join(subdir, configOutput);
		}

		// Reads: task override > agent default > false
		const reads =
			task.reads !== undefined ? task.reads : config.defaultReads ?? false;

		// Progress: task override > agent default > false
		const progress =
			task.progress !== undefined
				? task.progress
				: config.defaultProgress ?? false;

		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: string[] | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			skills = [...taskSkillInput];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		} else {
			skills = config.skills ? [...config.skills] : [];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		}

		const outputMode = task.outputMode ?? "inline";
		const model = task.model ?? config.model;
		const thinking = task.thinking ?? config.thinking;
		return { output, outputMode, reads, progress, skills, model, thinking };
	});
}

export function resolveParallelItemOutputPath(
	output: string | false | undefined,
	chainDir: string,
	stepIndex: number,
	taskIndex: number,
	agentName: string,
): string | undefined {
	if (typeof output !== "string" || !output) return undefined;
	if (path.isAbsolute(output)) return output;
	const taskDir = path.join(chainDir, `parallel-${stepIndex}`, `${taskIndex}-${agentName}`);
	return resolveOutputPathWithinBase(output, taskDir, chainDir);
}

/**
 * Create subdirectories for parallel step outputs
 */
export function createParallelDirs(
	chainDir: string,
	stepIndex: number,
	taskCount: number,
	agentNames: string[],
): void {
	for (let i = 0; i < taskCount; i++) {
		const subdir = path.join(chainDir, `parallel-${stepIndex}`, `${i}-${agentNames[i]}`);
		materializeDirectoryWithinRoot(subdir, chainDir);
	}
}

// =============================================================================
// Chain Prompt Hygiene
// =============================================================================

/** Regex to strip stale XML blocks that would confuse downstream chain agents. */
const STALE_XML_BLOCK_RE = /<(?:sub_agent_context|runtime_truth)>[\s\S]*?<\/(?:sub_agent_context|runtime_truth)>/g;

/**
 * Strip stale <sub_agent_context> and <runtime_truth> blocks from text
 * before passing it as chain context to the next agent.
 * Prevents Agent B from thinking it has Agent A's context/tools.
 */
export function stripStaleAgentBlocks(text: string): string {
	if (!text) return text;
	const cleaned = text.replace(STALE_XML_BLOCK_RE, "").trim();
	return cleaned || text; // If stripping removed everything, return original
}
