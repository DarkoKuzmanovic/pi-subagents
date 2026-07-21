import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import {
	createNestedRoute,
	writeNestedEvent,
	type NestedRoute,
} from "../../src/runs/shared/nested-events.ts";
import {
	deleteRunHandle,
	recordRunHandle,
} from "../../src/runs/shared/run-handle-store.ts";

const routes: NestedRoute[] = [];
const handleIds: string[] = [];
const asyncDirs: string[] = [];
const resultFiles: string[] = [];

afterEach(() => {
	for (const id of handleIds.splice(0)) {
		try {
			deleteRunHandle(id);
		} catch {
			// already gone
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

function trackHandleId(id: string): string {
	handleIds.push(id);
	return id;
}

function trackRoute(rootRunId = `root-${Math.random().toString(36).slice(2)}`): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function emptyState(): SubagentState {
	return {
		baseCwd: "",
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

function stateWithForeground(id: string): SubagentState {
	const state = emptyState();
	state.foregroundControls.set(id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 });
	state.lastForegroundControlId = id;
	return state;
}

function writeNestedChild(route: NestedRoute, parentRunId: string, id: string): void {
	writeNestedEvent(route, {
		type: "subagent.nested.updated",
		ts: 100,
		parentRunId,
		child: {
			id,
			parentRunId,
			depth: 1,
			path: [{ runId: parentRunId }],
			state: "running",
			agent: "worker",
		},
	});
}

describe("run id resolver — durable store fallback", () => {
	it("recovers an async handle from the store when in-memory and on-disk scans miss", () => {
		// Use an isolated async/results root so exactAsyncLocation does not find the run,
		// forcing the store fallback path. The handle's own asyncDir still exists under ASYNC_DIR.
		const id = trackHandleId(`store-async-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
		asyncDirs.push(asyncDir);
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			pid: process.pid,
			startedAt: Date.now(),
		});

		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-store-async-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			fs.mkdirSync(asyncDirRoot, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
			});
			assert.ok(resolved, "store fallback should recover async handle");
			assert.equal(resolved?.kind, "async");
			assert.equal(resolved?.id, id);
			if (resolved?.kind === "async") {
				assert.equal(resolved.location.asyncDir, asyncDir);
			}
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("recovers a nested handle from the store when in-memory state is empty", () => {
		const route = trackRoute();
		const id = trackHandleId(`store-nested-${Math.random().toString(36).slice(2)}`);
		writeNestedChild(route, route.rootRunId, id);
		recordRunHandle({
			id,
			kind: "nested",
			route,
			pid: process.pid,
			startedAt: Date.now(),
		});

		// Empty state + isolated async roots so only store fallback can find nested.
		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-store-nested-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			fs.mkdirSync(asyncDirRoot, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			// Without store, empty nested scope finds nothing (and global scan may still find it).
			// Force store path by providing empty nested scope so exactNested is empty,
			// then store recovers via the recorded route.
			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
				nested: { routes: [] },
			});
			assert.ok(resolved, "store fallback should recover nested handle");
			assert.equal(resolved?.kind, "nested");
			assert.equal(resolved?.id, id);
			if (resolved?.kind === "nested") {
				assert.equal(resolved.match.rootRunId, route.rootRunId);
			}
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("does not resolve store-recovered foreground handles as live", () => {
		const id = trackHandleId(`store-fg-${Math.random().toString(36).slice(2)}`);
		// Record with live host PID — this is the false-recovery scenario after reload.
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-store-fg-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			fs.mkdirSync(asyncDirRoot, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
				nested: { routes: [] },
			});
			assert.equal(resolved, undefined, "foreground must not resolve live from store");
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("still prefers in-memory foreground over store and on-disk", () => {
		const id = trackHandleId(`order-fg-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(ASYNC_DIR, id);
		fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
		asyncDirs.push(asyncDir);
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			startedAt: Date.now(),
		});

		const resolved = resolveSubagentRunId(id, {
			state: stateWithForeground(id),
			asyncDirRoot: ASYNC_DIR,
			resultsDir: RESULTS_DIR,
		});
		assert.equal(resolved?.kind, "foreground");
		assert.equal(resolved?.id, id);
	});

	it("prefers on-disk async over store fallback", () => {
		const id = trackHandleId(`order-async-${Math.random().toString(36).slice(2)}`);
		// On-disk under isolated root (exact match), plus a store handle pointing elsewhere.
		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-order-async-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			const onDiskDir = path.join(asyncDirRoot, id);
			fs.mkdirSync(onDiskDir, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			const storeAsyncDir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(storeAsyncDir, { recursive: true, mode: 0o700 });
			asyncDirs.push(storeAsyncDir);
			recordRunHandle({
				id,
				kind: "async",
				asyncDir: storeAsyncDir,
				startedAt: Date.now(),
			});

			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
			});
			assert.equal(resolved?.kind, "async");
			if (resolved?.kind === "async") {
				assert.equal(resolved.location.asyncDir, onDiskDir, "exact on-disk location wins");
			}
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("prefix matching still works after store fallback returns nothing", () => {
		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-prefix-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			const fullId = `prefixmatch-${Math.random().toString(36).slice(2)}`;
			fs.mkdirSync(path.join(asyncDirRoot, fullId), { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			// Store has an unrelated exact id that should not shadow prefix.
			const storeId = trackHandleId(`other-${Math.random().toString(36).slice(2)}`);
			const storeAsyncDir = path.join(ASYNC_DIR, storeId);
			fs.mkdirSync(storeAsyncDir, { recursive: true, mode: 0o700 });
			asyncDirs.push(storeAsyncDir);
			recordRunHandle({
				id: storeId,
				kind: "async",
				asyncDir: storeAsyncDir,
				startedAt: Date.now(),
			});

			const resolved = resolveSubagentRunId("prefixmatch-", {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
				nested: { routes: [] },
			});
			assert.equal(resolved?.kind, "async");
			assert.equal(resolved?.id, fullId);
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("returns undefined when store handle is stale (async dir and result gone)", () => {
		const id = trackHandleId(`stale-store-async-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(ASYNC_DIR, id);
		// Record without creating dir/result so recoverRunHandle returns undefined.
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			startedAt: Date.now(),
		});

		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-stale-async-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			fs.mkdirSync(asyncDirRoot, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
				nested: { routes: [] },
			});
			assert.equal(resolved, undefined);
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});

	it("returns undefined when store nested route is gone", () => {
		const route = trackRoute();
		const id = trackHandleId(`stale-store-nested-${Math.random().toString(36).slice(2)}`);
		writeNestedChild(route, route.rootRunId, id);
		recordRunHandle({
			id,
			kind: "nested",
			route,
			startedAt: Date.now(),
		});
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });

		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resolver-stale-nested-"));
		try {
			const asyncDirRoot = path.join(isolatedRoot, "runs");
			const resultsDir = path.join(isolatedRoot, "results");
			fs.mkdirSync(asyncDirRoot, { recursive: true });
			fs.mkdirSync(resultsDir, { recursive: true });

			const resolved = resolveSubagentRunId(id, {
				state: emptyState(),
				asyncDirRoot,
				resultsDir,
				nested: { routes: [] },
			});
			assert.equal(resolved, undefined);
		} finally {
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
		}
	});
});
