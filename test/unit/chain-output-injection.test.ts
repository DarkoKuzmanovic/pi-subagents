import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOutputReferences } from "../../src/runs/shared/chain-outputs.ts";
import { substituteTemplateVars } from "../../src/shared/utils.ts";
import type { ChainOutputMap } from "../../src/shared/types.ts";

// Invariant shared by all chain paths (foreground sequential/parallel/dynamic and async):
// {outputs.X} is resolved on the AUTHOR template BEFORE {previous}/{task}/{chain_dir} data is
// injected. This prevents a prior step's output text from injecting output references downstream (H6).
function renderStepTask(template: string, outputs: ChainOutputMap, vars: Record<string, string>): string {
	return substituteTemplateVars(resolveOutputReferences(template, outputs), vars);
}

describe("chain output-reference expansion ordering (H6)", () => {
	const outputs: ChainOutputMap = { secret: { text: "LEAKED", agent: "a", stepIndex: 0 } };

	it("does NOT expand {outputs.X} that appears inside {previous} output text", () => {
		const prev = "the model wrote: see {outputs.secret} for details";
		const rendered = renderStepTask("{previous}", outputs, { previous: prev });
		assert.equal(rendered, "the model wrote: see {outputs.secret} for details");
		assert.doesNotMatch(rendered, /LEAKED/);
	});

	it("still expands a legitimate {outputs.X} written in the step's own template", () => {
		const rendered = renderStepTask("use {outputs.secret} then {previous}", outputs, { previous: "PREV" });
		assert.equal(rendered, "use LEAKED then PREV");
	});

	it("leaves unknown/invalid output tokens literal (never throws)", () => {
		const rendered = renderStepTask("{outputs.missing} {outputs.bad-name}", outputs, {});
		assert.equal(rendered, "{outputs.missing} {outputs.bad-name}");
	});
});
