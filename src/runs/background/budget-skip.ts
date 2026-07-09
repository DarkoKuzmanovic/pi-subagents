import { isParallelGroup, isRunnerDynamicStep, type RunnerStep } from "../shared/parallel-utils.ts";

export interface BudgetSkippedStepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
	skipped?: boolean;
}

export interface BudgetSkipStatusStep {
	status?: string;
	error?: string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	exitCode?: number | null;
	activityState?: string;
	recentOutput?: string[];
}

export interface BudgetSkipStatusPayload {
	steps: Array<BudgetSkipStatusStep | undefined>;
	lastUpdate: number;
}

export function budgetSkippedStepResult(agent: string): BudgetSkippedStepResult {
	return {
		agent,
		output: "skipped(budget-exhausted)",
		success: true,
		skipped: true,
		error: "budget-exhausted",
	};
}

export function markStatusStepBudgetSkipped(step: BudgetSkipStatusStep | undefined, skippedAt: number): void {
	if (!step) return;
	step.status = "failed";
	step.error = "budget-exhausted";
	step.startedAt = skippedAt;
	step.endedAt = skippedAt;
	step.durationMs = 0;
	step.exitCode = -1;
	step.activityState = undefined;
	step.recentOutput = ["skipped(budget-exhausted)"];
}

export function appendBudgetSkippedRunnerSteps(input: {
	results: BudgetSkippedStepResult[];
	statusPayload: BudgetSkipStatusPayload;
	steps: RunnerStep[];
	startStepIndex: number;
	startFlatIndex: number;
	skippedAt: number;
}): void {
	let cursor = input.startFlatIndex;
	for (let i = input.startStepIndex; i < input.steps.length; i++) {
		const step = input.steps[i]!;
		if (isParallelGroup(step)) {
			for (const task of step.parallel) {
				markStatusStepBudgetSkipped(input.statusPayload.steps[cursor], input.skippedAt);
				input.results.push(budgetSkippedStepResult(task.agent));
				cursor++;
			}
		} else if (isRunnerDynamicStep(step)) {
			input.results.push(budgetSkippedStepResult(step.dynamic.template.agent));
		} else {
			markStatusStepBudgetSkipped(input.statusPayload.steps[cursor], input.skippedAt);
			input.results.push(budgetSkippedStepResult(step.agent));
			cursor++;
		}
	}
	input.statusPayload.lastUpdate = input.skippedAt;
}
