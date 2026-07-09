import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendBudgetSkippedRunnerSteps } from "../../src/runs/background/budget-skip.ts";
import type { RunnerStep } from "../../src/runs/shared/parallel-utils.ts";

function sequential(agent: string): RunnerStep {
	return {
		agent,
		task: `${agent} task`,
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

function dynamic(agent: string): RunnerStep {
	return {
		dynamic: {
			step: {
				expand: { from: { output: "plan", path: "/files" } },
				parallel: { agent, task: `review {file}` },
				collect: { as: "reviews" },
			},
			template: sequential(agent),
			behavior: { progress: false },
			sentinel: "__ITEM__",
			stepIndex: 2,
		},
	};
}

describe("appendBudgetSkippedRunnerSteps", () => {
	it("marks remaining sequential and static parallel status rows while dynamic steps do not consume a pre-baked flat slot", () => {
		const steps: RunnerStep[] = [
			sequential("already-ran"),
			{ parallel: [sequential("parallel-a"), sequential("parallel-b")] },
			dynamic("dynamic-reviewer"),
			sequential("after-dynamic"),
		];
		const statusPayload = {
			steps: [
				{ agent: "already-ran", status: "complete" },
				{ agent: "parallel-a", status: "pending" },
				{ agent: "parallel-b", status: "pending" },
				{ agent: "after-dynamic", status: "pending" },
			],
			lastUpdate: 0,
		};
		const results: Array<{ agent: string; output: string; success: boolean; skipped?: boolean; error?: string }> = [];
		const skippedAt = 12345;

		appendBudgetSkippedRunnerSteps({
			results,
			statusPayload,
			steps,
			startStepIndex: 1,
			startFlatIndex: 1,
			skippedAt,
		});

		assert.deepEqual(results.map((r) => r.agent), ["parallel-a", "parallel-b", "dynamic-reviewer", "after-dynamic"]);
		assert.ok(results.every((r) => r.skipped === true && r.error === "budget-exhausted"));
		assert.equal(statusPayload.steps[0]?.status, "complete");
		assert.equal(statusPayload.steps[1]?.status, "failed");
		assert.equal(statusPayload.steps[1]?.exitCode, -1);
		assert.equal(statusPayload.steps[2]?.status, "failed");
		assert.equal(statusPayload.steps[2]?.exitCode, -1);
		assert.equal(statusPayload.steps[3]?.agent, "after-dynamic");
		assert.equal(statusPayload.steps[3]?.status, "failed");
		assert.equal(statusPayload.steps[3]?.exitCode, -1);
		assert.equal(statusPayload.lastUpdate, skippedAt);
	});
});
