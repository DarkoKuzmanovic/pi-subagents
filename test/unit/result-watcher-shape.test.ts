import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidResultShapeError, parseResultFile } from "../../src/runs/background/result-watcher.ts";

describe("parseResultFile shape validation (GPTPRO P1.1)", () => {
	it("accepts a minimal valid result object", () => {
		const data = parseResultFile(JSON.stringify({ id: "run-1", success: true, summary: "done" }));
		assert.equal(data.id, "run-1");
		assert.equal(data.success, true);
		assert.equal(data.summary, "done");
	});

	it("accepts an empty object (all fields are optional)", () => {
		assert.deepEqual(parseResultFile("{}"), {});
	});

	it("accepts a full grouped result", () => {
		const data = parseResultFile(JSON.stringify({
			id: "async-1",
			runId: "run-123",
			agent: "parallel:a+b",
			mode: "parallel",
			success: false,
			state: "failed",
			summary: "Combined summary",
			results: [
				{ agent: "a", output: "A", success: true, sessionFile: "/tmp/a.jsonl", artifactPaths: { outputPath: "/tmp/a.md" }, intercomTarget: "t-a" },
				{ agent: "b", output: "B", success: false, error: "boom" },
			],
			sessionId: "session-1",
			cwd: "/repo",
			sessionFile: "/tmp/session.jsonl",
			asyncDir: "/tmp/async-1",
			intercomTarget: "orchestrator",
			budget: { limit: 10, used: 3 },
			budgetExhausted: false,
		}));
		assert.equal(data.results?.length, 2);
		assert.equal(data.results?.[1]?.error, "boom");
	});

	it("rejects non-object roots", () => {
		for (const raw of ["null", "[1,2]", "\"a string\"", "42", "true"]) {
			assert.throws(() => parseResultFile(raw), InvalidResultShapeError, `root ${raw} must be rejected`);
		}
	});

	it("propagates invalid JSON as SyntaxError, not InvalidResultShapeError", () => {
		// A truncated in-progress write is a transient condition; only complete-but-wrong
		// content gets the permanent-input-error classification.
		assert.throws(() => parseResultFile("{bad-json"), SyntaxError);
		assert.throws(() => parseResultFile("{bad-json"), (error: unknown) => !(error instanceof InvalidResultShapeError));
	});

	it("rejects wrong-typed string fields", () => {
		assert.throws(() => parseResultFile(JSON.stringify({ summary: 42 })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ id: {} })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ sessionId: ["s"] })), InvalidResultShapeError);
	});

	it("rejects wrong-typed boolean fields", () => {
		assert.throws(() => parseResultFile(JSON.stringify({ success: "yes" })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ budgetExhausted: 1 })), InvalidResultShapeError);
	});

	it("rejects a non-array results field and non-object entries", () => {
		assert.throws(() => parseResultFile(JSON.stringify({ results: {} })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ results: "all good" })), InvalidResultShapeError);
		// null entries would bypass the `result = {}` default-parameter guard downstream.
		assert.throws(() => parseResultFile(JSON.stringify({ results: [null] })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ results: [42] })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ results: [["nested"]] })), InvalidResultShapeError);
	});

	it("rejects a non-object budget field", () => {
		assert.throws(() => parseResultFile(JSON.stringify({ budget: "high" })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ budget: null })), InvalidResultShapeError);
		assert.throws(() => parseResultFile(JSON.stringify({ budget: [1] })), InvalidResultShapeError);
	});

	it("names the error class so watcher logs identify permanent input errors", () => {
		try {
			parseResultFile("[]");
			assert.fail("expected a throw");
		} catch (error) {
			assert.ok(error instanceof InvalidResultShapeError);
			assert.ok(error instanceof Error);
			assert.equal((error as Error).name, "InvalidResultShapeError");
		}
	});
});
