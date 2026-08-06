/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import { createNestedRoute } from "../../src/runs/shared/nested-events.ts";
import { ASYNC_RESUME_TRUST_DIRECTORY, ASYNC_RESUME_TRUST_FILENAME } from "../../src/runs/background/async-resume-trust.ts";

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string };
}

interface AsyncResultPayload {
	success: boolean;
	sessionId?: string;
	mode?: string;
	summary?: string;
	budget?: { limit: number; spentOutput: number; exhausted: boolean; overshootOutput?: number };
	budgetExhausted?: boolean;
	results: Array<{ output?: string; success?: boolean; skipped?: boolean; error?: string; exitCode?: number; model?: string; attemptedModels?: string[]; modelAttempts?: Array<{ success?: boolean; error?: string }> }>;
}

interface AsyncStatusPayload {
	sessionId?: string;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	steps?: Array<{
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		status?: string;
		exitCode?: number;
		error?: string;
	}>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

interface TypesModule {
	ASYNC_DIR: string;
	CHAIN_RUNS_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(asyncMod && utils && typesMod);

const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const readStatus = utils?.readStatus;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const CHAIN_RUNS_DIR = typesMod?.CHAIN_RUNS_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}


function writeProjectLaneSettings(cwd: string, value: unknown): void {
	const settingsPath = path.join(cwd, ".pi", "settings.json");
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2), "utf-8");
}

async function waitForAsyncResultFile(id: string, timeoutMs = 15_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

function thinkingFloodEvent(): unknown {
	return {
		type: "message_update",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "x".repeat(65_000) }],
		},
	};
}

async function interruptAsyncRunner(id: string): Promise<void> {
	const statusPath = path.join(ASYNC_DIR, id, "status.json");
	const deadline = Date.now() + 15_000;
	while (true) {
		if (fs.existsSync(statusPath)) {
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
				state?: unknown;
				pid?: unknown;
				steps?: Array<{ status?: unknown }>;
			};
			if (status.state === "running" && typeof status.pid === "number" && status.steps?.some((step) => step.status === "running")) {
				process.kill(status.pid, process.platform === "win32" ? "SIGBREAK" : "SIGUSR2");
				return;
			}
		}
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async runner to start: ${statusPath}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function readRunEventTypes(id: string): string[] {
	const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
	return fs.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { type?: unknown }).type)
		.filter((type): type is string => typeof type === "string");
}

function readStepTerminalEventTypes(id: string, stepIndex: number): string[] {
	const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
	return fs.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: unknown; stepIndex?: unknown })
		.filter((event) => event.stepIndex === stepIndex && (event.type === "subagent.step.completed" || event.type === "subagent.step.failed"))
		.map((event) => event.type as string);
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("fails durably when the detached output log emits an asynchronous error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-output-stream-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		fs.mkdirSync(path.join(asyncDir, "output-0.log"), { recursive: true });
		mockPi.onCall({ output: "child would otherwise succeed", delay: 100 });
		try {
			const launch = executeAsyncSingle(id, {
				agent: "worker",
				task: "Exercise output log failure",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: tempDir,
				artifactsDir: tempDir,
				artifactConfig: { enabled: false },
				shareEnabled: false,
			});
			assert.equal(launch.isError, undefined);
			await waitForAsyncResultFile(id);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.match(payload.results[0]?.error ?? "", /Failed to write async output log/);
			assert.doesNotMatch(payload.results[0]?.error ?? "", /runner crashed/i);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
			assert.equal(status.state, "failed");
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(resultPath, { force: true });
		}
	});


	it("persists the launch-time async session directory for safe resume", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-resume-trust-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "ephemeral-session-root");
		mockPi.onCall({ output: "resume trust recorded" });
		try {
			const launch = executeAsyncSingle(id, {
				agent: "worker",
				task: "Persist resume trust",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false },
				shareEnabled: false,
				sessionRoot,
				maxSubagentDepth: 2,
			});
			assert.equal(launch.isError, undefined, launch.content[0]?.text);
			await waitForAsyncResultFile(id);
			const trustPath = path.join(asyncDir, ASYNC_RESUME_TRUST_DIRECTORY, ASYNC_RESUME_TRUST_FILENAME);
			const trust = JSON.parse(fs.readFileSync(trustPath, "utf-8")) as { trustedSessionRoots?: unknown };
			assert.deepEqual(trust.trustedSessionRoots, [path.join(sessionRoot, `async-${id}`)]);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(resultPath, { force: true });
		}
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const commonParams = {
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		mockPi.onCall({ output: "single done" });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /end your turn now/);
		await waitForAsyncResultFile(singleId, 10_000);

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /Pi will deliver the completion/);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 10_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do chained work" }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		await waitForAsyncResultFile(chainId, 10_000);
	});

	it("routes a real NestedRoute through the async launch boundary to child env and extensions without intercom setup", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const route = createNestedRoute(`bg-reach-${Date.now().toString(36)}`);
		try {
			mockPi.onCall({
				echoEnv: [
					"PI_SUBAGENT_PARENT_ROOT_RUN_ID",
					"PI_SUBAGENT_PARENT_EVENT_SINK",
					"PI_SUBAGENT_PARENT_CONTROL_INBOX",
					"PI_SUBAGENT_PARENT_CAPABILITY_TOKEN",
					"PI_SUBAGENT_CHILD_AGENT",
					"PI_SUBAGENT_CHILD_INDEX",
				],
			});
			const id = `async-reachability-${Date.now().toString(36)}`;
			const sessionRoot = path.join(tempDir, "sessions");

			// Real launch/argument-building boundary: executeAsyncSingle -> subagent-runner -> buildPiArgs
			// -> spawned mock pi. No childIntercomTarget/controlIntercomTarget is passed, proving no
			// pi-intercom setup is required.
			executeAsyncSingle!(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot,
				maxSubagentDepth: 2,
				nestedRoute: route,
			});

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);
			assert.deepEqual(JSON.parse(payload.results[0]?.output ?? "{}"), {
				PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId,
				PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
				PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
				PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_SUBAGENT_CHILD_INDEX: "0",
			});

			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded mock pi call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
			assert.ok(extensionArgs.some((arg) => arg.endsWith("src/runs/shared/subagent-prompt-runtime.ts")));
		} finally {
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("async chain stops launching later steps after the output token budget is exhausted", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "First async result" });
		mockPi.onCall({ output: "Second async result should not run" });

		const id = `async-budget-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [
				{ agent: "worker", task: "First async step" },
				{ agent: "reviewer", task: "Second async step" },
			],
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			budget: 50,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(mockPi.callCount(), 1);
		assert.equal(payload.success, true, `run should succeed with skipped step: ${JSON.stringify(payload.results)}`);
		assert.equal(payload.results.length, 2);
		assert.equal(payload.results[0]?.output, "First async result");
		assert.equal(payload.results[1]?.skipped, true);
		assert.equal(payload.results[1]?.error, "budget-exhausted");
		assert.equal(payload.budget?.limit, 50);
		assert.equal(payload.budget?.spentOutput, 50);
		assert.equal(payload.budget?.exhausted, true);
		assert.equal(payload.budgetExhausted, true);
		assert.match(payload.summary ?? "", /\[budget: 50\/50 output tokens, exhausted\]/);
		assert.equal(status.steps?.[1]?.status, "failed");
		assert.equal(status.steps?.[1]?.exitCode, -1);
		assert.equal(status.steps?.[1]?.error, "budget-exhausted");
	});

	it("top-level async parallel conversion preserves output, reads, and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});

		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"], progress: true }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.mode, "parallel");
		assert.equal(payload.sessionId, "session-123");
		assert.equal(status.sessionId, "session-123");
		const outputPath = path.join(tempDir, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.ok(args.includes("--no-context-files"), "fresh async child should skip parent context files");
		const taskArg = args.filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
		assert.ok(CHAIN_RUNS_DIR, "CHAIN_RUNS_DIR should be available");
		const progressPath = path.join(CHAIN_RUNS_DIR, asyncId, "progress.md");
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${progressPath}`));
		assert.ok(taskArg.includes(`Write your findings to: ${outputPath}`));
		assert.equal(fs.existsSync(progressPath), true);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("keeps context files enabled for forked async children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Forked async report" });
		const id = `async-fork-context-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [{ agent: "worker", task: "Do forked async work" }],
			context: "fork",
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id, 10_000);
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.equal(args.includes("--no-context-files"), false);
	});

	it("namespaces inherited default outputs for async chain parallel tasks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		// Keyed to the task text: concurrent children claim the queue first-come, so an
		// unkeyed queue swaps these two responses between parallel-0/0 and parallel-0/1.
		mockPi.onCall({ taskIncludes: "Write one", output: "fallback one", writeOutput: "child one" });
		mockPi.onCall({ taskIncludes: "Write two", output: "fallback two", writeOutput: "child two" });

		const id = `async-chain-parallel-output-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [
				{
					parallel: [
						{ agent: "writer", task: "Write one" },
						{ agent: "writer", task: "Write two" },
					],
				},
			],
			agents: [makeAgent("writer", { output: "context.md" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);

		assert.ok(CHAIN_RUNS_DIR, "CHAIN_RUNS_DIR should be available");
		const chainDir = path.join(CHAIN_RUNS_DIR, id);
		const firstOutput = path.join(chainDir, "parallel-0", "0-writer", "context.md");
		const secondOutput = path.join(chainDir, "parallel-0", "1-writer", "context.md");
		assert.equal(fs.readFileSync(firstOutput, "utf-8"), "child one");
		assert.equal(fs.readFileSync(secondOutput, "utf-8"), "child two");
		assert.equal(fs.existsSync(path.join(tempDir, "parallel-0")), false);
	});

	it("rejects a static async chain namespace symlink as a structured start error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-static-chain-symlink-${Date.now().toString(36)}`;
		const chainBase = path.join(tempDir, "chains");
		const chainDir = path.join(chainBase, id);
		const outsideDir = path.join(tempDir, "outside-chain");
		fs.mkdirSync(chainDir, { recursive: true });
		fs.mkdirSync(outsideDir);
		fs.symlinkSync(outsideDir, path.join(chainDir, "parallel-0"));

		const result = executeAsyncChain!(id, {
			chain: [{ parallel: [{ agent: "writer", task: "Write one" }] }],
			chainDir: chainBase,
			agents: [makeAgent("writer", { output: "context.md" })],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content.map((part) => part.text ?? "").join("\n"), /Relative output path escapes its base directory through a symlink/);
		assert.equal(mockPi.callCount(), 0, "static containment must fail before a child launches");
		assert.equal(fs.existsSync(path.join(outsideDir, "0-writer")), false, "static containment must reject before mkdir follows the symlink");
	});

	it("rejects a pre-existing async worktree root before static namespace creation", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const repoDir = createRepo("pi-subagent-async-worktree-root-symlink-");
		const id = `async-worktree-root-symlink-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		const outsideDir = path.join(tempDir, "outside-worktree-root");
		fs.mkdirSync(outsideDir);
		fs.symlinkSync(outsideDir, expectedWorktreePath);
		try {
			const result = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write in worktree" }], worktree: true }],
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer", { output: "context.md" })],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content.map((part) => part.text ?? "").join("\n"), /async worktree path already exists/i);
			assert.equal(mockPi.callCount(), 0, "worktree containment must fail before a child launches");
			assert.equal(fs.existsSync(path.join(outsideDir, "parallel-0", "0-writer")), false, "worktree setup must not mkdir through the symlink");
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("rejects a tracked async worktree namespace symlink before launching a child", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-namespace-symlink-");
		const id = `async-worktree-namespace-symlink-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		const outsideDir = path.join(tempDir, "outside-worktree-namespace");
		fs.mkdirSync(outsideDir);
		fs.symlinkSync(outsideDir, path.join(repoDir, "parallel-0"));
		git(repoDir, ["add", "parallel-0"]);
		git(repoDir, ["commit", "-m", "add namespace symlink"]);
		mockPi.onCall({ output: "must not launch", writeOutput: "must not escape" });
		try {
			const started = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write in worktree" }], worktree: true }],
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer", { output: "context.md" })],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			assert.notEqual(started.isError, true, started.content.map((part) => part.text ?? "").join("\n"));

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.match(JSON.stringify(payload), /Relative output path escapes its base directory through a symlink/);
			assert.equal(mockPi.callCount(), 0, "runner containment must fail before a worktree child launches");
			assert.equal(fs.existsSync(path.join(outsideDir, "0-writer")), false, "runner containment must reject before mkdir follows the tracked symlink");
			assert.equal(fs.existsSync(expectedWorktreePath), false, "failed worktree setup must remove the generated worktree path");
			assert.equal(
				git(repoDir, ["worktree", "list", "--porcelain"]).includes(expectedWorktreePath),
				false,
				"failed worktree setup must remove its Git worktree registration",
			);
			assert.equal(
				git(repoDir, ["branch", "--list", `pi-parallel-${id}-s0-0`]),
				"",
				"failed worktree setup must delete its generated branch",
			);
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("rejects a tracked top-level async worktree output symlink before launching a child", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-top-output-symlink-");
		const id = `async-worktree-top-output-symlink-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		const outsideFile = path.join(tempDir, `${id}-outside.txt`);
		fs.writeFileSync(outsideFile, "outside sentinel", "utf-8");
		fs.symlinkSync(outsideFile, path.join(repoDir, "report.md"));
		git(repoDir, ["add", "report.md"]);
		git(repoDir, ["commit", "-m", "add top-level output symlink"]);
		mockPi.onCall({ output: "must not launch", writeOutput: "must not escape" });
		try {
			const started = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write top-level worktree output", output: "report.md" }], worktree: true }],
				resultMode: "parallel",
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer")],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			assert.notEqual(started.isError, true, started.content.map((part) => part.text ?? "").join("\n"));

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.match(JSON.stringify(payload), /Relative output path escapes its base directory through a symlink/);
			assert.equal(mockPi.callCount(), 0, "output containment must fail before a top-level worktree child launches");
			assert.equal(fs.readFileSync(outsideFile, "utf-8"), "outside sentinel");
			assert.equal(fs.existsSync(expectedWorktreePath), false, "failed worktree setup must remove the generated worktree path");
			assert.equal(git(repoDir, ["worktree", "list", "--porcelain"]).includes(expectedWorktreePath), false);
			assert.equal(git(repoDir, ["branch", "--list", `pi-parallel-${id}-s0-0`]), "");
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("rejects a tracked static-chain async worktree output symlink before launching a child", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-chain-output-symlink-");
		const id = `async-worktree-chain-output-symlink-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		const outsideFile = path.join(tempDir, `${id}-outside.txt`);
		const outputDir = path.join(repoDir, "parallel-0", "0-writer");
		fs.writeFileSync(outsideFile, "outside sentinel", "utf-8");
		fs.mkdirSync(outputDir, { recursive: true });
		fs.symlinkSync(outsideFile, path.join(outputDir, "context.md"));
		git(repoDir, ["add", "parallel-0"]);
		git(repoDir, ["commit", "-m", "add static chain output symlink"]);
		mockPi.onCall({ output: "must not launch", writeOutput: "must not escape" });
		try {
			const started = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write static chain worktree output" }], worktree: true }],
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer", { output: "context.md" })],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			assert.notEqual(started.isError, true, started.content.map((part) => part.text ?? "").join("\n"));

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, false);
			assert.match(JSON.stringify(payload), /Relative output path escapes its base directory through a symlink/);
			assert.equal(mockPi.callCount(), 0, "output containment must fail before a static-chain worktree child launches");
			assert.equal(fs.readFileSync(outsideFile, "utf-8"), "outside sentinel");
			assert.equal(fs.existsSync(expectedWorktreePath), false, "failed worktree setup must remove the generated worktree path");
			assert.equal(git(repoDir, ["worktree", "list", "--porcelain"]).includes(expectedWorktreePath), false);
			assert.equal(git(repoDir, ["branch", "--list", `pi-parallel-${id}-s0-0`]), "");
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("preserves explicit absolute async worktree output opt-in", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-absolute-output-");
		const id = `async-worktree-absolute-output-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		const absoluteOutput = path.join(tempDir, `${id}-explicit.txt`);
		mockPi.onCall({ output: "absolute output fallback", writeOutput: "explicit absolute output" });
		try {
			const started = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write explicit absolute output", output: absoluteOutput }], worktree: true }],
				resultMode: "parallel",
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer")],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			assert.notEqual(started.isError, true, started.content.map((part) => part.text ?? "").join("\n"));

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true, JSON.stringify(payload));
			assert.equal(mockPi.callCount(), 1);
			assert.equal(fs.readFileSync(absoluteOutput, "utf-8"), "explicit absolute output");
			assert.equal(fs.existsSync(expectedWorktreePath), false);
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("materializes safe static async chain outputs inside a worktree after checkout", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-static-output-");
		const id = `async-worktree-static-output-${Date.now().toString(36)}`;
		const expectedWorktreePath = path.join(os.tmpdir(), `pi-worktree-${id}-s0-0`);
		mockPi.onCall({ output: "fallback worktree output", writeOutput: "worktree child output" });
		try {
			const started = executeAsyncChain!(id, {
				chain: [{ parallel: [{ agent: "writer", task: "Write safe worktree output" }], worktree: true }],
				chainDir: path.join(tempDir, "chains"),
				agents: [makeAgent("writer", { output: "context.md" })],
				ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});
			assert.notEqual(started.isError, true, started.content.map((part) => part.text ?? "").join("\n"));

			const resultPath = await waitForAsyncResultFile(id, 10_000);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, true, JSON.stringify(payload));
			assert.equal(mockPi.callCount(), 1);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded worktree child call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const taskArg = args.filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
			assert.ok(taskArg.includes(`Write your findings to: ${path.join(expectedWorktreePath, "parallel-0", "0-writer", "context.md")}`));
		} finally {
			fs.rmSync(expectedWorktreePath, { recursive: true, force: true });
			removeTempDir(repoDir);
		}
	});

	it("keeps a missing declared output diagnostic nonfatal for async named bindings", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async producer text" });
		mockPi.onCall({ output: "consumer done" });
		const id = `async-missing-output-${Date.now().toString(36)}`;
		assert.ok(CHAIN_RUNS_DIR, "CHAIN_RUNS_DIR should be available");
		const chainDir = path.join(CHAIN_RUNS_DIR, id);
		fs.mkdirSync(chainDir, { recursive: true });
		fs.writeFileSync(path.join(chainDir, "blocked"), "not a directory", "utf-8");

		executeAsyncChain!(id, {
			chain: [
				{ agent: "producer", task: "Produce text", output: "blocked/out.md", as: "producer" },
				{ agent: "consumer", task: "Consume {outputs.producer}" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);
		const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const consumerCall = callFiles[1];
		assert.ok(consumerCall, "expected consumer call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, consumerCall), "utf-8")).args as string[];
		const task = args.filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
		assert.match(task, /Consume async producer text/);
	});

	it("does not re-expand {previous} injected by named output in an async sequential step", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "literal {previous}" });
		mockPi.onCall({ output: "consumer done" });
		const id = `async-chain-template-sequential-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [
				{ agent: "producer", task: "Produce literal output", as: "producer" },
				{ agent: "consumer", task: "Consume {outputs.producer}" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id, 10_000);
		const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const consumerCall = callFiles[1];
		assert.ok(consumerCall, "expected consumer call");
		const task = (JSON.parse(fs.readFileSync(path.join(mockPi.dir, consumerCall), "utf-8")).args as string[]).filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
		assert.match(task, /Consume literal \{previous\}/);
		assert.doesNotMatch(task, /literal literal \{previous\}/);
	});

	it("does not re-expand {previous} injected by named output in an async parallel step", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "literal {previous}" });
		mockPi.onCall({ output: "consumer done" });
		const id = `async-chain-template-parallel-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [
				{ agent: "producer", task: "Produce literal output", as: "producer" },
				{ parallel: [{ agent: "consumer", task: "Consume {outputs.producer}" }] },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await waitForAsyncResultFile(id, 10_000);
		const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const consumerCall = callFiles[1];
		assert.ok(consumerCall, "expected consumer call");
		const task = (JSON.parse(fs.readFileSync(path.join(mockPi.dir, consumerCall), "utf-8")).args as string[]).filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
		assert.match(task, /Consume literal \{previous\}/);
		assert.doesNotMatch(task, /literal literal \{previous\}/);
	});

	it("top-level async parallel lane keeps inline model while applying lane thinking", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async lane report" });
		writeProjectLaneSettings(tempDir, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
					},
				},
			},
		});
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { model: "agent/default" })] }),
		});

		const result = await executor.execute(
			"async-parallel-lane-precedence",
			{
				tasks: [{ agent: "worker", task: "Do async work", lane: "easy", model: "override/model" }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		await waitForAsyncResultFile(asyncId, 10_000);
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		const modelIndex = args.indexOf("--model");
		assert.notEqual(modelIndex, -1, "expected --model arg");
		assert.equal(args[modelIndex + 1], "override/model:high");
	});

	it("top-level async chain suppresses progress for {task} review-only tasks", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-chain-read-only-progress",
			{
				chain: [{ agent: "reviewer" }],
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.filter((arg) => arg !== "--no-context-files").at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("top-level async worktree parallel resolves reads and output against the worktree cwd", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-");
		try {
			const unrelatedNamespaceTarget = path.join(tempDir, "unrelated-top-level-worktree-namespace");
			fs.mkdirSync(unrelatedNamespaceTarget);
			fs.symlinkSync(unrelatedNamespaceTarget, path.join(repoDir, "parallel-0"));
			git(repoDir, ["add", "parallel-0"]);
			git(repoDir, ["commit", "-m", "add unrelated namespace symlink"]);
			mockPi.onCall({ output: "Worktree report" });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"async-parallel-worktree-fields",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "report.md", reads: ["input.md"] }],
					async: true,
					clarify: false,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			const asyncId = result.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");
			const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			const asyncDir = result.details?.asyncDir;
			const deadline = Date.now() + 30_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					const statusPath = asyncDir ? path.join(asyncDir, "status.json") : undefined;
					const eventsPath = asyncDir ? path.join(asyncDir, "events.jsonl") : undefined;
					const status = statusPath && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf-8") : "(missing status.json)";
					const events = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "(missing events.jsonl)";
					assert.fail(`Timed out waiting for async result file: ${resultPath}\nStatus: ${status}\nEvents: ${events}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const worktreeCwd = path.join(os.tmpdir(), `pi-worktree-${asyncId}-s0-0`);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded mock pi call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const taskArg = args.filter((arg) => arg !== "--no-context-files").at(-1) ?? "";
			assert.ok(taskArg.includes(`[Read from: ${path.join(worktreeCwd, "input.md")}]`));
			assert.ok(taskArg.includes(`Write your findings to: ${path.join(worktreeCwd, "report.md")}`));
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.ok(statusPayload.totalTokens.total > 0);
		assert.ok(statusPayload.steps[0].tokens.total > 0);
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries a runaway MiniMax background attempt on the configured fallback", { skip: !isAsyncAvailable() ? "jiti not available" : undefined, timeout: 120_000 }, async () => {
		const flood = Array.from({ length: 500 }, () => thinkingFloodEvent());
		mockPi.onCall({ jsonl: flood, keepAliveAfterFinalMessageMs: 60_000, exitCode: 0 });
		mockPi.onCall({ output: "Recovered asynchronously from runaway" });
		const id = `async-runaway-fallback-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "minimax/MiniMax-M3",
				thinking: "high",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "minimax", id: "MiniMax-M3", fullId: "minimax/MiniMax-M3" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		const result = payload.results[0];
		assert.equal(payload.success, true);
		assert.equal(result?.model, "anthropic/claude-sonnet-4:high");
		assert.deepEqual(result?.attemptedModels, ["minimax/MiniMax-M3", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(result?.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.match(result?.modelAttempts?.[0]?.error ?? "", /runaway output aborted/);
		assert.match(result?.output ?? "", /Recovered asynchronously from runaway/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("preserves paused state and suppresses terminal step completion after an async sequential interrupt", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 10_000 });
		const id = `async-interrupt-sequential-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [{ agent: "worker", task: "Wait" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await interruptAsyncRunner(id);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.mode, "chain");
		assert.doesNotMatch(readRunEventTypes(id).join("\n"), /subagent\.step\.completed/);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "paused");
		assert.equal(status.steps?.[0]?.status, "paused");
	});

	it("preserves paused state and suppresses terminal step completion after an async parallel interrupt", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 10_000 });
		mockPi.onCall({ delay: 10_000 });
		const id = `async-interrupt-parallel-${Date.now().toString(36)}`;
		executeAsyncChain!(id, {
			chain: [{ parallel: [{ agent: "worker-a", task: "Wait A" }, { agent: "worker-b", task: "Wait B" }] }],
			agents: [makeAgent("worker-a"), makeAgent("worker-b")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		await interruptAsyncRunner(id);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.mode, "chain");
		assert.doesNotMatch(readRunEventTypes(id).join("\n"), /subagent\.step\.completed/);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "paused");
		assert.ok(status.steps?.every((step) => step.status === "paused"));
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("background single runs report unavailable pi-subagents skill requests", () => {
		const id = `async-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-subagents"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains report unavailable pi-subagents skill requests", () => {
		const id = `async-chain-pi-subagents-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-subagents"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-subagents/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		const doneDeadline = Date.now() + 10_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const originalExecPath = process.execPath;
		process.execPath = path.join(tempDir, "missing-node");
		try {
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /async runner did not produce a pid/);
		} finally {
			process.execPath = originalExecPath;
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 500, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let eventText = "";
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
				if (eventText.includes('"type":"active_long_running"')) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.activityState, "active_long_running");
		assert.equal(status.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 500, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async", "intercom"],
			},
		});

		const deadline = Date.now() + 10_000;
		let eventText = "";
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
				if (eventText.includes('"reason":"tool_failures"')) break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.activityState, "needs_attention");
		assert.equal(status.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});

	it("fails a background chain when a parallel item is killed by step inactivity", { skip: !isAsyncAvailable() ? "jiti not available" : undefined, timeout: 20_000 }, async () => {
		mockPi.onCall({ delay: 20_000, output: "Timed-out output must not bind" });
		mockPi.onCall({ output: "Downstream step must not run" });

		const id = `async-parallel-step-inactivity-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncChain(id, {
			chain: [
				{
					parallel: [{ agent: "slow", task: "Become inactive", as: "timed_output" }],
					concurrency: 1,
				},
				{ agent: "slow", task: "Consume {outputs.timed_output}" },
			],
			agents: [makeAgent("slow")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				...DEFAULT_CONTROL_CONFIG,
				timeoutAction: "escalate_then_kill",
				stepInactivityTimeoutMs: 100,
				escalationGraceMs: 100,
				runWallClockTimeoutMs: 30_000,
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 12_000);
		assert.equal(mockPi.callCount(), 1, "a timed-out parallel item must stop the chain before output binding is consumed");

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results.length, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /step inactivity timeout/);

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");
		assert.equal(status.steps?.[0]?.status, "failed");
		assert.equal(status.steps?.[0]?.activityState, "timed_out");
		assert.equal(status.steps?.[0]?.exitCode, 1);
		assert.deepEqual(readStepTerminalEventTypes(id, 0), ["subagent.step.failed"]);
		assert.ok(!readRunEventTypes(id).includes("subagent.step.completed"), "timed-out parallel item must not emit subagent.step.completed");
	});

	it("stops dispatching a background chain synchronously once the shared run wall-clock deadline fires", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 600, output: "Too late" });

		const id = `async-chain-wall-clock-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);

		executeAsyncChain(id, {
			chain: [
				{ agent: "slow", task: "First slow task" },
				{ agent: "slow", task: "Second slow task (must never spawn)" },
			],
			agents: [makeAgent("slow")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				...DEFAULT_CONTROL_CONFIG,
				runWallClockTimeoutMs: 300,
				stepInactivityTimeoutMs: 999_999,
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 12_000);
		assert.equal(mockPi.callCount(), 1, "second chain step must not spawn after the shared run deadline");

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results.length, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? payload.results[0]?.output ?? "", /wall-clock limit/);

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");

		assert.deepEqual(readStepTerminalEventTypes(id, 0), ["subagent.step.failed"]);
		assert.ok(!readRunEventTypes(id).includes("subagent.step.completed"), "timed-out child must not emit subagent.step.completed");
	});

	it("warns one grace window before the run wall-clock deadline so a live child can wrap up", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		// The child outlives the whole window, so the only way out is the deadline kill.
		mockPi.onCall({ delay: 20_000, output: "Never finishes" });

		const id = `async-wall-clock-nudge-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);

		executeAsyncChain(id, {
			chain: [{ agent: "slow", task: "Long task that should be warned before it is killed" }],
			agents: [makeAgent("slow")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				...DEFAULT_CONTROL_CONFIG,
				// The activity timer polls once a second, so the nudge window (3s..6s) has to be
				// wide enough for a tick to land inside it before the deadline fires.
				runWallClockTimeoutMs: 6_000,
				escalationGraceMs: 3_000,
				stepInactivityTimeoutMs: 999_999,
				activeNoticeAfterMs: 999_999,
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 30_000);

		const controlEvents = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; event?: { type?: string; reason?: string; message?: string; elapsedMs?: number } })
			.filter((entry) => entry.type === "subagent.control");

		const nudge = controlEvents.find((entry) => entry.event?.type === "timed_out_escalating");
		assert.ok(nudge, "expected a pre-deadline wrap-up nudge before the run was killed");
		assert.equal(nudge?.event?.reason, "run_wall_clock_timeout");
		assert.match(nudge?.event?.message ?? "", /wrap up now/);
		// The whole point: the warning lands while the run is still under its deadline.
		assert.ok((nudge?.event?.elapsedMs ?? Number.MAX_SAFE_INTEGER) < 6_000, `nudge must precede the deadline, got elapsedMs=${nudge?.event?.elapsedMs}`);

		// ...and the deadline still kills the run afterwards.
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? payload.results[0]?.output ?? "", /wall-clock limit/);

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");
	});

	it("stops dispatching queued background parallel tasks synchronously once the shared run wall-clock deadline fires", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 600, output: "Too late" });

		const id = `async-parallel-wall-clock-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);

		executeAsyncChain(id, {
			chain: [{
				parallel: [
					{ agent: "slow", task: "First slow task" },
					{ agent: "slow", task: "Queued slow task" },
					{ agent: "slow", task: "Never-started slow task" },
				],
				concurrency: 1,
			}],
			agents: [makeAgent("slow")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				...DEFAULT_CONTROL_CONFIG,
				runWallClockTimeoutMs: 300,
				stepInactivityTimeoutMs: 999_999,
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 12_000);
		assert.equal(mockPi.callCount(), 1, "queued parallel tasks must not spawn after the shared run deadline");

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results.length, 3);
		assert.equal(payload.results.every((child) => child.success === false), true);
		for (const child of payload.results) {
			assert.match(child.error ?? child.output ?? "", /wall-clock limit/);
		}

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");

		assert.deepEqual(readStepTerminalEventTypes(id, 0), ["subagent.step.failed"]);
		assert.ok(!readRunEventTypes(id).includes("subagent.step.completed"), "timed-out children must not emit subagent.step.completed");
	});

	it("does not launch a background fallback model after the shared run wall-clock deadline", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			delay: 600,
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed after the deadline" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Fallback must never start" });

		const id = `async-fallback-wall-clock-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				...DEFAULT_CONTROL_CONFIG,
				runWallClockTimeoutMs: 300,
				stepInactivityTimeoutMs: 999_999,
			},
		});

		const resultPath = await waitForAsyncResultFile(id, 12_000);
		assert.equal(mockPi.callCount(), 1, "fallback model must not spawn after the shared run deadline");

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results.length, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? payload.results[0]?.output ?? "", /wall-clock limit/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /Retrying with/);

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.state, "failed");
		assert.deepEqual(readStepTerminalEventTypes(id, 0), ["subagent.step.failed"]);
	});
});
