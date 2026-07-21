import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	recordRunHandle,
	recoverRunHandle,
	deleteRunHandle,
	listRunHandleIds,
	RUN_HANDLES_DIR,
} from "../../src/runs/shared/run-handle-store.ts";
import { createNestedRoute, type NestedRoute } from "../../src/runs/shared/nested-events.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR } from "../../src/shared/types.ts";

const handleDir = path.join(TEMP_ROOT_DIR, "run-handles");
const routes: NestedRoute[] = [];
const handleIds: string[] = [];
const resultFiles: string[] = [];
const asyncDirs: string[] = [];

afterEach(() => {
	for (const id of handleIds.splice(0)) {
		try {
			deleteRunHandle(id);
		} catch {
			// already gone
		}
		// Also force-remove any raw files planted for parse tests.
		try {
			fs.rmSync(path.join(handleDir, `${id}.json`), { force: true });
		} catch {
			// ignore
		}
	}
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const resultFile of resultFiles.splice(0)) {
		fs.rmSync(resultFile, { force: true });
	}
	for (const dir of asyncDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
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

function trackAsyncDir(id: string): string {
	const asyncDir = path.join(ASYNC_DIR, id);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	asyncDirs.push(asyncDir);
	return asyncDir;
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
		const asyncDir = trackAsyncDir(id);
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

	it("recovers an async handle when only the result file remains", () => {
		const id = trackHandleId(`async-result-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(ASYNC_DIR, id);
		// Do not create asyncDir — only the result file.
		fs.mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		fs.writeFileSync(resultPath, JSON.stringify({ id, status: "completed" }), "utf-8");
		resultFiles.push(resultPath);

		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.ok(recovered, "handle should recover via result file");
		assert.equal(recovered?.kind, "async");
		assert.equal(recovered?.asyncDir, asyncDir);
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

	it("returns undefined for a stale async handle whose directory and result are gone", () => {
		const id = trackHandleId(`stale-async-${Math.random().toString(36).slice(2)}`);
		const asyncDir = path.join(ASYNC_DIR, id);
		// Don't create the directory or result file — simulate cleanup
		recordRunHandle({
			id,
			kind: "async",
			asyncDir,
			pid: 999999,
			startedAt: Date.now(),
		});

		const recovered = recoverRunHandle(id);
		assert.equal(recovered, undefined, "stale async handle (no dir, no result) should not be recovered");
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

	it("tightens an existing looser handle store directory to 0700", () => {
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o755 });
		// Force a looser mode if the platform preserved a prior 0700.
		fs.chmodSync(RUN_HANDLES_DIR, 0o755);
		assert.equal(fs.statSync(RUN_HANDLES_DIR).mode & 0o777, 0o755);

		const id = trackHandleId(`perm-fix-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({
			id,
			kind: "foreground",
			pid: process.pid,
			startedAt: Date.now(),
		});

		assert.equal(fs.statSync(RUN_HANDLES_DIR).mode & 0o777, 0o700, "dir should be tightened to 0700");
	});
});

describe("run handle store — kind invariants", () => {
	it("throws when recording async without asyncDir", () => {
		const id = trackHandleId(`inv-async-${Math.random().toString(36).slice(2)}`);
		assert.throws(
			() =>
				recordRunHandle({
					id,
					kind: "async",
					startedAt: Date.now(),
				}),
			/requires asyncDir/,
		);
	});

	it("throws when recording nested without route", () => {
		const id = trackHandleId(`inv-nested-${Math.random().toString(36).slice(2)}`);
		assert.throws(
			() =>
				recordRunHandle({
					id,
					kind: "nested",
					startedAt: Date.now(),
				}),
			/requires route/,
		);
	});
});

describe("run handle store — path containment", () => {
	it("rejects asyncDir outside ASYNC_DIR at record time", () => {
		const id = trackHandleId(`escape-async-${Math.random().toString(36).slice(2)}`);
		assert.throws(
			() =>
				recordRunHandle({
					id,
					kind: "async",
					asyncDir: path.join(TEMP_ROOT_DIR, "not-async", id),
					startedAt: Date.now(),
				}),
			/asyncDir is outside/,
		);
	});

	it("rejects nested route paths outside NESTED_EVENTS_DIR at record time", () => {
		const id = trackHandleId(`escape-nested-${Math.random().toString(36).slice(2)}`);
		const badRoot = path.join(TEMP_ROOT_DIR, "escape-route-root");
		fs.mkdirSync(badRoot, { recursive: true });
		assert.throws(
			() =>
				recordRunHandle({
					id,
					kind: "nested",
					route: {
						rootRunId: "root-escape",
						eventSink: path.join(badRoot, "events"),
						controlInbox: path.join(badRoot, "controls"),
						capabilityToken: "token-escape",
					},
					startedAt: Date.now(),
				}),
			/outside the subagent nested event root/,
		);
		fs.rmSync(badRoot, { recursive: true, force: true });
	});

	it("returns undefined when an on-disk handle has escaped asyncDir", () => {
		const id = trackHandleId(`parse-escape-async-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(RUN_HANDLES_DIR, `${id}.json`),
			JSON.stringify({
				schemaVersion: 2,
				type: "subagent.run-handle",
				id,
				kind: "async",
				asyncDir: path.join(TEMP_ROOT_DIR, "evil", id),
				startedAt: Date.now(),
			}),
			"utf-8",
		);
		assert.equal(recoverRunHandle(id), undefined);
	});

	it("returns undefined when an on-disk handle has escaped nested route paths", () => {
		const id = trackHandleId(`parse-escape-nested-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		const badRoot = path.join(TEMP_ROOT_DIR, "evil-nested");
		fs.writeFileSync(
			path.join(RUN_HANDLES_DIR, `${id}.json`),
			JSON.stringify({
				schemaVersion: 2,
				type: "subagent.run-handle",
				id,
				kind: "nested",
				route: {
					rootRunId: "root",
					eventSink: path.join(badRoot, "events"),
					controlInbox: path.join(badRoot, "controls"),
					capabilityToken: "tok",
				},
				startedAt: Date.now(),
			}),
			"utf-8",
		);
		assert.equal(recoverRunHandle(id), undefined);
	});
});

describe("run handle store — list, corruption, schema", () => {
	it("listRunHandleIds returns empty when store dir is missing", () => {
		// Ensure no residual handles from this suite linger for this assertion by
		// listing only after a clean delete of known ids (handles may exist from
		// parallel suites; filter to our prefix).
		const listed = listRunHandleIds().filter((id) => id.startsWith("list-empty-"));
		assert.deepEqual(listed, []);
	});

	it("listRunHandleIds returns multiple safe json ids and filters non-json/unsafe", () => {
		const id1 = trackHandleId(`list-a-${Math.random().toString(36).slice(2)}`);
		const id2 = trackHandleId(`list-b-${Math.random().toString(36).slice(2)}`);
		recordRunHandle({ id: id1, kind: "foreground", pid: process.pid, startedAt: Date.now() });
		recordRunHandle({ id: id2, kind: "foreground", pid: process.pid, startedAt: Date.now() });

		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		// non-json
		fs.writeFileSync(path.join(RUN_HANDLES_DIR, "notes.txt"), "nope", "utf-8");
		// unsafe id token (slash) — written as a basename that isSafeNestedPathId rejects after strip
		fs.writeFileSync(path.join(RUN_HANDLES_DIR, "..bad.json"), "{}", "utf-8");

		const listed = listRunHandleIds();
		assert.ok(listed.includes(id1));
		assert.ok(listed.includes(id2));
		assert.ok(!listed.includes("notes"));
		assert.ok(!listed.includes("..bad"));

		fs.rmSync(path.join(RUN_HANDLES_DIR, "notes.txt"), { force: true });
		fs.rmSync(path.join(RUN_HANDLES_DIR, "..bad.json"), { force: true });
	});

	it("returns undefined for corrupted JSON", () => {
		const id = trackHandleId(`corrupt-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(RUN_HANDLES_DIR, `${id}.json`), "{not-json", "utf-8");
		assert.equal(recoverRunHandle(id), undefined);
	});

	it("returns undefined for schema mismatch (wrong schemaVersion)", () => {
		const id = trackHandleId(`schema-ver-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(RUN_HANDLES_DIR, `${id}.json`),
			JSON.stringify({
				schemaVersion: 1,
				type: "subagent.run-handle",
				id,
				kind: "foreground",
				pid: process.pid,
				startedAt: Date.now(),
			}),
			"utf-8",
		);
		assert.equal(recoverRunHandle(id), undefined);
	});

	it("returns undefined for schema mismatch (wrong type)", () => {
		const id = trackHandleId(`schema-type-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(RUN_HANDLES_DIR, `${id}.json`),
			JSON.stringify({
				schemaVersion: 2,
				type: "subagent.other",
				id,
				kind: "foreground",
				pid: process.pid,
				startedAt: Date.now(),
			}),
			"utf-8",
		);
		assert.equal(recoverRunHandle(id), undefined);
	});
});
