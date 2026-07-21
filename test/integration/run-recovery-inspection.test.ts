import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNestedRoute,
	publishLiveControlOwnerEpoch,
	writeNestedEvent,
	type NestedRoute,
} from "../../src/runs/shared/nested-events.ts";
import {
	deleteRunHandle,
	recordRunHandle,
	recoverRunHandle,
} from "../../src/runs/shared/run-handle-store.ts";
import { deleteAttachment } from "../../src/runs/shared/run-attachment-store.ts";
import {
	ASYNC_DIR,
	RESULTS_DIR,
	type AsyncJobState,
	type Details,
	type ForegroundControl,
} from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, tryImport } from "../support/helpers.ts";

interface ExecutorResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details?: Details;
}

interface ExecutorModule {
	createSubagentExecutor?: (deps: unknown) => {
		execute: (
			id: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: ((result: unknown) => void) | undefined,
			ctx: unknown,
		) => Promise<ExecutorResult>;
	};
}

interface AsyncJobTrackerModule {
	createAsyncJobTracker: (
		pi: { events: { emit(channel: string, data: unknown): void } },
		state: Record<string, unknown>,
		asyncDirRoot: string,
		options?: { completionRetentionMs?: number; pollIntervalMs?: number },
	) => {
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
	};
}

const executorModule = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const trackerModule = await tryImport<AsyncJobTrackerModule>("./src/runs/background/async-job-tracker.ts");
const createSubagentExecutor = executorModule?.createSubagentExecutor;
const routeRoots: string[] = [];
const asyncDirs: string[] = [];
const resultFiles: string[] = [];
const handleIds: string[] = [];
const attachmentIds: string[] = [];
const tempRoots: string[] = [];

function uniqueId(prefix: string): string {
	return `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

function trackRoute(rootRunId: string): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	return route;
}

function trackAsyncDir(id: string): string {
	const asyncDir = path.join(ASYNC_DIR, id);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	asyncDirs.push(asyncDir);
	return asyncDir;
}

function trackResult(id: string, value: Record<string, unknown>): string {
	fs.mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	fs.writeFileSync(resultPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	resultFiles.push(resultPath);
	return resultPath;
}

function trackHandle(input: Parameters<typeof recordRunHandle>[0]): void {
	handleIds.push(input.id);
	recordRunHandle(input);
}

function nestedChild(id: string, parentRunId: string, state: "running" | "complete" = "running") {
	return {
		id,
		parentRunId,
		depth: 1,
		path: [{ runId: parentRunId }],
		state,
		mode: "single" as const,
		agent: "worker",
		startedAt: 10,
		...(state === "complete" ? { endedAt: 20 } : {}),
	};
}

function makeState() {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map<string, AsyncJobState>(),
		foregroundRuns: new Map(),
		foregroundControls: new Map<string, ForegroundControl>(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeExecutor(state = makeState(), runtimeCwd = process.cwd()) {
	const executor = createSubagentExecutor?.({
		pi: { events: createEventBus(), getSessionName: () => "test-orchestrator", setSessionName: () => {} },
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: runtimeCwd,
		getSubagentSessionRoot: () => runtimeCwd,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("worker")] }),
	});
	return { executor, state };
}

async function executeAction(
	executor: NonNullable<ReturnType<typeof makeExecutor>["executor"]>,
	params: Record<string, unknown>,
): Promise<ExecutorResult> {
	return executor.execute("recovery-inspection", params, new AbortController().signal, undefined, makeMinimalCtx(process.cwd()));
}

function text(result: ExecutorResult): string {
	return result.content[0]?.text ?? "";
}

afterEach(() => {
	for (const attachmentId of attachmentIds.splice(0)) deleteAttachment(attachmentId);
	for (const id of handleIds.splice(0)) deleteRunHandle(id);
	for (const resultFile of resultFiles.splice(0)) fs.rmSync(resultFile, { force: true });
	for (const asyncDir of asyncDirs.splice(0)) fs.rmSync(asyncDir, { recursive: true, force: true });
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const tempRoot of tempRoots.splice(0)) fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("subagent recovery and inspection actions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, () => {
	it("recovers live foreground, async, and nested runs without implying steering capability", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const foregroundId = uniqueId("recover-fg");
		const asyncId = uniqueId("recover-async");
		const nestedId = uniqueId("recover-nested");
		const route = trackRoute(foregroundId);
		state.foregroundControls.set(foregroundId, {
			runId: foregroundId,
			mode: "single",
			startedAt: 1,
			updatedAt: 2,
			nestedRoute: route,
		});
		state.asyncJobs.set(asyncId, {
			asyncId,
			asyncDir: trackAsyncDir(asyncId),
			status: "running",
			mode: "single",
			agents: ["worker"],
		});
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: foregroundId,
			child: nestedChild(nestedId, foregroundId),
		});

		const foreground = await executeAction(executor, { action: "recover", id: foregroundId });
		const asyncRun = await executeAction(executor, { action: "recover", id: asyncId });
		const nested = await executeAction(executor, { action: "recover", id: nestedId });

		assert.match(text(foreground), /resolved \(kind: foreground, state: live\)/);
		assert.match(text(foreground), new RegExp(route.capabilityToken));
		assert.match(text(foreground), /use action='attach'/);
		assert.match(text(asyncRun), /resolved \(kind: async, state: live\)/);
		assert.match(text(nested), /resolved \(kind: nested, state: live\)/);
	});

	it("recovers async and nested handles after in-memory state loss but reports foreground as non-recoverable", async () => {
		const { executor } = makeExecutor();
		assert.ok(executor);
		const asyncId = uniqueId("reload-async");
		const nestedId = uniqueId("reload-nested");
		const foregroundId = uniqueId("reload-fg");
		const asyncDir = trackAsyncDir(asyncId);
		const route = trackRoute(uniqueId("reload-root"));
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(nestedId, route.rootRunId),
		});
		trackHandle({ id: asyncId, kind: "async", asyncDir, startedAt: 1 });
		trackHandle({ id: nestedId, kind: "nested", route, startedAt: 1 });
		trackHandle({ id: foregroundId, kind: "foreground", pid: process.pid, startedAt: 1 });

		const asyncRun = await executeAction(executor, { action: "recover", id: asyncId });
		const nested = await executeAction(executor, { action: "recover", id: nestedId });
		const foreground = await executeAction(executor, { action: "recover", id: foregroundId });
		const missing = await executeAction(executor, { action: "recover", id: uniqueId("missing") });

		assert.match(text(asyncRun), /resolved \(kind: async, state: live\)/);
		assert.match(text(nested), /resolved \(kind: nested, state: live\)/);
		assert.match(text(foreground), /only resolvable while in-memory/);
		assert.match(text(foreground), /not recoverable after an extension reload/);
		assert.equal(missing.isError, true);
		assert.match(text(missing), /No run handle found/);
	});

	it("inspects live and completed async runs with compact summaries", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const liveId = uniqueId("inspect-live");
		const completedId = uniqueId("inspect-complete");
		state.asyncJobs.set(liveId, {
			asyncId: liveId,
			asyncDir: trackAsyncDir(liveId),
			status: "running",
			mode: "single",
			agents: ["reviewer"],
			turnCount: 3,
			toolCount: 7,
			totalTokens: { input: 10, output: 20, total: 30 },
		});
		trackResult(completedId, {
			id: completedId,
			success: true,
			mode: "single",
			agent: "worker",
			turnCount: 2,
			toolCount: 4,
			totalTokens: { input: 4, output: 6, total: 10 },
			startedAt: 1,
			endedAt: 2,
		});

		const live = await executeAction(executor, { action: "inspect", id: liveId });
		const completed = await executeAction(executor, { action: "inspect", id: completedId });
		const missing = await executeAction(executor, { action: "inspect", id: uniqueId("inspect-missing") });

		assert.match(text(live), new RegExp(`id: ${liveId}.*kind: async.*state: running`));
		assert.match(text(live), /agent: reviewer/);
		assert.match(text(live), /tokens: 30/);
		assert.match(text(completed), /kind: async.*state: complete/);
		assert.match(text(completed), /agent: worker/);
		assert.match(text(completed), /tokens: 10/);
		assert.equal(missing.isError, true);
		assert.match(text(missing), /No run matched/);
	});

	it("attaches steering-capable nested runs, attaches completed async runs for inspection only, and detaches idempotently", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const rootId = uniqueId("attach-root");
		const nestedId = uniqueId("attach-nested");
		const completedId = uniqueId("attach-complete");
		const route = trackRoute(rootId);
		state.foregroundControls.set(rootId, {
			runId: rootId,
			mode: "single",
			startedAt: 1,
			updatedAt: 2,
			nestedRoute: route,
		});
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: rootId,
			child: nestedChild(nestedId, rootId),
		});
		publishLiveControlOwnerEpoch(route, "0");
		trackResult(completedId, { id: completedId, success: true, mode: "single", agent: "worker" });

		const nested = await executeAction(executor, { action: "attach", id: nestedId });
		const completed = await executeAction(executor, { action: "attach", id: completedId });
		const missing = await executeAction(executor, { action: "attach", id: uniqueId("attach-missing") });
		const nestedAttachmentId = text(nested).match(/attachmentId: ([^)]+)/)?.[1];
		const completedAttachmentId = text(completed).match(/attachmentId: ([^)]+)/)?.[1];
		assert.ok(nestedAttachmentId);
		assert.ok(completedAttachmentId);
		attachmentIds.push(nestedAttachmentId, completedAttachmentId);

		assert.match(text(nested), /steering-capable/);
		assert.match(text(completed), /inspection-only/);
		assert.equal(missing.isError, true);
		assert.match(text(missing), /No subagent run matched/);

		const detached = await executeAction(executor, { action: "detach", attachmentId: nestedAttachmentId });
		const detachedAgain = await executeAction(executor, { action: "detach", attachmentId: nestedAttachmentId });
		assert.match(text(detached), /Detached/);
		assert.match(text(detachedAgain), /Detached/);
	});

	it("keeps legacy management action branches reachable", async () => {
		const { executor } = makeExecutor();
		assert.ok(executor);
		const actions: Array<Record<string, unknown>> = [
			{ action: "status" },
			{ action: "interrupt", id: uniqueId("legacy-interrupt") },
			{ action: "resume", id: uniqueId("legacy-resume") },
			{ action: "steer", id: uniqueId("legacy-steer"), message: "focus" },
			{ action: "follow-up", id: uniqueId("legacy-follow"), message: "then summarize" },
			{ action: "wrap-up", id: uniqueId("legacy-wrap") },
		];
		for (const params of actions) {
			const result = await executeAction(executor, params);
			assert.ok(Array.isArray(result.content));
		}
	});
});

describe("run-handle launch-point lifecycle", { skip: !trackerModule ? "async tracker not importable" : undefined }, () => {
	it("records a foreground handle while running and deletes it on completion", async () => {
		assert.ok(createSubagentExecutor);
		const mockPi = createMockPi();
		mockPi.install();
		mockPi.onCall({ output: "done", delay: 150 });
		try {
			const runtimeCwd = createTempDir("pi-run-handle-foreground-");
			tempRoots.push(runtimeCwd);
			const { executor, state } = makeExecutor(makeState(), runtimeCwd);
			assert.ok(executor);
			const execution = executor.execute(
				"foreground-handle",
				{ agent: "worker", task: "finish after the launch assertion" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(runtimeCwd),
			);
			const deadline = Date.now() + 5_000;
			while (state.foregroundControls.size === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			const runId = state.foregroundControls.keys().next().value;
			assert.equal(typeof runId, "string", "foreground launch should register in-memory control state");
			if (typeof runId !== "string") return;
			handleIds.push(runId);
			const launched = recoverRunHandle(runId);
			assert.ok(launched, "foreground launch should durably record a handle");
			assert.equal(launched.kind, "foreground");

			const result = await execution;
			assert.equal(result.isError, undefined);
			assert.equal(recoverRunHandle(runId), undefined, "foreground completion should delete the durable handle");
			assert.equal(state.foregroundControls.has(runId), false);
		} finally {
			mockPi.uninstall();
		}
	});
	it("records an async handle at tracking launch and deletes it at cleanup", async () => {
		assert.ok(trackerModule);
		const state = makeState();
		const id = uniqueId("tracker-handle");
		const asyncDir = trackAsyncDir(id);
		handleIds.push(id);
		const tracker = trackerModule.createAsyncJobTracker(
			{ events: { emit: () => {} } },
			state,
			ASYNC_DIR,
			{ completionRetentionMs: 5, pollIntervalMs: 1000 },
		);

		tracker.handleStarted({ id, asyncDir, agent: "worker", pid: process.pid });
		const launched = recoverRunHandle(id);
		assert.ok(launched);
		assert.equal(launched.kind, "async");
		assert.equal(launched.asyncDir, asyncDir);

		tracker.handleComplete({ id, success: true });
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(recoverRunHandle(id), undefined);
		assert.equal(state.asyncJobs.has(id), false);
	});
});
