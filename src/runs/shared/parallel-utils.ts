import type { JsonSchemaObject } from "../../shared/types.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";

export interface RunnerSubagentStep {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	modelCandidates?: string[];
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	modelPromptRole?: string;
	/** Fallback model (provider/id format) for role resolution when model is undefined */
	modelPromptRoleFallbackModel?: string;
	skills?: string[];
	outputPath?: string;
	outputMode?: "inline" | "file-only";
	sessionFile?: string;
	maxSubagentDepth?: number;
	/** Tier 1 structured output: when set, the child must finish by calling structured_output with a schema-valid value. */
	outputSchema?: JsonSchemaObject;
	/** Chain-output binding name; this step's (structured) output is exposed as {outputs.<as>}. */
	as?: string;
	/** M6.1: structural logical key for the durable OM completion protocol, when this run is OM-registered. */
	omLogicalChildKey?: string;
}

export interface ParallelStepGroup {
	parallel: RunnerSubagentStep[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	/**
	 * Runtime-only dynamic-fanout markers. Set when a group is materialized from a
	 * {@link RunnerDynamicStep} at runtime (never present in the spawn config). When set,
	 * the parallel executor runs the tasks normally and then collects their results into
	 * `outputs[collect.as]` via a small epilogue. Not serialized.
	 */
	collect?: { as: string; outputSchema?: import("../../shared/types.ts").JsonSchemaObject };
	dynamicItems?: import("./dynamic-fanout.ts").DynamicMaterializedItem[];
	dynamicStep?: import("../../shared/settings.ts").DynamicParallelStep;
	dynamicAgent?: string;
}

/**
 * A dynamic-fanout step deferred to the background runner. Unlike a static parallel group,
 * its task count is unknown at spawn time — it expands an array from a prior step's
 * structured output. The parent pre-resolves the per-item {@link RunnerSubagentStep}
 * `template` (agent config, model, skills, system prompt, output-schema, instruction
 * wrapping) with a `sentinel` standing in for the per-item task; the runner materializes
 * items at runtime, clones the template per item, and runs them as a normal parallel group.
 * Contributes ZERO flat-index slots to the pre-baked status/session/intercom arrays; the
 * runner splices runtime slots in when it materializes.
 */
export interface RunnerDynamicStep {
	dynamic: {
		step: import("../../shared/settings.ts").DynamicParallelStep;
		template: RunnerSubagentStep;
		/** Behavior resolved at spawn time for the template (with sentinel task). */
		behavior: ResolvedStepBehavior;
		/** Progress instruction suffix that was appended to the template task. */
		progressSuffix?: string;
		/** Original top-level task for progress-suppression policy. */
		originalTask?: string;
		sentinel: string;
		stepIndex: number;
		maxItems?: number;
	};
}

export type RunnerStep = RunnerSubagentStep | ParallelStepGroup | RunnerDynamicStep;

export function isParallelGroup(step: RunnerStep): step is ParallelStepGroup {
	return "parallel" in step && Array.isArray((step as ParallelStepGroup).parallel);
}

export function isRunnerDynamicStep(step: RunnerStep): step is RunnerDynamicStep {
	return "dynamic" in step && !!(step as RunnerDynamicStep).dynamic && typeof (step as RunnerDynamicStep).dynamic === "object";
}

export function flattenSteps(steps: RunnerStep[]): RunnerSubagentStep[] {
	const flat: RunnerSubagentStep[] = [];
	for (const step of steps) {
		if (isRunnerDynamicStep(step)) continue; // materialized at runtime; contributes no pre-baked flat slots
		if (isParallelGroup(step)) {
			for (const task of step.parallel) flat.push(task);
		} else {
			flat.push(step);
		}
	}
	return flat;
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = new Array(items.length);
	let next = 0;

	async function worker(_workerIndex: number): Promise<void> {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(safeLimit, items.length) }, (_, wi) => worker(wi)),
	);
	return results;
}

export interface ParallelTaskResult {
	agent: string;
	taskIndex?: number;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	attemptedModels?: string[];
	outputTargetPath?: string;
	outputTargetExists?: boolean;
}

export function aggregateParallelOutputs(
	results: ParallelTaskResult[],
	headerFormat: (index: number, agent: string) => string = (i, agent) =>
		`=== Parallel Task ${i + 1} (${agent}) ===`,
): string {
	return results
		.map((r, i) => {
			const header = headerFormat(r.taskIndex ?? i, r.agent);
			const hasOutput = Boolean(r.output?.trim());
			const status =
				r.exitCode === -1
					? "SKIPPED"
					: r.exitCode !== 0 && r.exitCode !== null
						? `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}`
						: r.error
							? `WARNING: ${r.error}`
							: !hasOutput && r.outputTargetPath && r.outputTargetExists === false
								? `EMPTY OUTPUT (expected output file missing: ${r.outputTargetPath})`
								: !hasOutput && !r.outputTargetPath
									? "EMPTY OUTPUT (no textual response returned)"
							: "";
			const body = status ? (hasOutput ? `${status}\n${r.output}` : status) : r.output;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}
