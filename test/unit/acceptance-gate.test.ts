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
		const rubric = ["Adds the feature", "Covers the feature with a test"];
		const countMismatch = validateGateVerdictSemantics({ ...validVerdict, criteria: [validVerdict.criteria[0]] }, rubric, 1);
		assert.equal(countMismatch.status, "invalid");
		if (countMismatch.status === "invalid") assert.match(countMismatch.message, /criteria length/i);

		const dishonestScore = validateGateVerdictSemantics({ ...validVerdict, score: 0.5 }, rubric, 1);
		assert.equal(dishonestScore.status, "invalid");
		if (dishonestScore.status === "invalid") assert.match(dishonestScore.message, /recomputed score/i);

		const valid = validateGateVerdictSemantics({ ...validVerdict, score: 1 }, rubric, 1);
		assert.equal(valid.status, "valid");
		if (valid.status === "valid") {
			assert.equal(valid.verdict.pass, true);
			assert.equal(valid.verdict.score, 1);
			assert.deepEqual(valid.verdict.criteria.map((entry) => entry.criterion), rubric);
		}
	});

	it("binds every verdict criterion to the configured rubric criterion at the same index", () => {
		const rubric = ["Adds the feature", "Covers the feature with a test"];

		const invented = validateGateVerdictSemantics(
			{
				...validVerdict,
				criteria: [{ criterion: "Adds the feature", met: true }, { criterion: "Looks nice", met: true }],
			},
			rubric,
			1,
		);
		assert.equal(invented.status, "invalid");
		if (invented.status === "invalid") assert.match(invented.message, /does not match configured rubric criterion/i);

		// No normalization: a criterion that differs only in case or whitespace is a different criterion.
		const nearMiss = validateGateVerdictSemantics(
			{
				...validVerdict,
				criteria: [{ criterion: "adds the feature ", met: true }, { criterion: "Covers the feature with a test", met: true }],
			},
			rubric,
			1,
		);
		assert.equal(nearMiss.status, "invalid");

		const swapped = validateGateVerdictSemantics(
			{
				...validVerdict,
				criteria: [{ criterion: rubric[1], met: true }, { criterion: rubric[0], met: true }],
			},
			rubric,
			1,
		);
		assert.equal(swapped.status, "invalid");
	});

	it("honors pass only when the recomputed score meets the configured threshold", () => {
		const rubric = ["Adds the feature", "Covers the feature with a test"];
		const halfMet = {
			pass: true,
			score: 0.5,
			criteria: [
				{ criterion: rubric[0], met: true },
				{ criterion: rubric[1], met: false, note: "No test was added." },
			],
			feedback: "Claiming success anyway.",
		};

		const belowThreshold = validateGateVerdictSemantics(halfMet, rubric, 1);
		assert.equal(belowThreshold.status, "valid");
		if (belowThreshold.status === "valid") {
			assert.equal(belowThreshold.verdict.pass, false, "a pass below threshold must be downgraded to fail");
			assert.equal(belowThreshold.verdict.score, 0.5);
		}

		const atThreshold = validateGateVerdictSemantics(halfMet, rubric, 0.5);
		assert.equal(atThreshold.status, "valid");
		if (atThreshold.status === "valid") assert.equal(atThreshold.verdict.pass, true);

		// A grader that says fail is never upgraded, whatever the score.
		const graderSaysFail = validateGateVerdictSemantics({ ...validVerdict, pass: false }, rubric, 1);
		assert.equal(graderSaysFail.status, "valid");
		if (graderSaysFail.status === "valid") assert.equal(graderSaysFail.verdict.pass, false);
	});

	it("fails a score that sits just below the configured threshold", () => {
		const rubric = ["Adds the feature", "Covers the feature with a test"];
		const halfMet = {
			pass: true,
			score: 0.5,
			criteria: [
				{ criterion: rubric[0], met: true },
				{ criterion: rubric[1], met: false },
			],
			feedback: "Claiming success anyway.",
		};

		// A hair below threshold is still below threshold: no epsilon may buy a pass.
		const justBelow = validateGateVerdictSemantics(halfMet, rubric, 0.5000005);
		assert.equal(justBelow.status, "valid");
		if (justBelow.status === "valid") {
			assert.equal(justBelow.verdict.pass, false, "0.5 must not pass a 0.5000005 threshold");
		}
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
