import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	TOOL_BUDGET_ALWAYS_ALLOWED,
	createToolBudgetEnforcer,
	isBudgetedTool,
	sanitizeToolBudget,
} from "../../src/runs/shared/tool-budget.ts";

describe("sanitizeToolBudget", () => {
	it("requires a positive integer hard limit", () => {
		assert.equal(sanitizeToolBudget(undefined), undefined);
		assert.equal(sanitizeToolBudget({}), undefined);
		assert.equal(sanitizeToolBudget({ hard: 0 }), undefined);
		assert.equal(sanitizeToolBudget({ hard: -3 }), undefined);
		assert.equal(sanitizeToolBudget({ hard: 2.5 }), undefined);
		assert.equal(sanitizeToolBudget({ hard: "20" }), undefined);
		assert.equal(sanitizeToolBudget([{ hard: 20 }]), undefined);
		assert.deepEqual(sanitizeToolBudget({ hard: 20 }), { hard: 20 });
	});

	it("keeps a soft limit only when it can fire before the hard limit", () => {
		assert.deepEqual(sanitizeToolBudget({ soft: 12, hard: 20 }), { soft: 12, hard: 20 });
		assert.deepEqual(sanitizeToolBudget({ soft: 20, hard: 20 }), { hard: 20 });
		assert.deepEqual(sanitizeToolBudget({ soft: 25, hard: 20 }), { hard: 20 });
		assert.deepEqual(sanitizeToolBudget({ soft: 0, hard: 20 }), { hard: 20 });
	});

	it("normalizes the block list and drops it when nothing usable remains", () => {
		assert.deepEqual(sanitizeToolBudget({ hard: 5, block: [" read ", "read", "grep", "", 7] }), { hard: 5, block: ["read", "grep"] });
		assert.deepEqual(sanitizeToolBudget({ hard: 5, block: [] }), { hard: 5 });
		assert.deepEqual(sanitizeToolBudget({ hard: 5, block: "read" }), { hard: 5 });
	});

	it("accepts the shape this repo's own config.json already uses", () => {
		assert.deepEqual(
			sanitizeToolBudget({ soft: 12, hard: 20, block: ["read", "grep", "find", "ls"] }),
			{ soft: 12, hard: 20, block: ["read", "grep", "find", "ls"] },
		);
	});
});

describe("isBudgetedTool", () => {
	it("budgets exactly the configured tools when a block list is given", () => {
		const budget = { hard: 5, block: ["read", "grep"] };
		assert.equal(isBudgetedTool("read", budget), true);
		assert.equal(isBudgetedTool("grep", budget), true);
		assert.equal(isBudgetedTool("write", budget), false);
		assert.equal(isBudgetedTool("bash", budget), false);
	});

	it("budgets everything except the always-allowed tools when no block list is given", () => {
		const budget = { hard: 5 };
		assert.equal(isBudgetedTool("read", budget), true);
		assert.equal(isBudgetedTool("bash", budget), true);
		for (const tool of TOOL_BUDGET_ALWAYS_ALLOWED) {
			assert.equal(isBudgetedTool(tool, budget), false, `${tool} must stay available`);
		}
	});
});

describe("createToolBudgetEnforcer", () => {
	it("allows calls up to the hard limit and blocks budgeted tools after it", () => {
		const enforcer = createToolBudgetEnforcer({ hard: 3, block: ["read"] });
		assert.equal(enforcer.onToolCall("read").blocked, false);
		assert.equal(enforcer.onToolCall("read").blocked, false);
		assert.equal(enforcer.onToolCall("read").blocked, false);
		assert.equal(enforcer.used(), 3);

		const blocked = enforcer.onToolCall("read");
		assert.equal(blocked.blocked, true);
		assert.match(blocked.blocked ? blocked.reason : "", /Tool budget exhausted: 3 of 3/);
		// A blocked attempt must not consume budget, or the reported figure drifts from reality.
		assert.equal(enforcer.used(), 3);
		// Unbudgeted tools keep working so the child can still finish.
		assert.equal(enforcer.onToolCall("write").blocked, false);
	});

	it("keeps the always-allowed tools working at an exhausted budget with no block list", () => {
		const enforcer = createToolBudgetEnforcer({ hard: 1 });
		assert.equal(enforcer.onToolCall("read").blocked, false);
		assert.equal(enforcer.onToolCall("read").blocked, true);
		for (const tool of TOOL_BUDGET_ALWAYS_ALLOWED) {
			assert.equal(enforcer.onToolCall(tool).blocked, false, `${tool} must stay available`);
		}
	});

	it("delivers the soft nudge exactly once, and only after the soft limit is reached", () => {
		const enforcer = createToolBudgetEnforcer({ soft: 2, hard: 4 });
		enforcer.onToolCall("read");
		assert.equal(enforcer.takeSoftNudge(), undefined);
		enforcer.onToolCall("read");

		const nudge = enforcer.takeSoftNudge();
		assert.match(nudge ?? "", /\[tool budget\] 2 of 4 tool calls used/);
		assert.equal(enforcer.takeSoftNudge(), undefined);
	});

	it("never nudges when no soft limit is configured", () => {
		const enforcer = createToolBudgetEnforcer({ hard: 2 });
		enforcer.onToolCall("read");
		enforcer.onToolCall("read");
		assert.equal(enforcer.takeSoftNudge(), undefined);
	});
});
