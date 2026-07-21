import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNestedRoute,
	publishLiveControlOwnerEpoch,
	readLiveControlRequestState,
	writeLiveControlRequestState,
	writeNestedEvent,
	type NestedRoute,
} from "../../src/runs/shared/nested-events.ts";
import { ASYNC_DIR, type AsyncJobState, type Details, type ForegroundControl, type LiveControlDisposition, type LiveControlRequestState } from "../../src/shared/types.ts";
import { createEventBus, makeAgent, makeMinimalCtx, tryImport } from "../support/helpers.ts";
import { performLiveControlAction } from "../../src/runs/shared/live-control-client.ts";

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

const executorModule = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const createSubagentExecutor = executorModule?.createSubagentExecutor;
const routeRoots: string[] = [];
const asyncDirs: string[] = [];

function trackRoute(rootRunId: string): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	return route;
}

function seedResult(
	route: NestedRoute,
	childKey: string,
	epoch: string,
	requestId: string,
	state: LiveControlRequestState,
	disposition?: LiveControlDisposition,
	message = state,
): void {
	writeLiveControlRequestState(route, {
		schemaVersion: 2,
		type: "subagent.live-control.result",
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		childKey,
		epoch,
		sequence: 1,
		requestId,
		state,
		...(disposition ? { disposition } : {}),
		message,
		ts: Date.now(),
	});
}

function makeExecutor() {
	const foregroundControls = new Map<string, ForegroundControl>();
	const asyncJobs = new Map<string, AsyncJobState>();
	const state = {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs,
		foregroundRuns: new Map(),
		foregroundControls,
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
	const executor = createSubagentExecutor?.({
		pi: { events: createEventBus(), getSessionName: () => "test-orchestrator", setSessionName: () => {} },
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: process.cwd(),
		getSubagentSessionRoot: () => process.cwd(),
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("worker")] }),
	});
	return { executor, state };
}

async function executeAction(
	executor: NonNullable<ReturnType<typeof makeExecutor>["executor"]>,
	params: Record<string, unknown>,
): Promise<ExecutorResult> {
	return executor.execute("live-control", params, new AbortController().signal, undefined, makeMinimalCtx(process.cwd()));
}

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const dir of asyncDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("subagent live-control management actions", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, () => {
	it("steers a live foreground run and reuses an accepted requestId result", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const route = trackRoute("fg-control");
		state.foregroundControls.set("fg-control", {
			runId: "fg-control",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			nestedRoute: route,
		});
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, "0", owner.epoch, "fg-steer-id", "accepted-by-pi", "queued-steer");

		const first = await executeAction(executor, { action: "steer", id: "fg-control", message: "Focus here", requestId: "fg-steer-id" });
		const retry = await executeAction(executor, { action: "steer", id: "fg-control", message: "Focus here", requestId: "fg-steer-id" });

		assert.equal(first.isError, undefined);
		assert.match(first.content[0]?.text ?? "", /Steer accepted.*queued as a steer/);
		assert.match(retry.content[0]?.text ?? "", /Steer accepted/);
		assert.equal(readLiveControlRequestState(route, "0", 1, "fg-steer-id")?.state, "accepted-by-pi");
	});

	it("queues a follow-up for a tracked live async run", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const asyncId = `async-control-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, asyncId);
		fs.mkdirSync(asyncDir, { recursive: true });
		asyncDirs.push(asyncDir);
		const route = trackRoute(asyncId);
		state.asyncJobs.set(asyncId, {
			asyncId,
			asyncDir,
			status: "running",
			mode: "single",
			nestedRoute: route,
		});
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, "0", owner.epoch, "async-follow-id", "accepted-by-pi", "queued-follow-up");

		const result = await executeAction(executor, { action: "follow-up", id: asyncId, message: "Then summarize", requestId: "async-follow-id" });

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Follow-up accepted.*queued as a follow-up/);
	});

	it("targets an indexed child of a live nested run for wrap-up", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const route = trackRoute("root-control");
		state.foregroundControls.set("root-control", {
			runId: "root-control",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			nestedRoute: route,
		});
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: Date.now(),
			parentRunId: "root-control",
			child: {
				id: "nested-control",
				parentRunId: "root-control",
				depth: 1,
				path: [{ runId: "root-control" }],
				state: "running",
				mode: "parallel",
				agents: ["worker-a", "worker-b"],
			},
		});
		const owner = publishLiveControlOwnerEpoch(route, "1");
		seedResult(route, "1", owner.epoch, "nested-wrap-id", "accepted-by-pi", "started-turn");

		const result = await executeAction(executor, { action: "wrap-up", id: "nested-control", index: 1, requestId: "nested-wrap-id" });

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Wrap-up accepted.*started a fresh turn/);
	});

	it("requires an explicit child index for a multi-child live run", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const route = trackRoute("parallel-control");
		state.foregroundControls.set("parallel-control", {
			runId: "parallel-control",
			mode: "parallel",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			nestedRoute: route,
		});

		const result = await executeAction(executor, { action: "steer", id: "parallel-control", message: "Focus" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Provide index/);
	});

	it("waits through delivery-attempted and reports the later accepted-by-pi acknowledgement", async () => {
		const { executor, state } = makeExecutor();
		assert.ok(executor);
		const route = trackRoute("attempted-accepted-control");
		state.foregroundControls.set("attempted-accepted-control", {
			runId: "attempted-accepted-control",
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			nestedRoute: route,
		});
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, "0", owner.epoch, "attempted-accepted-id", "delivery-attempted");
		const acceptance = new Promise<void>((resolve) => {
			setTimeout(() => {
				seedResult(route, "0", owner.epoch, "attempted-accepted-id", "accepted-by-pi", "queued-steer");
				resolve();
			}, 5);
		});

		const result = await executeAction(executor, { action: "steer", id: "attempted-accepted-control", message: "Focus", requestId: "attempted-accepted-id" });
		await acceptance;

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /Steer accepted.*queued as a steer/);
	});

	it("reports a stuck delivery-attempted request as outcome-unknown only after the deadline", async () => {
		const route = trackRoute("unknown-control");
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, "0", owner.epoch, "unknown-id", "delivery-attempted", undefined, "child exited after send");
		let now = 0;

		const result = await performLiveControlAction({
			route,
			childKey: "0",
			action: "steer",
			text: "Focus",
			requestId: "unknown-id",
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			pollMs: 10,
			waitMs: 35,
		});

		assert.equal(result.ok, false);
		assert.equal(result.state, "outcome-unknown");
		assert.ok(now >= 35);
		assert.match(result.message, /Outcome is unknown/);
		assert.doesNotMatch(result.message, /accepted by/);
});
});
