import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	collectDynamicResults,
	DynamicFanoutError,
	materializeDynamicParallelStep,
	normalizeItemKeyForId,
	resolveDynamicFanoutItems,
	resolveItemTemplate,
	resolveJsonPointer,
	validateDynamicCollection,
	validateDynamicStepShape,
} from "../../src/runs/shared/dynamic-fanout.js";
import type { DynamicParallelStep } from "../../src/shared/settings.js";
import type { ChainOutputMap } from "../../src/shared/types.js";

function outputsWith(structured: unknown): ChainOutputMap {
	return { ctx: { text: JSON.stringify(structured), structured, agent: "scout", stepIndex: 0 } };
}

function step(overrides: Partial<DynamicParallelStep> = {}): DynamicParallelStep {
	return {
		expand: { from: { output: "ctx", path: "/files" }, item: "f", maxItems: 10 },
		parallel: { agent: "worker", task: "fix {f}" },
		collect: { as: "fixes" },
		...overrides,
	};
}

describe("resolveJsonPointer", () => {
	it("resolves nested object and array paths", () => {
		assert.deepStrictEqual(resolveJsonPointer({ a: { b: [10, 20] } }, "/a/b/1", "x"), 20);
	});
	it("throws on a missing path", () => {
		assert.throws(() => resolveJsonPointer({ a: 1 }, "/b", "x"), DynamicFanoutError);
	});
	it("throws on a pointer not starting with /", () => {
		assert.throws(() => resolveJsonPointer({}, "a", "x"), DynamicFanoutError);
	});
});

describe("resolveItemTemplate", () => {
	it("substitutes the whole item and a dotted field", () => {
		assert.strictEqual(resolveItemTemplate("fix {f}", "f", "a.ts"), "fix a.ts");
		assert.strictEqual(resolveItemTemplate("fix {f.name}", "f", { name: "x.ts" }), "fix x.ts");
	});
	it("serializes object items referenced whole", () => {
		assert.strictEqual(resolveItemTemplate("{f}", "f", { a: 1 }), JSON.stringify({ a: 1 }));
	});
});

describe("normalizeItemKeyForId", () => {
	it("slugifies and falls back to 'item'", () => {
		assert.strictEqual(normalizeItemKeyForId("Foo Bar/Baz"), "foo-bar-baz");
		assert.strictEqual(normalizeItemKeyForId("!!!"), "item");
	});
});

describe("resolveDynamicFanoutItems", () => {
	it("materializes one item per array element", () => {
		const items = resolveDynamicFanoutItems(step(), outputsWith({ files: ["a.ts", "b.ts"] }), 0);
		assert.strictEqual(items.length, 2);
		assert.deepStrictEqual(items.map((i) => i.item), ["a.ts", "b.ts"]);
	});

	it("enforces maxItems", () => {
		assert.throws(
			() => resolveDynamicFanoutItems(step({ expand: { from: { output: "ctx", path: "/files" }, item: "f", maxItems: 1 } }), outputsWith({ files: ["a.ts", "b.ts"] }), 0),
			/exceeding maxItems/,
		);
	});

	it("rejects duplicate keys", () => {
		const dup = step({ expand: { from: { output: "ctx", path: "/files" }, item: "f", key: "/id", maxItems: 10 } });
		assert.throws(() => resolveDynamicFanoutItems(dup, outputsWith({ files: [{ id: "x" }, { id: "x" }] }), 0), /duplicate item key/);
	});

	it("throws when the referenced output is unknown", () => {
		assert.throws(() => resolveDynamicFanoutItems(step(), {}, 0), /unknown output/);
	});

	it("throws when the source output is not structured", () => {
		const outputs: ChainOutputMap = { ctx: { text: "prose", agent: "scout", stepIndex: 0 } };
		assert.throws(() => resolveDynamicFanoutItems(step(), outputs, 0), /requires structured output/);
	});

	it("throws when the path does not resolve to an array", () => {
		assert.throws(() => resolveDynamicFanoutItems(step(), outputsWith({ files: "nope" }), 0), /must resolve to an array/);
	});
});

describe("materializeDynamicParallelStep", () => {
	it("builds one parallel task per item with item-resolved templates", () => {
		const group = materializeDynamicParallelStep(step(), outputsWith({ files: ["a.ts", "b.ts"] }), 0);
		assert.strictEqual(group.parallel.length, 2);
		assert.deepStrictEqual(group.parallel.map((t) => t.task), ["fix a.ts", "fix b.ts"]);
		assert.ok(group.parallel.every((t) => t.agent === "worker"));
	});

	it("returns empty group and skips on empty source with onEmpty=skip (default)", () => {
		const group = materializeDynamicParallelStep(step(), outputsWith({ files: [] }), 0);
		assert.strictEqual(group.parallel.length, 0);
		assert.deepStrictEqual(group.collectedOnEmpty, []);
	});

	it("throws on empty source with onEmpty=fail", () => {
		const failStep = step({ expand: { from: { output: "ctx", path: "/files" }, item: "f", maxItems: 10, onEmpty: "fail" } });
		assert.throws(() => materializeDynamicParallelStep(failStep, outputsWith({ files: [] }), 0), /source array is empty/);
	});
});

describe("validateDynamicStepShape", () => {
	it("accepts a well-formed step", () => {
		assert.doesNotThrow(() => validateDynamicStepShape(step(), 0));
	});
	it("requires collect.as", () => {
		assert.throws(() => validateDynamicStepShape(step({ collect: { as: "" } }), 0), /collect\.as/);
	});
	it("rejects an unsupported field on the step", () => {
		assert.throws(() => validateDynamicStepShape({ ...step(), bogus: 1 } as unknown as DynamicParallelStep, 0), /does not support field/);
	});
	it("requires expand.maxItems or a config default", () => {
		const noMax = step({ expand: { from: { output: "ctx", path: "/files" }, item: "f" } });
		assert.throws(() => validateDynamicStepShape(noMax, 0), /maxItems/);
		assert.doesNotThrow(() => validateDynamicStepShape(noMax, 0, { maxItems: 5 }));
	});
});

describe("collectDynamicResults + validateDynamicCollection", () => {
	it("collects per-item results preserving keys and structured output", () => {
		const items = resolveDynamicFanoutItems(step(), outputsWith({ files: ["a.ts", "b.ts"] }), 0);
		const collected = collectDynamicResults(step(), items, [
			{ agent: "worker", exitCode: 0, finalOutput: "did a", structuredOutput: { ok: true } },
			{ agent: "worker", exitCode: 0, finalOutput: "did b" },
		] as never);
		assert.strictEqual(collected.length, 2);
		assert.deepStrictEqual(collected[0]!.structured, { ok: true });
		assert.strictEqual(collected[1]!.text, "did b");
		assert.deepStrictEqual(collected.map((c) => c.item), ["a.ts", "b.ts"]);
	});

	it("validateDynamicCollection passes a schema-valid array and throws otherwise", () => {
		const schema = { type: "array", items: { type: "object" } };
		assert.doesNotThrow(() => validateDynamicCollection(schema, [] as never));
		assert.doesNotThrow(() => validateDynamicCollection(undefined, [{ key: "a" }] as never));
		assert.throws(() => validateDynamicCollection({ type: "array", items: { type: "string" } }, [{ key: "a" }] as never), DynamicFanoutError);
	});
});
