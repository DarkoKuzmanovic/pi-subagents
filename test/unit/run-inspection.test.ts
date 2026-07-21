import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	attachToRun,
	detachFromRun,
	inspectRun,
} from "../../src/runs/shared/run-inspection.ts";
import {
	recoverAttachment,
	deleteAttachment,
} from "../../src/runs/shared/run-attachment-store.ts";
import {
	createNestedRoute,
	publishLiveControlOwnerEpoch,
	readPendingLiveControlRequests,
	writeNestedEvent,
	type NestedRoute,
} from "../../src/runs/shared/nested-events.ts";
import type { AsyncJobState, ForegroundControl, SubagentState } from "../../src/shared/types.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";

const routes: NestedRoute[] = [];
const attachmentIds: string[] = [];
const asyncDirs: string[] = [];
const resultFiles: string[] = [];

afterEach(() => {
	for (const id of attachmentIds.splice(0)) {
		try {
			deleteAttachment(id);
		} catch {
			// ignore
		}
	}
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const dir of asyncDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	for (const file of resultFiles.splice(0)) {
		fs.rmSync(file, { force: true });
	}
});

function trackRoute(rootRunId = `root-${Math.random().toString(36).slice(2)}`): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function emptyState(): SubagentState {
	return {
		baseCwd: process.cwd(),
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
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

function nestedChild(id: string, parentRunId: string, state: "running" | "complete" | "failed" = "running") {
	return {
		id,
		parentRunId,
		parentStepIndex: 0,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 0 }],
		mode: "single" as const,
		state,
		agent: "reviewer",
		agents: ["reviewer"],
		pid: 4242,
		activityState: state === "running" ? ("active_long_running" as const) : undefined,
		turnCount: 3,
		toolCount: 5,
		totalTokens: { input: 10, output: 20, total: 30 },
		currentTool: state === "running" ? "bash" : undefined,
		currentToolStartedAt: state === "running" ? 50 : undefined,
		lastActivityAt: 100,
		startedAt: 10,
		endedAt: state === "running" ? undefined : 200,
		steps: [{ agent: "reviewer", status: state === "running" ? ("running" as const) : ("complete" as const) }],
		error: state === "failed" ? "boom" : undefined,
	};
}

describe("attachToRun", () => {
	it("attaches to a live nested run with owner epoch verified and attachment recorded", () => {
		const route = trackRoute();
		const childId = `child-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "running"),
		});
		const owner = publishLiveControlOwnerEpoch(route, "0");

		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const result = attachToRun(childId, { state }, { attachmentId: trackAtt(`att-nested-${childId}`), now: 999 });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.attachment.id, childId);
		assert.equal(result.attachment.kind, "nested");
		assert.equal(result.attachment.childKey, "0");
		assert.equal(result.attachment.epoch, owner.epoch);
		assert.equal(result.attachment.route?.capabilityToken, route.capabilityToken);
		assert.equal(result.attachment.state, "attached");
		assert.equal(result.attachment.attachedAt, 999);

		const recovered = recoverAttachment(result.attachment.attachmentId);
		assert.ok(recovered);
		assert.equal(recovered?.epoch, owner.epoch);
	});

	it("attaches to a foreground run as in-memory no-op bookkeeping", () => {
		const id = `fg-${Math.random().toString(36).slice(2)}`;
		const state = emptyState();
		const control: ForegroundControl = {
			runId: id,
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
			turnCount: 2,
			toolCount: 4,
			currentTool: "read",
			lastActivityAt: 15,
		};
		state.foregroundControls.set(id, control);

		const result = attachToRun(id, { state }, { attachmentId: trackAtt(`att-fg-${id}`) });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.attachment.kind, "foreground");
		assert.equal(result.attachment.note, "foreground, in-memory");
		assert.equal(result.attachment.state, "attached");
	});

	it("attaches to an async run", () => {
		const id = `async-${Math.random().toString(36).slice(2)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
		asyncDirs.push(asyncDir);
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId: id,
				mode: "single",
				state: "running",
				startedAt: 1,
				pid: process.pid,
				turnCount: 1,
				toolCount: 2,
			}),
			"utf-8",
		);

		const state = emptyState();
		const job: AsyncJobState = {
			asyncId: id,
			asyncDir,
			status: "running",
			mode: "single",
			pid: process.pid,
			startedAt: 1,
			turnCount: 1,
			toolCount: 2,
			agents: ["worker"],
		};
		state.asyncJobs.set(id, job);

		const result = attachToRun(id, { state }, { attachmentId: trackAtt(`att-async-${id}`) });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.attachment.kind, "async");
		assert.equal(result.attachment.note, "async");
	});

	it("rejects attach to non-existent run", () => {
		const result = attachToRun(`missing-${Math.random().toString(36).slice(2)}`, { state: emptyState() });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /No subagent run matched/);
	});

	it("rejects nested attach when no owner epoch is registered", () => {
		const route = trackRoute();
		const childId = `child-noowner-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "running"),
		});
		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const result = attachToRun(childId, { state });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /No live control owner/);
	});

	it("rejects nested attach when capability token does not match owner", () => {
		const route = trackRoute();
		const childId = `child-cap-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "running"),
		});
		// Publish owner under the real route, then present a different capability token.
		publishLiveControlOwnerEpoch(route, "0");
		const wrongRoute = {
			...route,
			capabilityToken: "wrong-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		};

		// Scope resolution to the real route so the nested match is found, but force
		// attach verification against wrong capability by temporarily writing owner with mismatch.
		// readLiveControlOwnerEpoch rejects when capabilityToken on disk != route.capabilityToken.
		// Publish a second epoch file path can't be faked easily; instead re-read with wrong route:
		// attach uses match.route from findNestedRunMatchesById which carries the real token.
		// So we simulate wrong capability by replacing the on-disk owner capability after publish.
		const ownerFile = path.join(path.dirname(route.eventSink), "live-control", "owners", "0.epoch.json");
		const ownerRaw = JSON.parse(fs.readFileSync(ownerFile, "utf-8")) as Record<string, unknown>;
		ownerRaw.capabilityToken = wrongRoute.capabilityToken;
		fs.writeFileSync(ownerFile, `${JSON.stringify(ownerRaw)}\n`, "utf-8");

		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const result = attachToRun(childId, { state });
		assert.equal(result.ok, false);
		if (result.ok) return;
		// readLiveControlOwnerEpoch returns undefined on capability mismatch → no owner message.
		assert.match(result.error, /No live control owner|Capability token/);
	});

	it("rejects attach to completed nested run", () => {
		const route = trackRoute();
		const childId = `child-done-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 2,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "complete"),
		});
		publishLiveControlOwnerEpoch(route, "0");
		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const result = attachToRun(childId, { state });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.error, /not live/);
	});
});

describe("detachFromRun", () => {
	it("revokes attachment and is idempotent", () => {
		const id = `fg-detach-${Math.random().toString(36).slice(2)}`;
		const state = emptyState();
		state.foregroundControls.set(id, {
			runId: id,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
		});
		const attId = trackAtt(`att-detach-${id}`);
		const result = attachToRun(id, { state }, { attachmentId: attId });
		assert.equal(result.ok, true);
		assert.ok(recoverAttachment(attId));

		detachFromRun(attId);
		assert.equal(recoverAttachment(attId), undefined);
		// Idempotent — no throw.
		detachFromRun(attId);
		assert.equal(recoverAttachment(attId), undefined);
	});

	it("does not submit any live-control request to the child", () => {
		const route = trackRoute();
		const childId = `child-transport-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "running"),
		});
		publishLiveControlOwnerEpoch(route, "0");
		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const attId = trackAtt(`att-transport-${childId}`);
		const result = attachToRun(childId, { state }, { attachmentId: attId });
		assert.equal(result.ok, true);
		assert.deepEqual(readPendingLiveControlRequests(route, "0"), []);

		detachFromRun(attId);
		assert.deepEqual(readPendingLiveControlRequests(route, "0"), []);
	});
});

describe("inspectRun", () => {
	it("inspects a live nested run with compact fields and no transcript", () => {
		const route = trackRoute();
		const childId = `child-insp-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 1,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "running"),
		});
		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const inspection = inspectRun(childId, { state });
		assert.ok(inspection);
		assert.equal(inspection?.id, childId);
		assert.equal(inspection?.kind, "nested");
		assert.equal(inspection?.state, "running");
		assert.equal(inspection?.pid, 4242);
		assert.equal(inspection?.turnCount, 3);
		assert.equal(inspection?.toolCount, 5);
		assert.equal(inspection?.currentTool, "bash");
		assert.equal(inspection?.totalTokens?.total, 30);
		assert.equal(inspection?.steps?.count, 1);
		assert.equal(inspection?.steps?.statuses?.[0]?.agent, "reviewer");
		// Compact surface: no transcript-ish keys.
		assert.equal("transcript" in (inspection ?? {}), false);
		assert.equal("recentOutput" in (inspection ?? {}), false);
	});

	it("inspects a completed nested run final state", () => {
		const route = trackRoute();
		const childId = `child-done-insp-${Math.random().toString(36).slice(2)}`;
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 2,
			parentRunId: route.rootRunId,
			child: nestedChild(childId, route.rootRunId, "complete"),
		});
		const state = emptyState();
		state.foregroundControls.set(route.rootRunId, {
			runId: route.rootRunId,
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		});

		const inspection = inspectRun(childId, { state });
		assert.ok(inspection);
		assert.equal(inspection?.state, "complete");
		assert.equal(inspection?.endedAt, 200);
		assert.equal(inspection?.currentTool, undefined);
	});

	it("inspects a foreground run from in-memory controls", () => {
		const id = `fg-insp-${Math.random().toString(36).slice(2)}`;
		const state = emptyState();
		state.foregroundControls.set(id, {
			runId: id,
			mode: "single",
			startedAt: 10,
			updatedAt: 20,
			currentAgent: "worker",
			turnCount: 7,
			toolCount: 9,
			currentTool: "bash",
			currentToolStartedAt: 12,
			lastActivityAt: 15,
			tokens: 42,
		});

		const inspection = inspectRun(id, { state });
		assert.ok(inspection);
		assert.equal(inspection?.kind, "foreground");
		assert.equal(inspection?.state, "running");
		assert.equal(inspection?.agent, "worker");
		assert.equal(inspection?.turnCount, 7);
		assert.equal(inspection?.toolCount, 9);
		assert.equal(inspection?.currentTool, "bash");
		assert.equal(inspection?.totalTokens?.total, 42);
	});

	it("inspects an async run from job state / status.json", () => {
		const id = `async-insp-${Math.random().toString(36).slice(2)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
		asyncDirs.push(asyncDir);
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId: id,
				mode: "chain",
				state: "running",
				startedAt: 5,
				pid: 99,
				turnCount: 4,
				toolCount: 6,
				currentTool: "edit",
				currentStep: 1,
				chainStepCount: 3,
				steps: [
					{ agent: "recon", status: "complete" },
					{ agent: "worker", status: "running" },
				],
			}),
			"utf-8",
		);

		const inspection = inspectRun(id, { state: emptyState() });
		assert.ok(inspection);
		assert.equal(inspection?.kind, "async");
		assert.equal(inspection?.state, "running");
		assert.equal(inspection?.mode, "chain");
		assert.equal(inspection?.pid, 99);
		assert.equal(inspection?.turnCount, 4);
		assert.equal(inspection?.toolCount, 6);
		assert.equal(inspection?.currentTool, "edit");
		assert.equal(inspection?.steps?.count, 2);
		assert.equal(inspection?.steps?.current, 1);
		assert.equal(inspection?.steps?.chainStepCount, 3);
	});

	it("inspects a completed async run from result file", () => {
		const id = `async-done-${Math.random().toString(36).slice(2)}`;
		fs.mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		fs.writeFileSync(
			resultPath,
			JSON.stringify({
				id,
				success: true,
				mode: "single",
				agent: "worker",
				startedAt: 1,
				endedAt: 50,
				turnCount: 2,
				toolCount: 3,
				totalTokens: { input: 1, output: 2, total: 3 },
			}),
			"utf-8",
		);
		resultFiles.push(resultPath);

		const inspection = inspectRun(id, { state: emptyState() });
		assert.ok(inspection);
		assert.equal(inspection?.kind, "async");
		assert.equal(inspection?.state, "complete");
		assert.equal(inspection?.endedAt, 50);
		assert.equal(inspection?.agent, "worker");
		assert.equal(inspection?.totalTokens?.total, 3);
	});

	it("returns undefined for non-existent run", () => {
		assert.equal(inspectRun(`missing-insp-${Math.random().toString(36).slice(2)}`, { state: emptyState() }), undefined);
	});
});

function trackAtt(id: string): string {
	attachmentIds.push(id);
	return id;
}
