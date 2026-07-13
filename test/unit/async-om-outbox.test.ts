import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { computeCanonicalSha256 } from "../../src/shared/durable-json.ts";
import { ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION, ASYNC_OM_CONSUMER_ID, ASYNC_OM_CONTRACT_VERSION } from "../../src/shared/types.ts";
import type { AsyncOmLaunchManifestV1 } from "../../src/shared/types.ts";
import {
	allocateDynamicOmSlots,
	ASYNC_OM_OUTBOX_DIRECTORY,
	buildCompletionOutbox,
	buildOmDeliveryBinding,
	captureSessionSnapshotEntries,
	loadOmManifest,
	publishChildOmOutbox,
	publishCompletionOutbox,
	resolveOmOutboxPath,
} from "../../src/runs/background/async-om-outbox.ts";

function makeManifest(overrides: Partial<AsyncOmLaunchManifestV1> = {}): AsyncOmLaunchManifestV1 {
	return {
		schemaVersion: 1,
		runId: "run-7",
		runNonce: "nonce-abc",
		consumer: {
			consumerId: ASYNC_OM_CONSUMER_ID,
			contractVersion: ASYNC_OM_CONTRACT_VERSION,
			originParent: {
				sessionFile: "/tmp/parent.jsonl",
				sessionHeaderId: "header-1",
				rootEntryId: "root-1",
				launchLeafId: "leaf-1",
				launchCwd: "/repo",
			},
		},
		nextChildSequence: 2,
		childSlots: {
			"root/0/sequential/0": { logicalChildKey: "root/0/sequential/0", childId: "c000001", agentName: "worker", allocation: "static" },
		},
		...overrides,
	};
}

describe("async-om-outbox", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-om-outbox-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loadOmManifest", () => {
		it("returns undefined for an undefined path", () => {
			assert.equal(loadOmManifest(undefined), undefined);
		});

		it("returns undefined when the file is missing", () => {
			assert.equal(loadOmManifest(path.join(tempDir, "missing.json")), undefined);
		});

		it("returns undefined for malformed JSON", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			fs.writeFileSync(manifestPath, "{not-json", "utf-8");
			assert.equal(loadOmManifest(manifestPath), undefined);
		});

		it("returns undefined when required fields are missing", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1 }), "utf-8");
			assert.equal(loadOmManifest(manifestPath), undefined);
		});

		it("loads a well-formed manifest", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			fs.writeFileSync(manifestPath, JSON.stringify(makeManifest()), "utf-8");
			const loaded = loadOmManifest(manifestPath);
			assert.equal(loaded?.runId, "run-7");
			assert.equal(loaded?.childSlots["root/0/sequential/0"]?.childId, "c000001");
		});
	});

	describe("buildOmDeliveryBinding", () => {
		it("builds a delivery binding embedding the manifest's consumer", () => {
			const manifest = makeManifest();
			const delivery = buildOmDeliveryBinding(manifest, "c000002");
			assert.equal(delivery.deliveryId, "om-async-v1:nonce-abc:c000002");
			assert.equal(delivery.runId, "run-7");
			assert.equal(delivery.runNonce, "nonce-abc");
			assert.equal(delivery.childId, "c000002");
			assert.deepEqual(delivery.consumer, manifest.consumer);
		});
	});

	describe("allocateDynamicOmSlots", () => {
		it("durably mints sequential childIds and reopens the manifest before returning", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			fs.writeFileSync(manifestPath, JSON.stringify(makeManifest()), "utf-8");
			fs.chmodSync(manifestPath, 0o600);

			const allocation = allocateDynamicOmSlots(manifestPath, ["root/1/dynamic/0", "root/1/dynamic/1"], "reviewer");
			assert.ok(allocation);
			assert.deepEqual(allocation.slots.map((s) => s.childId), ["c000002", "c000003"]);
			assert.deepEqual(allocation.slots.map((s) => s.allocation), ["dynamic", "dynamic"]);
			assert.equal(allocation.manifest.nextChildSequence, 4);

			const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as AsyncOmLaunchManifestV1;
			assert.equal(onDisk.nextChildSequence, 4);
			assert.equal(onDisk.childSlots["root/1/dynamic/0"]?.childId, "c000002");
			assert.equal(onDisk.childSlots["root/1/dynamic/1"]?.childId, "c000003");
			// The original static slot must survive the reopen.
			assert.equal(onDisk.childSlots["root/0/sequential/0"]?.childId, "c000001");
		});

		it("is idempotent for a logical key that already has a slot", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			fs.writeFileSync(manifestPath, JSON.stringify(makeManifest()), "utf-8");

			const first = allocateDynamicOmSlots(manifestPath, ["root/1/dynamic/0"], "reviewer");
			assert.ok(first);
			const second = allocateDynamicOmSlots(manifestPath, ["root/1/dynamic/0"], "reviewer");
			assert.ok(second);
			assert.equal(second.slots[0]?.childId, first.slots[0]?.childId);
			assert.equal(second.manifest.nextChildSequence, first.manifest.nextChildSequence);
		});

		it("returns undefined when the manifest file cannot be read", () => {
			const allocation = allocateDynamicOmSlots(path.join(tempDir, "missing.json"), ["root/1/dynamic/0"], "reviewer");
			assert.equal(allocation, undefined);
		});

		it("returns undefined and leaves the on-disk manifest untouched when the durable write is not committed", () => {
			const manifestPath = path.join(tempDir, "manifest.json");
			const original = makeManifest();
			fs.writeFileSync(manifestPath, JSON.stringify(original), "utf-8");

			const allocation = allocateDynamicOmSlots(manifestPath, ["root/1/dynamic/0"], "reviewer", {
				fsOps: {
					renameSync: () => {
						throw new Error("simulated rename failure");
					},
				},
			});
			assert.equal(allocation, undefined);
			const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as AsyncOmLaunchManifestV1;
			assert.equal(onDisk.nextChildSequence, original.nextChildSequence);
		});
	});

	describe("captureSessionSnapshotEntries", () => {
		it("parses newline-delimited JSON entries, skipping blank lines", () => {
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"a"}\n\n{"type":"b"}\n', "utf-8");
			assert.deepEqual(captureSessionSnapshotEntries(sessionFile), [{ type: "a" }, { type: "b" }]);
		});

		it("returns undefined when the session file is missing", () => {
			assert.equal(captureSessionSnapshotEntries(path.join(tempDir, "missing.jsonl")), undefined);
		});

		it("returns undefined when any line is malformed", () => {
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"a"}\nnot-json\n', "utf-8");
			assert.equal(captureSessionSnapshotEntries(sessionFile), undefined);
		});
	});

	describe("buildCompletionOutbox", () => {
		it("hashes the snapshot entries using the shared canonical hash", () => {
			const manifest = makeManifest();
			const delivery = buildOmDeliveryBinding(manifest, "c000001");
			const entries = [{ type: "message" }];
			const outbox = buildCompletionOutbox(delivery, entries, "2026-07-10T00:00:00.000Z");
			const expected = computeCanonicalSha256(entries);
			assert.equal(outbox.schemaVersion, ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION);
			assert.equal(outbox.snapshot.sha256, expected.sha256);
			assert.equal(outbox.snapshot.byteLength, expected.byteLength);
			assert.deepEqual(outbox.snapshot.entries, entries);
			assert.equal(outbox.completedAt, "2026-07-10T00:00:00.000Z");
			assert.deepEqual(outbox.delivery, delivery);
		});
	});

	describe("publishCompletionOutbox", () => {
		it("writes the outbox under an owner-only directory, keyed by childId", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true, mode: 0o755 });
			const manifest = makeManifest();
			const delivery = buildOmDeliveryBinding(manifest, "c000001");
			const outbox = buildCompletionOutbox(delivery, [{ type: "message" }]);

			const result = publishCompletionOutbox(asyncDir, outbox);
			assert.equal(result?.status, "committed");

			const outboxPath = resolveOmOutboxPath(asyncDir, "c000001");
			assert.equal(outboxPath, path.join(asyncDir, ASYNC_OM_OUTBOX_DIRECTORY, "c000001.json"));
			assert.equal(fs.statSync(path.dirname(outboxPath)).mode & 0o777, 0o700);
			const onDisk = JSON.parse(fs.readFileSync(outboxPath, "utf-8"));
			assert.equal(onDisk.delivery.childId, "c000001");
		});
	});

	describe("publishChildOmOutbox", () => {
		it("resolves the slot, captures the session snapshot, and durably publishes it", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"a"}\n', "utf-8");
			const manifest = makeManifest();

			const published = publishChildOmOutbox(manifest, "root/0/sequential/0", sessionFile, asyncDir);
			assert.equal(published, true);
			const outboxPath = resolveOmOutboxPath(asyncDir, "c000001");
			assert.ok(fs.existsSync(outboxPath));
		});

		it("warns and retains a degraded completion outbox for delivery retry", () => {
			const asyncDir = path.join(tempDir, "async-run");
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(sessionFile, '{"type":"a"}\n', "utf-8");
			const warnings: string[] = [];
			const originalWarn = console.warn;
			let fsyncCalls = 0;
			console.warn = (message: unknown) => warnings.push(String(message));
			try {
				const published = publishChildOmOutbox(makeManifest(), "root/0/sequential/0", sessionFile, asyncDir, {
					fsOps: {
						fsyncSync(fd) {
							fsyncCalls += 1;
							if (fsyncCalls === 2) {
								const error = new Error("directory fsync unsupported") as Error & { code?: string };
								error.code = "ENOTSUP";
								throw error;
							}
							fs.fsyncSync(fd);
						},
					},
				});
				assert.equal(published, false, "a degraded outbox is never reported as committed");
				assert.deepEqual(warnings, ["[pi-subagents] OM completion outbox for child c000001 not committed (status=degraded); treating as undelivered."]);
			} finally {
				console.warn = originalWarn;
			}

			const outboxPath = resolveOmOutboxPath(asyncDir, "c000001");
			assert.ok(fs.existsSync(outboxPath), "the retained outbox remains available for the result watcher's delivery retry");
			assert.equal(JSON.parse(fs.readFileSync(outboxPath, "utf-8")).delivery.childId, "c000001");
		});

		it("no-ops without publishing when the manifest is absent", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(publishChildOmOutbox(undefined, "root/0/sequential/0", path.join(tempDir, "s.jsonl"), asyncDir), false);
			assert.equal(fs.existsSync(path.join(asyncDir, ASYNC_OM_OUTBOX_DIRECTORY)), false);
		});

		it("no-ops when the logical key has no registered slot", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(tempDir, "session.jsonl");
			fs.writeFileSync(sessionFile, '{"type":"a"}\n', "utf-8");
			const manifest = makeManifest();
			assert.equal(publishChildOmOutbox(manifest, "root/9/sequential/0", sessionFile, asyncDir), false);
		});

		it("no-ops when the session file cannot be read", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const manifest = makeManifest();
			assert.equal(publishChildOmOutbox(manifest, "root/0/sequential/0", path.join(tempDir, "missing.jsonl"), asyncDir), false);
			assert.equal(fs.existsSync(path.join(asyncDir, ASYNC_OM_OUTBOX_DIRECTORY)), false);
		});

		it("no-ops when no sessionFile was provided", () => {
			const asyncDir = path.join(tempDir, "async-run");
			fs.mkdirSync(asyncDir, { recursive: true });
			const manifest = makeManifest();
			assert.equal(publishChildOmOutbox(manifest, "root/0/sequential/0", undefined, asyncDir), false);
		});
	});
});
