import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createSessionTokenBudget,
	isBudgetExhausted,
	recordBudgetUsage,
	remainingOutputTokens,
	shouldDispatchWithBudget,
} from "../../src/runs/shared/session-tokens.ts";

describe("session output-token budget", () => {
	it("is disabled when no positive finite limit is configured", () => {
		for (const limit of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const budget = createSessionTokenBudget("run-1", limit);
			assert.equal(budget.limit, undefined);
			assert.equal(remainingOutputTokens(budget), undefined);
			assert.equal(shouldDispatchWithBudget(budget), true);
			assert.equal(isBudgetExhausted(budget), false);
		}
	});

	it("tracks output tokens only", () => {
		const budget = createSessionTokenBudget("run-1", 100);
		recordBudgetUsage(budget, { input: 900, output: 40, total: 940 });
		assert.equal(budget.spentOutput, 40);
		assert.equal(remainingOutputTokens(budget), 60);
		assert.equal(shouldDispatchWithBudget(budget), true);
	});

	it("exhausts when spent output reaches the limit", () => {
		const budget = createSessionTokenBudget("run-1", 100);
		recordBudgetUsage(budget, { input: 0, output: 75, total: 75 });
		assert.equal(isBudgetExhausted(budget), false);
		recordBudgetUsage(budget, { input: 0, output: 25, total: 25 });
		assert.equal(isBudgetExhausted(budget), true);
		assert.equal(remainingOutputTokens(budget), 0);
		assert.equal(shouldDispatchWithBudget(budget), false);
	});

	it("records overshoot without clamping spent output", () => {
		const budget = createSessionTokenBudget("run-1", 100);
		recordBudgetUsage(budget, { input: 0, output: 125, total: 125 });
		assert.equal(budget.spentOutput, 125);
		assert.equal(remainingOutputTokens(budget), 0);
		assert.equal(budget.overshootOutput, 25);
		assert.equal(shouldDispatchWithBudget(budget), false);
	});

	it("ignores missing or non-positive usage samples", () => {
		const budget = createSessionTokenBudget("run-1", 100);
		recordBudgetUsage(budget, null);
		recordBudgetUsage(budget, undefined);
		recordBudgetUsage(budget, { input: 10, output: 0, total: 10 });
		recordBudgetUsage(budget, { input: 10, output: -5, total: 5 });
		assert.equal(budget.spentOutput, 0);
		assert.equal(remainingOutputTokens(budget), 100);
	});
});
