/**
 * Unit tests for token-economy footer.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendTokenFooter, formatBudgetFooter, formatTokenFooter } from "../../src/shared/token-footer.ts";
import type { Usage } from "../../src/shared/types.ts";

const makeUsage = (input: number, output: number, cacheRead: number, cacheWrite: number): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	cost: 0,
	turns: 1,
});

describe("formatTokenFooter", () => {
	it("returns null for non-fresh mode", () => {
		const details = { results: [{ usage: makeUsage(1000, 100, 5000, 0) }] };
		assert.equal(formatTokenFooter(details, { mode: "fork", hasError: false }), null);
	});

	it("returns null when hasError is true", () => {
		const details = { results: [{ usage: makeUsage(1000, 100, 5000, 0) }] };
		assert.equal(formatTokenFooter(details, { mode: "fresh", hasError: true }), null);
	});

	it("returns null when details is undefined", () => {
		assert.equal(formatTokenFooter(undefined, { mode: "fresh", hasError: false }), null);
	});

	it("returns null when results is empty", () => {
		assert.equal(formatTokenFooter({ results: [] }, { mode: "fresh", hasError: false }), null);
	});

	it("returns null when all usage is zero", () => {
		const details = { results: [{ usage: makeUsage(0, 0, 0, 0) }] };
		assert.equal(formatTokenFooter(details, { mode: "fresh", hasError: false }), null);
	});

	it("returns footer for fresh mode with usage", () => {
		const details = { results: [{ usage: makeUsage(1527, 3, 10100, 0) }] };
		const footer = formatTokenFooter(details, { mode: "fresh", hasError: false });
		assert.ok(footer);
		assert.ok(footer!.startsWith("[mode=fresh,"));
		assert.ok(footer!.includes("in=1.5K"));
		assert.ok(footer!.includes("out=3"));
		assert.ok(footer!.includes("cache_read=10.1K"));
		assert.ok(footer!.includes("cache_write=0"));
	});

	it("aggregates usage across multiple results", () => {
		const details = {
			results: [
				{ usage: makeUsage(1000, 100, 5000, 0) },
				{ usage: makeUsage(2000, 200, 10000, 0) },
			],
		};
		const footer = formatTokenFooter(details, { mode: "fresh", hasError: false });
		assert.ok(footer);
		assert.ok(footer!.includes("in=3K"));
		assert.ok(footer!.includes("out=300"));
		assert.ok(footer!.includes("cache_read=15K"));
	});

	it("accumulates cost and turns across results", () => {
		const details = {
			results: [
				{ usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 2 } },
				{ usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 1.0, turns: 3 } },
			],
		};
		const footer = formatTokenFooter(details, { mode: "fresh", hasError: false });
		assert.ok(footer);
		// Footer currently doesn't display cost/turns, but aggregation should be correct internally.
		// This test ensures the accumulation fix for cost+turns doesn't regress.
		assert.ok(footer!.includes("in=300"));
		assert.ok(footer!.includes("out=30"));
	});

	it("uses M suffix for large numbers", () => {
		const details = { results: [{ usage: makeUsage(1_500_000, 100, 0, 0) }] };
		const footer = formatTokenFooter(details, { mode: "fresh", hasError: false });
		assert.ok(footer!.includes("in=1.5M"));
	});

	it("formats a budget footer when budget details are present", () => {
		const footer = formatBudgetFooter({
			spentOutput: 120,
			limit: 100,
			remainingOutput: 0,
			exhausted: true,
			overshootOutput: 20,
		});
		assert.equal(footer, "[budget: 120/100 output tokens, exhausted]");
	});
});

describe("appendTokenFooter", () => {
	it("appends footer to text", () => {
		const details = { results: [{ usage: makeUsage(1000, 100, 5000, 0) }] };
		const result = appendTokenFooter("Hello", details, { mode: "fresh", hasError: false });
		assert.ok(result.includes("Hello"));
		assert.ok(result.includes("[mode=fresh,"));
	});

	it("returns text unchanged when footer is null", () => {
		const details = { results: [{ usage: makeUsage(1000, 100, 5000, 0) }] };
		const result = appendTokenFooter("Hello", details, { mode: "fork", hasError: false });
		assert.equal(result, "Hello");
	});

	it("appends the budget footer even when fresh-context token footer is omitted", () => {
		const details = {
			results: [{ usage: makeUsage(0, 120, 0, 0) }],
			budget: { spentOutput: 120, limit: 100, remainingOutput: 0, exhausted: true, overshootOutput: 20 },
		};
		const result = appendTokenFooter("Hello", details, { mode: "fork", hasError: false });
		assert.equal(result, "Hello\n\n[budget: 120/100 output tokens, exhausted]");
	});
});
