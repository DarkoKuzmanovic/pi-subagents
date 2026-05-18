import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../src/agents/skills.ts";

describe("skill preloading", () => {
	it("resolveSkillsWithFallback returns consistent results", () => {
		const { resolved, missing } = resolveSkillsWithFallback(
			["pi-subagents"],
			process.cwd(),
			process.cwd(),
		);
		// Either the skill resolves or it's reported missing — API contract check
		const total = resolved.length + missing.length;
		assert.equal(total, 1, "expected exactly one result for one skill name");
	});

	it("buildSkillInjection produces non-empty content for resolved skills", () => {
		const { resolved } = resolveSkillsWithFallback(["pi-subagents"], process.cwd(), process.cwd());
		if (resolved.length === 0) return;
		const injection = buildSkillInjection(resolved);
		assert.ok(injection.length > 0, "expected non-empty skill injection content");
		assert.ok(injection.includes("pi-subagents"), "injection should reference the skill name");
		assert.ok(injection.includes("<skill"), "injection should use skill XML tags");
	});

	it("reports missing skills correctly", () => {
		const { resolved, missing } = resolveSkillsWithFallback(
			["nonexistent-skill-xyz"],
			process.cwd(),
			process.cwd(),
		);
		assert.equal(resolved.length, 0, "expected no resolved skills for nonexistent name");
		assert.ok(missing.includes("nonexistent-skill-xyz"), "should report the missing skill");
	});

	it("buildSkillInjection returns empty string for empty array", () => {
		assert.equal(buildSkillInjection([]), "");
	});
});
