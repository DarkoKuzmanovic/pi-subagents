import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyThinkingSuffix, buildPiArgs, readChildAlwaysExtensions } from "../../src/runs/shared/pi-args.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

interface McpFixture {
	root: string;
	agentDir: string;
	projectDir: string;
}

function createMcpFixture(): McpFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-mcp-"));
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
	return { root, agentDir, projectDir };
}

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpFixture(
	fixture: McpFixture,
	options: {
		serverName?: string;
		definition?: Record<string, unknown>;
		settings?: Record<string, unknown>;
		tools?: Array<{ name: string; description?: string }>;
		resources?: Array<{ name: string; uri: string; description?: string }>;
		configPath?: string;
		cachedAt?: number;
	} = {},
): void {
	const serverName = options.serverName ?? "chrome-devtools";
	const definition = { command: "npx", args: ["chrome-devtools-mcp"], ...(options.definition ?? {}) };
	writeJson(options.configPath ?? path.join(fixture.agentDir, "mcp.json"), {
		...(options.settings ? { settings: options.settings } : {}),
		mcpServers: {
			[serverName]: definition,
		},
	});
	writeJson(path.join(fixture.agentDir, "mcp-cache.json"), {
		version: 1,
		servers: {
			[serverName]: {
				configHash: computeMcpServerHash(definition),
				cachedAt: options.cachedAt ?? Date.now(),
				tools: options.tools ?? [
					{ name: "take_screenshot" },
					{ name: "click" },
				],
				resources: options.resources ?? [],
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
describe("buildPiArgs context-file wiring", () => {
	// Regression: roadmap debt item "README–code drift: --no-context-files for fresh children
	// is documented but unwired". Locks in the CLI-arg side of the fix at the boundary the
	// README documents directly.
	it("pushes --no-context-files when skipContextFiles is set", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			skipContextFiles: true,
		});
		assert.ok(args.includes("--no-context-files"));
	});

	it("omits --no-context-files when skipContextFiles is falsy or unset", () => {
		const { args: withoutFlag } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!withoutFlag.includes("--no-context-files"));

		const { args: explicitFalse } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			skipContextFiles: false,
		});
		assert.ok(!explicitFalse.includes("--no-context-files"));
	});
});

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
		try {
			const sessionFile = path.join(tempDir, "nested", "session.jsonl");
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: true,
				sessionFile,
				sessionDir: "/tmp/should-not-be-used",
				inheritProjectContext: false,
				inheritSkills: false,
			});

			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.ok(fs.existsSync(path.dirname(sessionFile)));
			assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
			assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});
});

describe("buildPiArgs model wiring", () => {
	it("uses --model for provider-qualified model ids", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(!args.includes("--models"));
	});

	it("uses --model for bare model ids too", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "kimi-k2.5",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("kimi-k2.5"));
		assert.ok(!args.includes("--models"));
	});


	it("preserves thinking suffixes on model args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			thinking: "high",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"), "openai-codex/gpt-5.4-mini:high");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
	});
});

describe("buildPiArgs system prompt mode wiring", () => {
	it("uses --append-system-prompt by default", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(!args.includes("--system-prompt"));
	});

	it("uses --system-prompt when systemPromptMode=replace", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
		assert.ok(!args.includes("--append-system-prompt"));
	});

	it("injects the subagent prompt runtime extension and env flags", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
		assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
	});

	it("passes child intercom and orchestrator metadata through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
	});

	it("emits explicit builtin tool allowlists", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(toolsArg, "read,grep,find,ls,bash,edit,write,contact_supervisor");
	});

	it("adds structured_output to a restricted tool allowlist when a schema is active", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "bash"],
			structuredOutput: { schemaPath: "/tmp/x/schema.json", outputPath: "/tmp/x/output.json" },
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(toolsArg, "read,grep,bash,structured_output");
		assert.equal(env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA, "/tmp/x/schema.json");
		assert.equal(env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE, "/tmp/x/output.json");
	});

	it("does not add structured_output to the allowlist without a schema", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "bash"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,grep,bash");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
	});
	it("augments explicit builtin allowlists with selected direct MCP tool names", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,bash,chrome_devtools_take_screenshot,chrome_devtools_click");
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("preserves no --tools for MCP-only agents", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture);

		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			mcpDirectTools: ["chrome-devtools"],
		});

		assert.equal(args.includes("--tools"), false);
		assert.equal(env.MCP_DIRECT_TOOLS, "chrome-devtools");
	});

	it("supports direct MCP server/tool filters", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "github",
			definition: { command: "github-mcp" },
			tools: [{ name: "search_repositories" }, { name: "create_issue" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["github/search_repositories"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,github_search_repositories");
	});

	it("matches adapter prefix modes for direct MCP names", () => {
		for (const [prefix, expected] of [
			["server", "read,linear_mcp_list_issues"],
			["short", "read,linear_list_issues"],
			["none", "read,list_issues"],
		] as const) {
			const fixture = createMcpFixture();
			writeMcpFixture(fixture, {
				serverName: "linear-mcp",
				settings: { toolPrefix: prefix },
				tools: [{ name: "list_issues" }],
			});

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				tools: ["read"],
				mcpDirectTools: ["linear-mcp"],
			});

			assert.equal(args[args.indexOf("--tools") + 1], expected);
		}
	});

	it("includes resource tools and respects excludeTools", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, {
			serverName: "browser-mcp",
			definition: { excludeTools: ["browser_click"] },
			tools: [{ name: "click" }, { name: "navigate" }],
			resources: [{ name: "Console Logs", uri: "resource://console" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["browser-mcp"],
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,browser_mcp_navigate,browser_mcp_get_console_logs");
	});

	it("falls back to explicit builtins when direct MCP cache or config is missing or invalid", () => {
		const missingFixture = createMcpFixture();
		writeJson(path.join(missingFixture.agentDir, "mcp.json"), {
			mcpServers: { "chrome-devtools": { command: "npx", args: ["chrome-devtools-mcp"] } },
		});
		const missingCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(missingCache.args[missingCache.args.indexOf("--tools") + 1], "read,bash");

		const invalidFixture = createMcpFixture();
		writeMcpFixture(invalidFixture, { cachedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
		const staleCache = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "bash"],
			mcpDirectTools: ["chrome-devtools"],
		});
		assert.equal(staleCache.args[staleCache.args.indexOf("--tools") + 1], "read,bash");
	});

	it("resolves project MCP config from the child cwd and expands PI_CODING_AGENT_DIR", () => {
		const fixture = createMcpFixture();
		process.env.PI_CODING_AGENT_DIR = "~/.pi/agent";
		process.chdir(fixture.root);
		writeMcpFixture(fixture, {
			serverName: "project-mcp",
			configPath: path.join(fixture.projectDir, ".mcp.json"),
			tools: [{ name: "inspect" }],
		});

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			mcpDirectTools: ["project-mcp"],
			cwd: fixture.projectDir,
		});

		assert.equal(args[args.indexOf("--tools") + 1], "read,project_mcp_inspect");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const fixture = createMcpFixture();
		writeMcpFixture(fixture, { tools: [{ name: "take_screenshot" }] });

		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
			mcpDirectTools: ["chrome-devtools"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,chrome_devtools_take_screenshot");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});
});

describe("buildPiArgs safety-extension merge (childAlwaysExtensions)", () => {
	it("includes childAlwaysExtensions in extension list when input.extensions is defined", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-safety-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard extension", "utf-8");

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				extensions: [],
				childAlwaysExtensions: [guardPath],
			});

			assert.ok(args.includes("--no-extensions"), "should emit --no-extensions");
			const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(guardPath), "should include guard extension");
			assert.ok(
				extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))),
				"should include runtime extension",
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("filters out nonexistent childAlwaysExtensions paths", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-safety-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard extension", "utf-8");
			const nonexistentPath = path.join(tempDir, "nonexistent.ts");

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				extensions: [],
				childAlwaysExtensions: [guardPath, nonexistentPath],
			});

			const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
			assert.ok(extensionArgs.includes(guardPath), "should include existing guard extension");
			assert.ok(!extensionArgs.includes(nonexistentPath), "should NOT include nonexistent extension");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does NOT consult childAlwaysExtensions when input.extensions is undefined (discovery mode)", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-safety-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard extension", "utf-8");

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				// extensions is undefined (not provided)
				childAlwaysExtensions: [guardPath],
			});

			assert.ok(!args.includes("--no-extensions"), "should NOT emit --no-extensions in discovery mode");
			const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
			assert.ok(
				!extensionArgs.includes(guardPath),
				"should NOT include always-extension in discovery mode even if provided",
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("dedupes extensions correctly when merging always-set with input.extensions", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-safety-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			const customExtPath = path.join(tempDir, "custom.ts");
			fs.writeFileSync(guardPath, "// guard", "utf-8");
			fs.writeFileSync(customExtPath, "// custom", "utf-8");

			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritSkills: false,
				extensions: [customExtPath, guardPath], // includes guardPath
				childAlwaysExtensions: [guardPath], // also includes guardPath
			});

			const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
			// Count occurrences of guardPath
			const guardOccurrences = extensionArgs.filter((arg) => arg === guardPath).length;
			assert.equal(guardOccurrences, 1, "guard extension should appear only once (deduplicated)");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("readChildAlwaysExtensions", () => {
	it("reads childAlwaysExtensions from settings file", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-read-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard", "utf-8");

			const settingsPath = path.join(tempDir, "settings.json");
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [guardPath],
					},
				}),
				"utf-8",
			);

			const result = readChildAlwaysExtensions(settingsPath);
			assert.deepEqual(result, [guardPath], "should read extensions from settings");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("filters out nonexistent paths when reading from settings", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-read-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard", "utf-8");
			const nonexistentPath = path.join(tempDir, "nonexistent.ts");

			const settingsPath = path.join(tempDir, "settings.json");
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [guardPath, nonexistentPath],
					},
				}),
				"utf-8",
			);

			const result = readChildAlwaysExtensions(settingsPath);
			assert.deepEqual(result, [guardPath], "should filter out nonexistent paths");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when settings file does not exist", () => {
		const nonexistentSettings = "/tmp/nonexistent-settings-" + Math.random() + ".json";
		const result = readChildAlwaysExtensions(nonexistentSettings);
		assert.deepEqual(result, [], "should return empty array for missing settings file");
	});

	it("returns empty array when settings file has malformed JSON", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-read-"));
		try {
			const settingsPath = path.join(tempDir, "settings.json");
			fs.writeFileSync(settingsPath, "{ invalid json }", "utf-8");

			const result = readChildAlwaysExtensions(settingsPath);
			assert.deepEqual(result, [], "should return empty array for malformed JSON");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns empty array when childAlwaysExtensions is not an array", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-read-"));
		try {
			const settingsPath = path.join(tempDir, "settings.json");
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: "not-an-array",
					},
				}),
				"utf-8",
			);

			const result = readChildAlwaysExtensions(settingsPath);
			assert.deepEqual(result, [], "should return empty array when value is not an array");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("filters out non-string entries from childAlwaysExtensions", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-read-"));
		try {
			const guardPath = path.join(tempDir, "guard.ts");
			fs.writeFileSync(guardPath, "// guard", "utf-8");

			const settingsPath = path.join(tempDir, "settings.json");
			fs.writeFileSync(
				settingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [guardPath, 123, null, { path: "obj" }, "not-exist.ts"],
					},
				}),
				"utf-8",
			);

			const result = readChildAlwaysExtensions(settingsPath);
			assert.deepEqual(result, [guardPath], "should only include string entries that exist on disk");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses default settings path when settingsPath is not provided", () => {
		// Reads the REAL ~/.pi/agent/settings.json on this machine. Every code
		// path returns an array (existing entries, [] on missing/malformed), so
		// we only assert shape + that it does not throw — never the contents.
		const result = readChildAlwaysExtensions();
		assert.ok(Array.isArray(result), "should return an array");
	});

	it("merges user and project settings when cwd is provided (Fix 3)", () => {
		// Fix 3: When both user and project settings are provided, merge them additively
		// (user first, then project), deduplicate, and filter to existing files.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-merge-"));
		try {
			// Create a project structure with .pi directory
			const projectDir = path.join(tempDir, "project");
			const piDir = path.join(projectDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });

			// Create extension files that will be referenced
			const userExt = path.join(tempDir, "user-ext.ts");
			const projectExt = path.join(tempDir, "project-ext.ts");
			fs.writeFileSync(userExt, "// user extension", "utf-8");
			fs.writeFileSync(projectExt, "// project extension", "utf-8");

			// Create user settings
			const userSettingsPath = path.join(tempDir, "user-settings.json");
			fs.writeFileSync(
				userSettingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [userExt],
					},
				}),
				"utf-8",
			);

			// Create project settings
			const projectSettingsPath = path.join(piDir, "settings.json");
			fs.writeFileSync(
				projectSettingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [projectExt],
					},
				}),
				"utf-8",
			);

			// Call with both user settings and project cwd
			const result = readChildAlwaysExtensions(userSettingsPath, projectDir);
			assert.deepEqual(result, [userExt, projectExt], "should include both user and project extensions");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("deduplicates merged extensions (Fix 3)", () => {
		// When user and project settings both reference the same extension, include it only once
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-dedup-"));
		try {
			const projectDir = path.join(tempDir, "project");
			const piDir = path.join(projectDir, ".pi");
			fs.mkdirSync(piDir, { recursive: true });

			// Create a shared extension
			const sharedExt = path.join(tempDir, "shared-ext.ts");
			fs.writeFileSync(sharedExt, "// shared", "utf-8");

			// Both user and project reference the same extension
			const userSettingsPath = path.join(tempDir, "user-settings.json");
			fs.writeFileSync(
				userSettingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [sharedExt],
					},
				}),
				"utf-8",
			);

			const projectSettingsPath = path.join(piDir, "settings.json");
			fs.writeFileSync(
				projectSettingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [sharedExt],
					},
				}),
				"utf-8",
			);

			const result = readChildAlwaysExtensions(userSettingsPath, projectDir);
			assert.deepEqual(result, [sharedExt], "should deduplicate the shared extension");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads only user settings when cwd is not provided (Fix 3)", () => {
		// When cwd is not provided, only read user settings (don't search for project)
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-user-only-"));
		try {
			const userExt = path.join(tempDir, "user-ext.ts");
			fs.writeFileSync(userExt, "// user", "utf-8");

			const userSettingsPath = path.join(tempDir, "user-settings.json");
			fs.writeFileSync(
				userSettingsPath,
				JSON.stringify({
					subagents: {
						childAlwaysExtensions: [userExt],
					},
				}),
				"utf-8",
			);

			// Call with only user settings, no cwd
			const result = readChildAlwaysExtensions(userSettingsPath, undefined);
			assert.deepEqual(result, [userExt], "should read only user settings when cwd is undefined");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
