import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	recordRunHandle,
	recoverRunHandle,
	deleteRunHandle,
	type RunHandleRecord,
} from "../../src/runs/shared/run-handle-store.ts";
import { createNestedRoute, type NestedRoute } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

const handleDir = path.join(TEMP_ROOT_DIR, "run-handles");
const routes: NestedRoute[] = [];
const handleIds: string[] = [];

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
});

function trackRoute(rootRunId = `root-${Math.random().toString(36).slice(2)}`): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function trackHandleId(id: string): string {
	handleIds.push(id);
	return id;
}

describe("run handle store — recording and recovery", () => {
	it("records a foreground run handle and recovers it by id", () => {
		const id = trackHandleId(`fg-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.ok(recovered, "handle should be recovered");
		assert.equal(recovered?.id, id);
		assert.equal(recovered?.kind, "foreground");
		assert.equal(recovered?.pid, process.pid);
	});

	it("records an async run handle and recovers it by id", () => {
		const id = trackHandleId(`async-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(TEMP_ROOT_DIR, "async-subagent-runs", id);
		fs.mkdirSync(asyncDir, { recursive: true });
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			pid: process.pid,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.ok(recovered, "handle should be recovered");
		assert.equal(recovered?.id, id);
		assert.equal(recovered?.kind, "async");
		assert.equal(recovered?.asyncDir, asyncDir);
	});

	it("records a nested run handle with route and recovers it by id", () => {
		const route = trackRoute();
		const id = trackHandleId(`nested-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "nested",
			route,
			pid: process.pid,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.ok(recovered, "handle should be recovered");
		assert.equal(recovered?.id, id);
		assert.equal(recovered?.kind, "nested");
		assert.equal(recovered?.route?.rootRunId, route.rootRunId);
		assert.equal(recovered?.route?.capabilityToken, route.capabilityToken);
	});

	it("survives extension reload (handle persists on disk)", () => {
		const id = trackHandleId(`reload-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		// Simulate reload by calling recoverRunHandle fresh — it reads from disk
		const recovered = recoverRunHandle(id);
		assert.ok(recovered, "handle should survive reload");
		assert.equal(recovered?.id, id);
		assert.equal(recovered?.kind, "foreground");
	});
});

describe("run handle store — stale and missing handles", () => {
	it("returns undefined for a missing handle (no registry entry)", () => {
		const recovered = recoverRunHandle("nonexistent-handle-id");
		assert.equal(recovered, undefined);
	});

	it("returns undefined for a stale handle whose process is gone", () => {
		const id = trackHandleId(`stale-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: 999999, // very likely nonexistent PID
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.equal(recovered, undefined, "stale handle (dead PID) should not be recovered");
	});

	it("returns undefined for a stale async handle whose directory is gone", () => {
		const id = trackHandleId(`stale-async-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(TEMP_ROOT_DIR, "async-subagent-runs", id);
		// Don't create the directory — simulate it being cleaned up
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			pid: 999999,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.equal(recovered, undefined, "stale async handle (no dir, dead PID) should not be recovered");
	});

	it("returns undefined for a stale nested handle whose route is gone", () => {
		const route = trackRoute();
		const id = trackHandleId(`stale-nested-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "nested",
			route,
			pid: 999999,
			startedAt: Date.now(),
		});

		// Remove the route directory to simulate cleanup
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });

		const recovered = recoverRunHandle(id);
		assert.equal(recovered, undefined, "stale nested handle (route gone) should not be recovered");
	});
});

describe("run handle store — wrong capability and cross-route confusion", () => {
	it("recovers a nested handle with the correct capability token from its route", () => {
		const route = trackRoute();
		const id = trackHandleId(`cap-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "nested",
			route,
			pid: process.pid,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.ok(recovered);
		assert.equal(recovered?.route?.capabilityToken, route.capabilityToken);
	});

	it("does not confuse handles across different routes", () => {
		const route1 = trackRoute();
		const route2 = trackRoute();
		const id1 = trackHandleId(`cross1-${Math.random().toString(36).slice(2)}`);
		const id2 = trackHandleId(`cross2-${Math.random().toString(36).slice(2)}`);

		recordRunHandle({
			id: id1,
			kind: "nested",
			route: route1,
			pid: process.pid,
			startedAt: Date.now(),
		});
		recordRunHandle({
			id: id2,
			kind: "nested",
			route: route2,
			pid: process.pid,
			startedAt: Date.now(),
		});

		const recovered1 = recoverRunHandle(id1);
		const recovered2 = recoverRunHandle(id2);

		assert.ok(recovered1);
		assert.ok(recovered2);
		assert.notEqual(recovered1?.route?.rootRunId, recovered2?.route?.rootRunId);
		assert.equal(recovered1?.route?.rootRunId, route1.rootRunId);
		assert.equal(recovered2?.route?.rootRunId, route2.rootRunId);
	});
});

describe("run handle store — deletion and cleanup", () => {
	it("deletes a handle and it can no longer be recovered", () => {
		const id = trackHandleId(`del-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		assert.ok(recoverRunHandle(id));

		deleteRunHandle(id);
		assert.equal(recoverRunHandle(id), undefined);
	});

	it("deleteRunHandle is idempotent (no throw on missing handle)", () => {
		assert.doesNotThrow(() => deleteRunHandle("nonexistent-delete-id"));
	});
});

describe("run handle store — permissions", () => {
	it("keeps handle store directories and files owner-only", () => {
		const id = trackHandleId(`perm-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		const stat = fs.statSync(handleDir);
		assert.equal(stat.mode & 0o777, 0o700, "handle store dir should be 0700");

		const handleFile = path.join(handleDir, `${id}.json`);
		const fileStat = fs.statSync(handleFile);
		assert.equal(fileStat.mode & 0o777, 0o600, "handle file should be 0600");
	});
});
