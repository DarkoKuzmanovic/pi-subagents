import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ChainOutputValidationError,
	isStorableStepResult,
	outputEntryFromAsyncResult,
	outputEntryFromResult,
	resolveOutputReferences,
	validateChainOutputBindings,
} from "../../src/runs/shared/chain-outputs.js";
import type { ChainStep } from "../../src/shared/settings.js";
import type { ChainOutputMap, SingleResult } from "../../src/shared/types.js";

function seq(agent: string, extra: Record<string, unknown> = {}): ChainStep {
	return { agent, ...extra } as ChainStep;
}

describe("validateChainOutputBindings", () => {
	it("accepts a producing step and a later consumer", () => {
		const steps: ChainStep[] = [
			seq("scout", { as: "ctx", task: "find things" }),
			seq("planner", { task: "plan using {outputs.ctx}" }),
		];
		assert.doesNotThrow(() => validateChainOutputBindings(steps));
	});

	it("rejects duplicate as names", () => {
		const steps: ChainStep[] = [seq("a", { as: "ctx" }), seq("b", { as: "ctx" })];
		assert.throws(() => validateChainOutputBindings(steps), /Duplicate chain output name/);
	});

	it("rejects an invalid as identifier", () => {
		const steps: ChainStep[] = [seq("a", { as: "1bad" })];
		assert.throws(() => validateChainOutputBindings(steps), /Invalid chain output name/);
	});

	it("rejects a reference to an output that has not been produced yet (forward ref)", () => {
		const steps: ChainStep[] = [
			seq("planner", { task: "use {outputs.ctx}" }),
			seq("scout", { as: "ctx" }),
		];
		assert.throws(() => validateChainOutputBindings(steps), /Unknown chain output reference/);
	});

	it("rejects a reference to an entirely unknown output", () => {
		const steps: ChainStep[] = [seq("planner", { task: "use {outputs.nope}" })];
		assert.throws(() => validateChainOutputBindings(steps), /Unknown chain output reference/);
		assert.throws(() => validateChainOutputBindings([seq("planner", { task: "use {outputs.nope}" })]), ChainOutputValidationError);
	});

	it("supports parallel task as names becoming available to later steps", () => {
		const steps: ChainStep[] = [
			{ parallel: [{ agent: "a", as: "left" }, { agent: "b", as: "right" }] } as ChainStep,
			seq("merge", { task: "merge {outputs.left} and {outputs.right}" }),
		];
		assert.doesNotThrow(() => validateChainOutputBindings(steps));
	});
});

describe("resolveOutputReferences", () => {
	const outputs: ChainOutputMap = {
		ctx: { text: "CONTEXT-TEXT", agent: "scout", stepIndex: 0 },
	};

	it("substitutes a known output reference with its text", () => {
		assert.strictEqual(resolveOutputReferences("plan from {outputs.ctx}", outputs), "plan from CONTEXT-TEXT");
	});

	it("leaves non-output template vars untouched", () => {
		assert.strictEqual(resolveOutputReferences("keep {previous} here", outputs), "keep {previous} here");
	});

	it("leaves an unknown output reference literal at resolve time (BLK-1 degrade)", () => {
		assert.strictEqual(resolveOutputReferences("use {outputs.missing}", outputs), "use {outputs.missing}");
	});

	it("leaves an invalid-name output token literal at resolve time", () => {
		assert.strictEqual(resolveOutputReferences("use {outputs.1bad}", outputs), "use {outputs.1bad}");
	});

	it("substitutes known refs while leaving unknown ones literal (mixed)", () => {
		assert.strictEqual(
			resolveOutputReferences("{outputs.ctx} then {outputs.missing}", outputs),
			"CONTEXT-TEXT then {outputs.missing}",
		);
	});

	it("never throws on a literal outputs token in injected/free text (crash vector BLK-1)", () => {
		assert.doesNotThrow(() => resolveOutputReferences("explain the {outputs.name} syntax", outputs));
		assert.strictEqual(resolveOutputReferences("explain the {outputs.name} syntax", outputs), "explain the {outputs.name} syntax");
	});

	it("leaves inherited Object.prototype names literal (no prototype-chain leak)", () => {
		for (const proto of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
			assert.strictEqual(
				resolveOutputReferences(`x {outputs.${proto}} y`, outputs),
				`x {outputs.${proto}} y`,
			);
		}
	});
});

describe("outputEntryFromResult", () => {
	it("uses compact JSON text and keeps structured when structuredOutput is present", () => {
		const result = {
			agent: "scout",
			finalOutput: "prose that should be ignored",
			structuredOutput: { files: ["a.ts"], count: 1 },
		} as unknown as SingleResult;
		const entry = outputEntryFromResult(result, 2);
		assert.strictEqual(entry.text, JSON.stringify({ files: ["a.ts"], count: 1 }));
		assert.deepStrictEqual(entry.structured, { files: ["a.ts"], count: 1 });
		assert.strictEqual(entry.agent, "scout");
		assert.strictEqual(entry.stepIndex, 2);
	});

	it("falls back to prose output text when no structured output is present", () => {
		const result = { agent: "scout", finalOutput: "just prose" } as unknown as SingleResult;
		const entry = outputEntryFromResult(result, 0);
		assert.strictEqual(entry.text, "just prose");
		assert.strictEqual(entry.structured, undefined);
	});
});

describe("outputEntryFromAsyncResult (async chain loop)", () => {
	it("uses compact structured JSON when the async step captured structured output", () => {
		const entry = outputEntryFromAsyncResult({ agent: "worker", output: "prose ignored", structuredOutput: { ok: true, n: 2 } }, 1);
		assert.strictEqual(entry.text, JSON.stringify({ ok: true, n: 2 }));
		assert.deepStrictEqual(entry.structured, { ok: true, n: 2 });
		assert.strictEqual(entry.agent, "worker");
		assert.strictEqual(entry.stepIndex, 1);
	});

	it("falls back to the async result output text when no structured output is present", () => {
		const entry = outputEntryFromAsyncResult({ agent: "worker", output: "plain async output" }, 0);
		assert.strictEqual(entry.text, "plain async output");
		assert.strictEqual(entry.structured, undefined);
		assert.strictEqual(entry.agent, "worker");
	});
});

describe("isStorableStepResult (SF-1)", () => {
	it("is true for a clean success (exit 0, no error)", () => {
		assert.strictEqual(isStorableStepResult({ exitCode: 0 }), true);
		assert.strictEqual(isStorableStepResult({ exitCode: 0, error: undefined }), true);
	});
	it("is false for a non-zero exit code", () => {
		assert.strictEqual(isStorableStepResult({ exitCode: 1 }), false);
	});
	it("is false when an error is present even with exit 0", () => {
		assert.strictEqual(isStorableStepResult({ exitCode: 0, error: "boom" }), false);
	});
	it("is false for a failed step (non-zero exit and error)", () => {
		assert.strictEqual(isStorableStepResult({ exitCode: 1, error: "boom" }), false);
	});
});


describe("sequential outputSchema + as threading (TC-2)", () => {
	it("threads a sequential step's structured output into a later {outputs.name} reference", () => {
		const producer = { agent: "worker", exitCode: 0, structuredOutput: { files: ["a.ts", "b.ts"] } };
		const outputs: ChainOutputMap = {};
		if (isStorableStepResult(producer)) {
			outputs.plan = outputEntryFromResult(producer as never, 0);
		}
		assert.strictEqual(resolveOutputReferences("apply {outputs.plan}", outputs), 'apply {"files":["a.ts","b.ts"]}');
	});

	it("does not thread a failed sequential producer's output (SF-1 parity)", () => {
		const failed = { agent: "worker", exitCode: 1, error: "boom", structuredOutput: { files: ["x"] } };
		const outputs: ChainOutputMap = {};
		if (isStorableStepResult(failed)) {
			outputs.plan = outputEntryFromResult(failed as never, 0);
		}
		assert.strictEqual(resolveOutputReferences("apply {outputs.plan}", outputs), "apply {outputs.plan}");
	});
});