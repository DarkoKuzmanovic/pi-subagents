import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderChainTemplate } from "../../src/runs/shared/chain-outputs.ts";
import type { ChainOutputMap } from "../../src/shared/types.ts";

// renderChainTemplate is a SINGLE-PASS render: {outputs.X} and {task}/{previous}/{chain_dir}
// are resolved in one left-to-right scan, so a value substituted for one token is never
// re-scanned for another. This closes both injection directions (H6).
describe("chain single-pass template render (H6)", () => {
	const outputs: ChainOutputMap = {
		secret: { text: "LEAKED", agent: "a", stepIndex: 0 },
		echo: { text: "run {task} now", agent: "a", stepIndex: 1 },
	};

	it("does NOT expand {outputs.X} that appears inside a {previous} value", () => {
		const prev = "the model wrote: see {outputs.secret} for details";
		const rendered = renderChainTemplate("{previous}", { previous: prev }, outputs);
		assert.equal(rendered, "the model wrote: see {outputs.secret} for details");
		assert.doesNotMatch(rendered, /LEAKED/);
	});

	it("does NOT expand {previous}/{task}/{chain_dir} that appears inside an output's text", () => {
		// Symmetric direction the reviewer flagged: an output containing a literal {task}
		// must not be expanded with the caller's task when substituted downstream.
		const rendered = renderChainTemplate("{outputs.echo}", { task: "DELETE-EVERYTHING", previous: "P" }, outputs);
		assert.equal(rendered, "run {task} now");
		assert.doesNotMatch(rendered, /DELETE-EVERYTHING/);
	});

	it("still expands legitimate author tokens (both kinds) in one pass", () => {
		const rendered = renderChainTemplate("use {outputs.secret} then {previous}", { previous: "PREV" }, outputs);
		assert.equal(rendered, "use LEAKED then PREV");
	});

	it("leaves unknown/invalid tokens literal and never throws", () => {
		const rendered = renderChainTemplate("{outputs.missing} {outputs.bad-name} {nope}", { previous: "P" }, outputs);
		assert.equal(rendered, "{outputs.missing} {outputs.bad-name} {nope}");
	});

	it("renders malformed templates in linear time (no quadratic backtracking)", () => {
		// Many unterminated '{outputs.' prefixes: the '{'-excluding name class must fail each fast
		// rather than rescan to end-of-string. Generous bound: the fixed regex is ~single-digit ms,
		// the quadratic form took multiple seconds at this size.
		const hostile = "{outputs.".repeat(40000);
		const start = performance.now();
		const rendered = renderChainTemplate(hostile, { previous: "P" }, outputs);
		const elapsedMs = performance.now() - start;
		assert.equal(rendered, hostile);
		assert.ok(elapsedMs < 1000, `render took ${elapsedMs.toFixed(1)}ms, expected < 1000ms`);
	});
});
