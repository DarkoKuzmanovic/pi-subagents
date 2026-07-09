import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ASYNC_OM_DELIVERY_MARKER_FILENAME,
	hasDeliveredIntercomMarker,
	readDeliveredIntercomMarker,
	removeDeliveredIntercomMarker,
	resolveOmDeliveryCandidatePath,
	resolveOmDeliveryMarkerPath,
	writeDeliveredIntercomMarker,
} from "../../src/runs/background/async-om-delivery-marker.ts";

describe("async-om-delivery-marker", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-om-delivery-marker-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("writeDeliveredIntercomMarker", () => {
		it("writes a marker file at <asyncDir>/om-delivery/delivered.json with the expected payload", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const result = writeDeliveredIntercomMarker(asyncDir, {
				runId: "run-a",
				deliveredAt: "2026-07-10T00:00:00.000Z",
			});
			assert.equal(result, true);

			const markerPath = resolveOmDeliveryMarkerPath(asyncDir);
			assert.equal(markerPath, path.join(asyncDir, "om-delivery", ASYNC_OM_DELIVERY_MARKER_FILENAME));
			assert.ok(fs.statSync(markerPath).isFile(), "marker file must exist");

			const payload = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
			assert.equal(payload.schemaVersion, 1);
			assert.equal(payload.runId, "run-a");
			assert.equal(payload.deliveredAt, "2026-07-10T00:00:00.000Z");
		});

		it("is idempotent — a second write replaces the marker without error", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" }), true);
			assert.equal(writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t2" }), true);
			const payload = JSON.parse(fs.readFileSync(resolveOmDeliveryMarkerPath(asyncDir), "utf-8"));
			assert.equal(payload.deliveredAt, "t2");
		});

		it("returns false (no throw) when mkdirSync fails via injected fs ops", () => {
			const asyncDir = path.join(tempDir, "run-a");
			const result = writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" }, {
				mkdirSync: () => {
					throw new Error("simulated mkdir failure");
				},
			});
			assert.equal(result, false);
			assert.equal(fs.existsSync(resolveOmDeliveryMarkerPath(asyncDir)), false);
		});

		it("writes via the durable JSON primitive (canonical, sorted-key, single-line JSON) rather than writeAtomicJson's pretty-printed output", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			const raw = fs.readFileSync(resolveOmDeliveryMarkerPath(asyncDir), "utf-8");
			// writeAtomicJson would emit `{\n  "schemaVersion": 1,\n  ...}` (2-space indented, insertion
			// order). The durable JSON primitive emits compact, alphabetically-sorted-key JSON.
			assert.equal(raw, '{"deliveredAt":"t1","runId":"run-a","schemaVersion":1}');
		});

		it("committed promotion: a fully durable write lands at the readable marker path and cleans up its candidate", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const result = writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			assert.equal(result, true);
			assert.equal(fs.existsSync(resolveOmDeliveryMarkerPath(asyncDir)), true, "promoted marker must exist");
			const payload = JSON.parse(fs.readFileSync(resolveOmDeliveryMarkerPath(asyncDir), "utf-8"));
			assert.deepEqual(payload, { schemaVersion: 1, runId: "run-a", deliveredAt: "t1" });
			assert.equal(
				fs.existsSync(resolveOmDeliveryCandidatePath(asyncDir)),
				false,
				"the staging candidate must be cleaned up once it has been promoted",
			);
		});

		it("degraded candidate is ignored — never promoted, never exposed at the readable marker path, and must not suppress restart retry", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			let fsyncCalls = 0;
			const result = writeDeliveredIntercomMarker(
				asyncDir,
				{ runId: "run-a", deliveredAt: "t1" },
				{
					fsyncSync(fd: number) {
						fsyncCalls += 1;
						if (fsyncCalls === 2) {
							// The candidate write's OWN directory fsync (its 2nd fsyncSync call) is
							// unsupported -> the candidate itself is degraded, never committed.
							const error = new Error("directory fsync unsupported") as Error & { code?: string };
							error.code = "ENOTSUP";
							throw error;
						}
						return fs.fsyncSync(fd);
					},
				},
			);
			assert.equal(result, false, "a degraded candidate must never be reported as a successful delivery marker");
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false, "a degraded candidate must never suppress restart retry");
			assert.equal(
				fs.existsSync(resolveOmDeliveryMarkerPath(asyncDir)),
				false,
				"the readable marker path must never receive a degraded candidate's content",
			);
			assert.equal(fs.existsSync(resolveOmDeliveryCandidatePath(asyncDir)), false, "the stray degraded candidate must be cleaned up");
		});

		it("promotion failure (rename fails) leaves no readable marker and preserves the durably-committed candidate for a safe, at-least-once retry", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const candidatePath = resolveOmDeliveryCandidatePath(asyncDir);
			const markerPath = resolveOmDeliveryMarkerPath(asyncDir);

			const result = writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" }, {
				renameSync(fromPath: string, toPath: string) {
					// Only fail the PROMOTION rename (candidate -> readable marker), not the
					// candidate write's own internal temp-file -> candidate rename.
					if (fromPath === candidatePath && toPath === markerPath) {
						throw new Error("simulated promotion rename failure");
					}
					return fs.renameSync(fromPath, toPath);
				},
			});

			assert.equal(result, false, "a failed promotion must never be reported as a successful delivery marker");
			assert.equal(fs.existsSync(markerPath), false, "the readable marker path must not exist after a failed promotion");
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false, "a failed promotion must not suppress restart retry (candidate-only state must never suppress delivery)");
			assert.equal(fs.existsSync(candidatePath), true, "the durably-committed candidate must be preserved for retry, not deleted by a best-effort cleanup");
			const candidatePayload = JSON.parse(fs.readFileSync(candidatePath, "utf-8"));
			assert.deepEqual(candidatePayload, { schemaVersion: 1, runId: "run-a", deliveredAt: "t1" });

			// Retry: a subsequent call (without the injected failure) must succeed and promote
			// cleanly, proving the preserved candidate did not leave the protocol wedged.
			const retryResult = writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t2" });
			assert.equal(retryResult, true, "retry after a failed promotion must succeed");
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true);
			assert.equal(fs.existsSync(candidatePath), false, "candidate must be cleaned up once the retried promotion succeeds");
			const retriedPayload = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
			assert.deepEqual(retriedPayload, { schemaVersion: 1, runId: "run-a", deliveredAt: "t2" });
		});
	});

	describe("hasDeliveredIntercomMarker", () => {
		it("is false when no marker exists", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false);
		});

		it("is true after a marker is written", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true);
		});

		it("is false when only a non-promoted candidate marker exists (checks ONLY the promoted path)", () => {
			const asyncDir = path.join(tempDir, "run-a");
			const candidatePath = resolveOmDeliveryCandidatePath(asyncDir);
			fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
			fs.writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 1, runId: "run-a", deliveredAt: "t1" }), "utf-8");
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false);
		});
	});

	describe("readDeliveredIntercomMarker", () => {
		it("returns undefined when no marker exists", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(readDeliveredIntercomMarker(fs, asyncDir), undefined);
		});

		it("returns the parsed marker payload when present", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			const payload = readDeliveredIntercomMarker(fs, asyncDir);
			assert.deepEqual(payload, { schemaVersion: 1, runId: "run-a", deliveredAt: "t1" });
		});

		it("returns undefined (does not throw) when the marker is malformed", () => {
			const asyncDir = path.join(tempDir, "run-a");
			const markerDir = path.join(asyncDir, "om-delivery");
			fs.mkdirSync(markerDir, { recursive: true });
			fs.writeFileSync(path.join(markerDir, ASYNC_OM_DELIVERY_MARKER_FILENAME), "{not-json", "utf-8");
			assert.equal(readDeliveredIntercomMarker(fs, asyncDir), undefined);
		});
	});

	describe("removeDeliveredIntercomMarker", () => {
		it("removes the promoted marker", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true);

			assert.equal(removeDeliveredIntercomMarker(fs, asyncDir), true);
			assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false);
		});

		it("is a no-op success when no marker exists", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(removeDeliveredIntercomMarker(fs, asyncDir), true);
		});

		it("also cleans up a stale leftover candidate artifact (e.g. from a crash between a committed candidate write and its promotion)", () => {
			const asyncDir = path.join(tempDir, "run-a");
			const candidatePath = resolveOmDeliveryCandidatePath(asyncDir);
			fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
			fs.writeFileSync(candidatePath, JSON.stringify({ schemaVersion: 1, runId: "run-a", deliveredAt: "t1" }), "utf-8");

			assert.equal(removeDeliveredIntercomMarker(fs, asyncDir), true);
			assert.equal(fs.existsSync(candidatePath), false, "stale candidate artifacts must be cleaned up too");
		});
	});
});
