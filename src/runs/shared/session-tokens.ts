import type { BudgetSummary, TokenUsage } from "../../shared/types.ts";

export interface SessionTokenBudget {
	key: string;
	limit?: number;
	spentOutput: number;
	overshootOutput: number;
}

function normalizeBudgetLimit(limit: number | undefined): number | undefined {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return undefined;
	return Math.floor(limit);
}

export function createSessionTokenBudget(key: string, limit: number | undefined): SessionTokenBudget {
	return {
		key,
		limit: normalizeBudgetLimit(limit),
		spentOutput: 0,
		overshootOutput: 0,
	};
}

export function remainingOutputTokens(budget: SessionTokenBudget): number | undefined {
	if (budget.limit === undefined) return undefined;
	return Math.max(0, budget.limit - budget.spentOutput);
}

export function isBudgetExhausted(budget: SessionTokenBudget): boolean {
	return budget.limit !== undefined && budget.spentOutput >= budget.limit;
}

export function shouldDispatchWithBudget(budget: SessionTokenBudget): boolean {
	return !isBudgetExhausted(budget);
}

export function recordBudgetUsage(
	budget: SessionTokenBudget,
	usage: Pick<TokenUsage, "output"> | null | undefined,
): void {
	const output = usage?.output;
	if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return;
	budget.spentOutput += output;
	if (budget.limit !== undefined) {
		budget.overshootOutput = Math.max(0, budget.spentOutput - budget.limit);
	}
}

export function budgetSummary(budget: SessionTokenBudget): BudgetSummary | undefined {
	if (budget.limit === undefined) return undefined;
	return {
		limit: budget.limit,
		spentOutput: budget.spentOutput,
		remainingOutput: remainingOutputTokens(budget) ?? 0,
		exhausted: isBudgetExhausted(budget),
		overshootOutput: budget.overshootOutput,
	};
}
