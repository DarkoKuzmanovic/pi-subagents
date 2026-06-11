import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceJsonArrayParam } from "../../src/shared/utils.ts";
import { coerceEnvelopeArrays } from "../../src/runs/foreground/subagent-executor.ts";

describe("coerceJsonArrayParam", () => {
	it("passes undefined/null through untouched", () => {
		assert.deepEqual(coerceJsonArrayParam(undefined, "chain"), {});
		assert.deepEqual(coerceJsonArrayParam(null, "chain"), {});
	});

	it("passes a literal array through with identical content", () => {
		const arr = [{ agent: "scout", task: "look around" }];
		const result = coerceJsonArrayParam(arr, "chain");
		assert.equal(result.error, undefined);
		assert.deepEqual(result.value, arr);
	});

	it("parses a JSON-stringified array (the cheap-driver envelope defect)", () => {
		const result = coerceJsonArrayParam('[{"agent":"worker","task":"do it"}]', "chain");
		assert.equal(result.error, undefined);
		assert.deepEqual(result.value, [{ agent: "worker", task: "do it" }]);
	});

	it("refuses an unparseable string with a corrective message", () => {
		const result = coerceJsonArrayParam("not json at all", "chain");
		assert.ok(result.error);
		assert.match(result.error, /chain must be a JSON array/);
		assert.match(result.error, /literal JSON array/);
	});

	it("refuses a string that parses to a non-array", () => {
		const result = coerceJsonArrayParam('{"agent":"worker"}', "tasks");
		assert.ok(result.error);
		assert.match(result.error, /tasks must be an array/);
	});

	it("parses stringified items inside the array", () => {
		const result = coerceJsonArrayParam(['{"agent":"worker","task":"deep"}'], "tasks");
		assert.equal(result.error, undefined);
		assert.deepEqual(result.value, [{ agent: "worker", task: "deep" }]);
	});

	it("refuses an unparseable item string, naming the index", () => {
		const result = coerceJsonArrayParam([{ agent: "a", task: "t" }, "broken"], "tasks");
		assert.ok(result.error);
		assert.match(result.error, /tasks\[1\]/);
	});

	it("refuses an item string that parses to a non-object", () => {
		const result = coerceJsonArrayParam(['"just a string"'], "chain");
		assert.ok(result.error);
		assert.match(result.error, /chain\[0\] must be an object/);
	});
});

describe("coerceEnvelopeArrays", () => {
	it("returns params unchanged when chain/tasks are absent", () => {
		const params = { agent: "scout", task: "look" };
		const result = coerceEnvelopeArrays(params);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.params, params);
	});

	it("coerces a stringified chain", () => {
		const result = coerceEnvelopeArrays({
			chain: '[{"agent":"scout","task":"recon {task}"},{"agent":"worker"}]',
		} as never);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.params?.chain, [{ agent: "scout", task: "recon {task}" }, { agent: "worker" }]);
	});

	it("coerces stringified tasks", () => {
		const result = coerceEnvelopeArrays({
			tasks: '[{"agent":"worker","task":"a"},{"agent":"worker","task":"b"}]',
		} as never);
		assert.equal(result.error, undefined);
		assert.equal(result.params?.tasks?.length, 2);
		assert.equal(result.params?.tasks?.[0]?.agent, "worker");
	});

	it("coerces a stringified parallel array inside a chain step", () => {
		const result = coerceEnvelopeArrays({
			chain: [
				{ agent: "scout", task: "first" },
				{ parallel: '[{"agent":"worker","task":"p1"},{"agent":"worker","task":"p2"}]' },
			],
		} as never);
		assert.equal(result.error, undefined);
		const step = result.params?.chain?.[1] as { parallel?: unknown[] };
		assert.deepEqual(step.parallel, [
			{ agent: "worker", task: "p1" },
			{ agent: "worker", task: "p2" },
		]);
	});

	it("surfaces a corrective error for an unparseable chain string", () => {
		const result = coerceEnvelopeArrays({ chain: "[{broken" } as never);
		assert.ok(result.error);
		assert.match(result.error, /chain must be a JSON array/);
		assert.equal(result.params, undefined);
	});

	it("surfaces a corrective error naming the step for a bad nested parallel", () => {
		const result = coerceEnvelopeArrays({
			chain: [{ agent: "a", task: "t" }, { parallel: "{oops}" }],
		} as never);
		assert.ok(result.error);
		assert.match(result.error, /chain\[1\]\.parallel/);
	});

	it("preserves untouched literal arrays and other params", () => {
		const chain = [{ agent: "scout", task: "x" }];
		const result = coerceEnvelopeArrays({ chain, worktree: true, concurrency: 2 } as never);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.params?.chain, chain);
		assert.equal((result.params as { worktree?: boolean }).worktree, true);
	});
});
