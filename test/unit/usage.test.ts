import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, sumUsage } from "../../src/runs/shared/usage.js";

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
