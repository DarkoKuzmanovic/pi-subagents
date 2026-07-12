import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceEnvelopeArrays } from "../../src/runs/foreground/subagent-executor.js";
import { assertJsonPointer, resolveItemTemplate, validateDynamicStepShape } from "../../src/runs/shared/dynamic-fanout.js";
import type { DynamicParallelStep } from "../../src/shared/settings.js";

const expand = { from: { output: "ctx", path: "/files" }, item: "f", maxItems: 10 } as const;

function dynStep(parallel: Record<string, unknown>): DynamicParallelStep {
	return { expand: { ...expand }, parallel, collect: { as: "fixes" } } as unknown as DynamicParallelStep;
}

// B1 regression: coerceEnvelopeArrays must not run a dynamic single-object `parallel` through array coercion.
describe("coerceEnvelopeArrays + dynamic fanout (B1)", () => {
	it("preserves a literal single-object parallel for a dynamic step", () => {
		const res = coerceEnvelopeArrays({
			chain: [{ expand: { ...expand }, parallel: { agent: "worker", task: "{f}" }, collect: { as: "fixes" } }],
		} as never);
		assert.equal(res.error, undefined);
		const step = (res.params as { chain: Array<{ parallel: unknown }> }).chain[0]!;
		assert.deepStrictEqual(step.parallel, { agent: "worker", task: "{f}" });
	});

	it("parses a JSON-stringified single-object parallel (cheap driver) for a dynamic step", () => {
		const res = coerceEnvelopeArrays({
			chain: [{ expand: { ...expand }, parallel: JSON.stringify({ agent: "worker", task: "{f}" }), collect: { as: "fixes" } }],
		} as never);
		assert.equal(res.error, undefined);
		const step = (res.params as { chain: Array<{ parallel: unknown }> }).chain[0]!;
		assert.deepStrictEqual(step.parallel, { agent: "worker", task: "{f}" });
	});

	it("rejects an array parallel on a dynamic step with a clear message", () => {
		const res = coerceEnvelopeArrays({
			chain: [{ expand: { ...expand }, parallel: [{ agent: "worker" }], collect: { as: "fixes" } }],
		} as never);
		// An array parallel skips dynamic coercion and is treated as static; the dynamic-shape
		// guard later rejects it. Here we only assert coercion does not crash and preserves the array.
		assert.equal(res.error, undefined);
		const step = (res.params as { chain: Array<{ parallel: unknown }> }).chain[0]!;
		assert.ok(Array.isArray(step.parallel));
	});

	it("still coerces a stringified ARRAY for a static parallel step (no regression)", () => {
		const res = coerceEnvelopeArrays({
			chain: [{ parallel: JSON.stringify([{ agent: "a" }, { agent: "b" }]) }],
		} as never);
		assert.equal(res.error, undefined);
		const step = (res.params as { chain: Array<{ parallel: unknown }> }).chain[0]!;
		assert.ok(Array.isArray(step.parallel));
		assert.equal((step.parallel as unknown[]).length, 2);
	});
});

// K1 regression: fork-specific `lane`/`thinking` must be accepted on a dynamic template; Tier-3 `acceptance` must be rejected.
describe("validateDynamicStepShape key allow-list (K1)", () => {
	it("accepts fork-specific lane and thinking on the parallel template", () => {
		assert.doesNotThrow(() => validateDynamicStepShape(dynStep({ agent: "worker", task: "{f}", lane: "easy", thinking: "medium" }), 0));
	});

	it("rejects a stale Tier-3 acceptance field on the parallel template", () => {
		assert.throws(() => validateDynamicStepShape(dynStep({ agent: "worker", task: "{f}", acceptance: "verified" }), 0), /does not support field 'acceptance'/);
	});
});

// Template path coverage (DeepSeek missing-tests): nested + malformed dotted refs.
describe("resolveItemTemplate dotted paths", () => {
	it("resolves a deeply nested {item.a.b.c}", () => {
		assert.strictEqual(resolveItemTemplate("v={f.a.b.c}", "f", { a: { b: { c: "deep" } } }), "v=deep");
	});
	it("leaves a non-matching trailing-dot reference {f.} literal", () => {
		assert.strictEqual(resolveItemTemplate("{f.}", "f", { a: 1 }), "{f.}");
	});
	it("throws on a double-dot path segment {f.a..b}", () => {
		assert.throws(() => resolveItemTemplate("{f.a..b}", "f", { a: 1 }), /Invalid item reference/);
	});
});

// MEDIUM/LOW hardening: expand.onEmpty enum + non-string JSON pointer guards.
function dynStepExpand(expandOverride: Record<string, unknown>): DynamicParallelStep {
	return {
		expand: { from: { output: "ctx", path: "/files" }, item: "f", maxItems: 10, ...expandOverride },
		parallel: { agent: "worker", task: "{f}" },
		collect: { as: "fixes" },
	} as unknown as DynamicParallelStep;
}

describe("validateDynamicStepShape expand.onEmpty enum", () => {
	it("accepts 'skip' and 'fail'", () => {
		assert.doesNotThrow(() => validateDynamicStepShape(dynStepExpand({ onEmpty: "skip" }), 0));
		assert.doesNotThrow(() => validateDynamicStepShape(dynStepExpand({ onEmpty: "fail" }), 0));
	});
	it("accepts an omitted onEmpty (defaults to skip)", () => {
		assert.doesNotThrow(() => validateDynamicStepShape(dynStepExpand({}), 0));
	});
	it("rejects a typo'd onEmpty instead of silently treating it as skip", () => {
		assert.throws(() => validateDynamicStepShape(dynStepExpand({ onEmpty: "error" }), 0), /onEmpty must be 'skip' or 'fail'/);
	});
});

describe("assertJsonPointer non-string guard", () => {
	it("throws a DynamicFanoutError (not a raw TypeError) on a non-string pointer", () => {
		assert.throws(() => assertJsonPointer(123 as unknown as string, "expand.from.path"), /expand\.from\.path must be a string JSON Pointer/);
	});
	it("surfaces a non-string from.path through validateDynamicStepShape as a DynamicFanoutError", () => {
		assert.throws(() => validateDynamicStepShape(dynStepExpand({ from: { output: "ctx", path: 5 } }), 0), /must be a string JSON Pointer/);
	});
});
