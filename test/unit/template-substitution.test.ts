import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { substituteTemplateVars } from "../../src/shared/utils.ts";

describe("substituteTemplateVars", () => {
	it("substitutes all occurrences of each variable", () => {
		const out = substituteTemplateVars("Do {task}. Context: {previous} in {chain_dir}. Repeat: {task}", {
			task: "fix the bug",
			previous: "step one output",
			chain_dir: "/tmp/chain",
		});
		assert.equal(out, "Do fix the bug. Context: step one output in /tmp/chain. Repeat: fix the bug");
	});

	it("treats $-patterns in values as literal text (regression)", () => {
		// String.replace with a string replacement interprets $&, $', $`, $$.
		// Previous-step output is arbitrary model text and regularly contains
		// $ constructs (shell, awk, regex docs) — these must survive verbatim.
		const value = "use `$&` and $' carefully; awk '{print $$1}'";
		const out = substituteTemplateVars("Based on {previous}, continue.", { previous: value });
		assert.equal(out, `Based on ${value}, continue.`);
	});

	it("leaves unknown placeholders untouched", () => {
		const out = substituteTemplateVars("keep {unknown} and fill {task}", { task: "X" });
		assert.equal(out, "keep {unknown} and fill X");
	});

	it("handles values containing the placeholder text without re-substituting", () => {
		const out = substituteTemplateVars("{previous}", { previous: "literal {previous} inside" });
		assert.equal(out, "literal {previous} inside");
	});
});
