import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_GATE_EVIDENCE,
	DEFAULT_GATE_GRADER,
	DEFAULT_GATE_MAX_ITERATIONS,
	DEFAULT_GATE_THRESHOLD,
	GATE_VERDICT_SCHEMA,
	buildGraderTask,
	normalizeGateSpec,
	validateGateVerdictSemantics,
} from "../../src/runs/shared/acceptance-gate.ts";
import { validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";

const validVerdict = {
	pass: true,
	score: 1,
	criteria: [
		{ criterion: "Adds the feature", met: true, note: "The implementation is present." },
		{ criterion: "Covers the feature with a test", met: true },
	],
	feedback: "No further changes are needed.",
};

describe("acceptance gate contract", () => {
	it("normalizes defaults and copies a string rubric into an array", () => {
		assert.deepEqual(normalizeGateSpec({ rubric: "Ship the feature" }), {
			rubric: ["Ship the feature"],
			grader: DEFAULT_GATE_GRADER,
			maxIterations: DEFAULT_GATE_MAX_ITERATIONS,
			threshold: DEFAULT_GATE_THRESHOLD,
			onExhausted: "fail",
			evidence: DEFAULT_GATE_EVIDENCE,
		});

		const rubric = ["criterion one", "criterion two"];
		const normalized = normalizeGateSpec({ rubric, grader: "reviewer", maxIterations: 3, threshold: 0.5, onExhausted: "accept-last", evidence: "report-only" });
		assert.deepEqual(normalized, {
			rubric,
			grader: "reviewer",
			maxIterations: 3,
			threshold: 0.5,
			onExhausted: "accept-last",
			evidence: "report-only",
		});
		assert.notEqual(normalized.rubric, rubric);
	});

	it("accepts the exact GateVerdict shape and rejects malformed values", () => {
		assert.deepEqual(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, validVerdict), { status: "valid" });

		const missingRequired = { ...validVerdict };
		delete (missingRequired as { feedback?: string }).feedback;
		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, missingRequired).status, "invalid");

		const extraProperty = { ...validVerdict, extra: true };
		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, extraProperty).status, "invalid");

		const extraCriterionProperty = {
			...validVerdict,
			criteria: [{ criterion: "Adds the feature", met: true, unexpected: "no" }, validVerdict.criteria[1]],
		};
		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, extraCriterionProperty).status, "invalid");

		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, { ...validVerdict, score: -0.1 }).status, "invalid");
		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, { ...validVerdict, score: 1.1 }).status, "invalid");
		assert.equal(validateStructuredOutputValue(GATE_VERDICT_SCHEMA, { ...validVerdict, criteria: undefined }).status, "invalid");
	});

	it("rejects criteria-count mismatches and dishonest grader arithmetic", () => {
		const countMismatch = validateGateVerdictSemantics({ ...validVerdict, criteria: [validVerdict.criteria[0]] }, 2);
		assert.equal(countMismatch.status, "invalid");
		if (countMismatch.status === "invalid") assert.match(countMismatch.message, /criteria length/i);

		const dishonestScore = validateGateVerdictSemantics({ ...validVerdict, score: 0.5 }, 2);
		assert.equal(dishonestScore.status, "invalid");
		if (dishonestScore.status === "invalid") assert.match(dishonestScore.message, /recomputed score/i);

		assert.deepEqual(validateGateVerdictSemantics({ ...validVerdict, score: 1 }, 2), { status: "valid" });
	});

	it("requires changed files to be read in worktree evidence mode", () => {
		const task = buildGraderTask({
			rubric: ["Adds the feature", "Tests the feature"],
			threshold: 0.5,
			producerOutput: "The producer says both criteria are complete.",
			changedFiles: ["src/feature.ts", "test/feature.test.ts"],
			evidence: "worktree",
		});

		assert.match(task, /0\.5/);
		assert.match(task, /The producer says both criteria are complete/);
		assert.match(task, /src\/feature\.ts/);
		assert.match(task, /test\/feature\.test\.ts/);
		assert.match(task, /READ the actual contents of every listed changed file/i);
	});

	it("omits changed-file evidence and the read instruction in report-only mode", () => {
		const task = buildGraderTask({
			rubric: "The producer report explains the result",
			producerOutput: "The producer report is the only supplied evidence.",
			changedFiles: ["src/should-not-be-mentioned.ts"],
			evidence: "report-only",
		});

		assert.match(task, /The producer report is the only supplied evidence/);
		assert.doesNotMatch(task, /should-not-be-mentioned\.ts/);
		assert.doesNotMatch(task, /READ the actual contents/i);
		assert.doesNotMatch(task, /attempt WORKTREE/i);
	});
});
