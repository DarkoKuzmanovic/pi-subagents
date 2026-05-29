import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, sumUsage, tokenUsageFromAttempts } from "../../src/runs/shared/usage.js";

describe("emptyUsage", () => {
	it("returns zero-filled Usage object", () => {
		const u = emptyUsage();
		assert.deepEqual(u, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
	});

	it("returns a new object each time", () => {
		const a = emptyUsage();
		const b = emptyUsage();
		assert.notStrictEqual(a, b);
	});
});

describe("sumUsage", () => {
	it("accumulates source fields into target", () => {
		const target = emptyUsage();
		const source = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 3 };
		sumUsage(target, source);
		assert.deepEqual(target, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.5, turns: 3 });
	});

	it("accumulates multiple sources", () => {
		const target = emptyUsage();
		sumUsage(target, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 });
		sumUsage(target, { input: 20, output: 10, cacheRead: 3, cacheWrite: 2, cost: 0.2, turns: 2 });
		assert.deepEqual(target, { input: 30, output: 15, cacheRead: 3, cacheWrite: 2, cost: 0.30000000000000004, turns: 3 });
	});

	it("zero source does not change target", () => {
		const target = { input: 5, output: 3, cacheRead: 1, cacheWrite: 1, cost: 0.1, turns: 2 };
		sumUsage(target, emptyUsage());
		assert.deepEqual(target, { input: 5, output: 3, cacheRead: 1, cacheWrite: 1, cost: 0.1, turns: 2 });
	});

	it("mutates target in place", () => {
		const target = emptyUsage();
		const original = target;
		sumUsage(target, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
		assert.strictEqual(target, original);
	});
});

describe("tokenUsageFromAttempts", () => {
	const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });

	// Regression guard: this helper was referenced by the parallel async runner but never
	// defined, throwing `ReferenceError: tokenUsageFromAttempts is not defined` and crashing
	// the detached runner before it wrote a result (runs 8d0ce5b7 / deb83f54 / 2a652574).
	it("is defined and callable", () => {
		assert.equal(typeof tokenUsageFromAttempts, "function");
	});

	it("returns null for undefined or empty attempts", () => {
		assert.equal(tokenUsageFromAttempts(undefined), null);
		assert.equal(tokenUsageFromAttempts([]), null);
	});

	it("returns null when no attempt carries usage data", () => {
		assert.equal(tokenUsageFromAttempts([{ model: "m", success: true }]), null);
	});

	it("sums input/output across attempts with total = input + output", () => {
		const result = tokenUsageFromAttempts([
			{ model: "a", success: false, usage: usage(10, 5) },
			{ model: "b", success: true, usage: usage(20, 7) },
		]);
		assert.deepEqual(result, { input: 30, output: 12, total: 42 });
	});

	it("ignores attempts missing usage while summing the rest", () => {
		const result = tokenUsageFromAttempts([
			{ model: "a", success: false },
			{ model: "b", success: true, usage: usage(3, 4) },
		]);
		assert.deepEqual(result, { input: 3, output: 4, total: 7 });
	});
});
