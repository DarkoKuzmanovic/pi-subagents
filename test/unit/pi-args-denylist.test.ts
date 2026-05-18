import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

describe("buildPiArgs disallowedTools", () => {
	it("removes disallowed built-in tools from the tools list", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			disallowedTools: ["bash", "write", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,grep,find,ls");
	});

	it("omits --tools when all tools are disallowed", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			disallowedTools: ["read", "bash"],
		});
		assert.ok(!args.includes("--tools"), "expected no --tools flag when all tools are disallowed");
	});

	it("does nothing when disallowedTools is undefined", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash,edit");
	});

	it("does nothing when disallowedTools is empty", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			disallowedTools: [],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash");
	});

	it("ignores disallowedTools entries that don't match any tool", () => {
		const { args } = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "test task",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			disallowedTools: ["write", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash");
	});
});
