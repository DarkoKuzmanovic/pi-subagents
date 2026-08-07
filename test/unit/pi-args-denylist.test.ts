import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildPiArgs, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function createMcpFixture(): void {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-denylist-mcp-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".pi", "agent");
	const projectDir = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(projectDir);

	const definition = { command: "npx", args: ["chrome-devtools-mcp"] };
	writeJson(path.join(agentDir, "mcp.json"), {
		mcpServers: { "chrome-devtools": definition },
	});
	writeJson(path.join(agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			"chrome-devtools": {
				configHash: computeMcpServerHash(definition),
				cachedAt: Date.now(),
				tools: [{ name: "take_screenshot" }],
			},
		},
	});
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const baseInput = {
	baseArgs: ["--mode", "json", "-p"],
	task: "test task",
	sessionEnabled: false,
	inheritProjectContext: false,
	inheritSkills: false,
} as const;

describe("buildPiArgs disallowedTools", () => {
	it("removes disallowed built-in tools from the tools list", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
			disallowedTools: ["bash", "write", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,grep,find,ls");
	});

	// Regression (GPTPRO P0.1): omitting the flag entirely handed the child Pi's
	// DEFAULT toolset — an explicitly empty effective allowlist must fail closed.
	it("emits --no-builtin-tools when all tools are disallowed", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash"],
			disallowedTools: ["read", "bash"],
		});
		assert.ok(!args.includes("--tools"), "expected no --tools flag when all tools are disallowed");
		assert.ok(args.includes("--no-builtin-tools"), "expected --no-builtin-tools so the child cannot fall back to default tools");
	});

	it("keeps structured_output available when all built-ins are disallowed", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash"],
			disallowedTools: ["read", "bash"],
			structuredOutput: { schemaPath: "/tmp/schema.json", outputPath: "/tmp/output.json" },
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag carrying structured_output");
		assert.equal(args[toolsIdx + 1], "structured_output");
		assert.ok(!args.includes("--no-builtin-tools"));
	});

	it("keeps MCP direct tools available when all built-ins are disallowed", () => {
		createMcpFixture();
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash"],
			disallowedTools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag carrying resolved MCP direct tools");
		assert.equal(args[toolsIdx + 1], "chrome_devtools_take_screenshot");
		assert.ok(!args.includes("--no-builtin-tools"));
	});

	// Regression (GPTPRO P0.1): fanoutAuthorized was derived from the PRE-denylist
	// tool list, so a child with `subagent` denied still loaded the fanout runtime.
	it("revokes fanout authorization when subagent is disallowed", () => {
		const { args, env } = buildPiArgs({
			...baseInput,
			tools: ["read", "subagent"],
			disallowedTools: ["subagent"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		const extensions = args.filter((_, i) => args[i - 1] === "--extension");
		assert.ok(
			extensions.every((ext) => !ext.includes("fanout-child")),
			`fanout child extension must not load when subagent is denied, got: ${extensions.join(", ")}`,
		);
	});

	it("grants fanout authorization when subagent survives the denylist", () => {
		const { args, env } = buildPiArgs({
			...baseInput,
			tools: ["read", "subagent"],
			disallowedTools: ["bash"],
		});
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		const extensions = args.filter((_, i) => args[i - 1] === "--extension");
		assert.ok(
			extensions.some((ext) => ext.includes("fanout-child")),
			"fanout child extension should load when subagent is authorized",
		);
	});

	it("treats explicitly empty tools as disable, undefined tools as default discovery", () => {
		const { args: explicitlyEmpty } = buildPiArgs({
			...baseInput,
			tools: [],
		});
		assert.ok(explicitlyEmpty.includes("--no-builtin-tools"), "explicit tools: [] must disable built-in tools");
		assert.ok(!explicitlyEmpty.includes("--tools"));

		const { args: undefinedTools } = buildPiArgs({
			...baseInput,
		});
		assert.ok(!undefinedTools.includes("--no-builtin-tools"), "undefined tools must keep Pi's default discovery");
		assert.ok(!undefinedTools.includes("--tools"));
	});

	it("does nothing when disallowedTools is undefined", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash,edit");
	});

	it("does nothing when disallowedTools is empty", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash"],
			disallowedTools: [],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash");
	});

	it("ignores disallowedTools entries that don't match any tool", () => {
		const { args } = buildPiArgs({
			...baseInput,
			tools: ["read", "bash"],
			disallowedTools: ["write", "edit"],
		});
		const toolsIdx = args.findIndex((a) => a === "--tools");
		assert.ok(toolsIdx !== -1, "expected --tools flag");
		assert.equal(args[toolsIdx + 1], "read,bash");
	});
});
