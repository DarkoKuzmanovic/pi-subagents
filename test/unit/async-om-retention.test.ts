import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { computeCanonicalSha256 } from "../../src/shared/durable-json.ts";
import { ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION, ASYNC_OM_CONSUMER_ID, ASYNC_OM_CONTRACT_VERSION } from "../../src/shared/types.ts";
import type { AsyncChildDeliveryBindingV1, AsyncOmCompletionOutboxV1, AsyncOmCompletionReceiptV1 } from "../../src/shared/types.ts";
import { buildCompletionOutbox, publishCompletionOutbox, resolveOmOutboxPath } from "../../src/runs/background/async-om-outbox.ts";
import { writeDeliveredIntercomMarker } from "../../src/runs/background/async-om-delivery-marker.ts";
import {
ASYNC_OM_RECEIPTS_DIRECTORY,
	hasPendingOmOutboxes,
	hasPendingOmOutboxesOrReceipts,
	reconcileOmOutboxesForRun,
	resolveOmReceiptPath,
resolveOmReceiptsDir,
	scanAsyncRunsWithPendingOutboxes,
	validateOmReceipt,
} from "../../src/runs/background/async-om-retention.ts";

function makeDelivery(childId = "c000001"): AsyncChildDeliveryBindingV1 {
	return {
		deliveryId: `om-async-v1:nonce-abc:${childId}`,
		runId: "run-7",
		runNonce: "nonce-abc",
		childId,
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
	};
}

function receiptSelfHash(receipt: Omit<AsyncOmCompletionReceiptV1, "receiptSha256">): string {
	return computeCanonicalSha256(receipt).sha256;
}

function makeValidReceipt(outbox: AsyncOmCompletionOutboxV1, outboxCanonicalSha256: string): AsyncOmCompletionReceiptV1 {
	const withoutHash = {
		schemaVersion: 1 as const,
		consumerId: ASYNC_OM_CONSUMER_ID,
		contractVersion: ASYNC_OM_CONTRACT_VERSION,
		delivery: outbox.delivery,
		importedAt: "2026-07-10T00:00:01.000Z",
		snapshotSha256: outbox.snapshot.sha256,
		snapshotByteLength: outbox.snapshot.byteLength,
		outboxSha256: outboxCanonicalSha256,
		inboxSha256: "d".repeat(64),
	};
	return { ...withoutHash, receiptSha256: receiptSelfHash(withoutHash) };
}

function makeReceiptWithOverrides(
	outbox: AsyncOmCompletionOutboxV1,
	outboxCanonicalSha256: string,
	overrides: Partial<Omit<AsyncOmCompletionReceiptV1, "receiptSha256">>,
): AsyncOmCompletionReceiptV1 {
	// Unlike makeValidReceipt's simple field-set, this bakes overrides in BEFORE computing the
	// self-hash, so the receipt's own receiptSha256 stays internally consistent with the override.
	// That isolates the specific field-level check under test from the (separate, blanket)
	// receipt-self-hash check, which would otherwise incidentally catch any stale-hash mutation.
	const withoutHash = {
		schemaVersion: 1 as const,
		consumerId: ASYNC_OM_CONSUMER_ID,
		contractVersion: ASYNC_OM_CONTRACT_VERSION,
		delivery: outbox.delivery,
		importedAt: "2026-07-10T00:00:01.000Z",
		snapshotSha256: outbox.snapshot.sha256,
		snapshotByteLength: outbox.snapshot.byteLength,
		outboxSha256: outboxCanonicalSha256,
		inboxSha256: "d".repeat(64),
		...overrides,
	};
	return { ...withoutHash, receiptSha256: receiptSelfHash(withoutHash) };
}

function makeReceiptWithRawOverrides(
	outbox: AsyncOmCompletionOutboxV1,
	outboxCanonicalSha256: string,
	overrides: Record<string, unknown>,
): unknown {
	// Unlike makeReceiptWithOverrides (which is type-constrained to valid field types),
	// this accepts arbitrary raw values so tests can build a receipt whose SHAPE is malformed
	// (wrong field type, missing nested field) while still recomputing receiptSha256 over that
	// malformed value. That proves the runtime schema guard rejects it independently of the
	// self-hash check, which would otherwise pass (the hash only proves internal consistency,
	// not that the fields are well-typed).
	const withoutHash: Record<string, unknown> = {
		schemaVersion: 1,
		consumerId: ASYNC_OM_CONSUMER_ID,
		contractVersion: ASYNC_OM_CONTRACT_VERSION,
		delivery: outbox.delivery,
		importedAt: "2026-07-10T00:00:01.000Z",
		snapshotSha256: outbox.snapshot.sha256,
		snapshotByteLength: outbox.snapshot.byteLength,
		outboxSha256: outboxCanonicalSha256,
		inboxSha256: "d".repeat(64),
		...overrides,
	};
	return { ...withoutHash, receiptSha256: computeCanonicalSha256(withoutHash).sha256 };
}

describe("async-om-retention", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-om-retention-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("validateOmReceipt", () => {
		it("accepts a receipt matching the outbox exactly", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: true });
		});

		it("rejects a mismatched consumer id", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = { ...makeValidReceipt(outbox, outboxHash), consumerId: "someone-else" as typeof ASYNC_OM_CONSUMER_ID };
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a mismatched contract version", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = { ...makeValidReceipt(outbox, outboxHash), contractVersion: 99 as typeof ASYNC_OM_CONTRACT_VERSION };
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a delivery-binding mismatch", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			receipt.delivery = { ...receipt.delivery, childId: "c999999" };
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a snapshot hash or byteLength mismatch", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			receipt.snapshotByteLength = receipt.snapshotByteLength + 1;
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a stale outbox hash (outbox content changed since receipt)", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, "stale-hash");
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a missing inbox hash", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			receipt.inboxSha256 = "";
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});

		it("rejects a receipt with the wrong schemaVersion", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeReceiptWithOverrides(outbox, outboxHash, {
				schemaVersion: 99 as unknown as typeof ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION,
			});
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "schema_version_mismatch" });
		});

		it("rejects a delivery.consumer binding mismatch even when top-level delivery ids all match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const baseline = makeReceiptWithOverrides(outbox, outboxHash, {});
			const receipt = makeReceiptWithOverrides(outbox, outboxHash, {
				delivery: {
					...baseline.delivery,
					consumer: {
						...baseline.delivery.consumer,
						originParent: { ...baseline.delivery.consumer.originParent, sessionFile: "/tmp/a-different-parent.jsonl" },
					},
				},
			});
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "delivery_consumer_mismatch" });
		});

		it("rejects a malformed (non-hex, wrong-length) inbox hash", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeReceiptWithOverrides(outbox, outboxHash, { inboxSha256: "not-a-real-sha256" });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_inbox_hash" });
		});

		it("rejects when the outbox's own stated snapshot hash is inconsistent with its entries (tampered/corrupt outbox)", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const tamperedOutbox: AsyncOmCompletionOutboxV1 = {
				...outbox,
				snapshot: { ...outbox.snapshot, sha256: "0".repeat(64) },
			};
			const outboxHash = computeCanonicalSha256(tamperedOutbox).sha256;
			// The receipt "correctly" cites the tampered outbox's own (self-inconsistent) stated hash —
			// only cross-checking receipt.outboxSha256 against the outbox's whole-file hash would miss this.
			const receipt = makeValidReceipt(tamperedOutbox, outboxHash);
			assert.deepEqual(validateOmReceipt(tamperedOutbox, outboxHash, receipt), { valid: false, reason: "outbox_snapshot_inconsistent" });
		});

		it("rejects when the outbox's own stated snapshot byteLength is inconsistent with its entries", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const tamperedOutbox: AsyncOmCompletionOutboxV1 = {
				...outbox,
				snapshot: { ...outbox.snapshot, byteLength: outbox.snapshot.byteLength + 1 },
			};
			const outboxHash = computeCanonicalSha256(tamperedOutbox).sha256;
			const receipt = makeValidReceipt(tamperedOutbox, outboxHash);
			assert.deepEqual(validateOmReceipt(tamperedOutbox, outboxHash, receipt), { valid: false, reason: "outbox_snapshot_inconsistent" });
		});

		it("rejects a tampered receipt self-hash", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			receipt.receiptSha256 = "0".repeat(64);
			assert.equal(validateOmReceipt(outbox, outboxHash, receipt).valid, false);
		});
	});

	describe("validateOmReceipt runtime schema guard (recomputed self-hash, proves schema check independent of hash check)", () => {
		it("rejects a non-string importedAt even when receiptSha256 is recomputed to match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { importedAt: 1752105601000 });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_receipt_shape" });
		});

		it("rejects a non-string outboxSha256 even when receiptSha256 is recomputed to match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { outboxSha256: 12345 });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_receipt_shape" });
		});

		it("rejects a non-string snapshotSha256 even when receiptSha256 is recomputed to match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { snapshotSha256: null });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_receipt_shape" });
		});

		it("rejects a missing delivery.consumer.originParent binding even when receiptSha256 is recomputed to match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const malformedDelivery = {
				...outbox.delivery,
				consumer: { consumerId: ASYNC_OM_CONSUMER_ID, contractVersion: ASYNC_OM_CONTRACT_VERSION },
			};
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { delivery: malformedDelivery });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_receipt_shape" });
		});

		it("rejects a non-string delivery.childId even when receiptSha256 is recomputed to match", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			const malformedDelivery = { ...outbox.delivery, childId: 12345 };
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { delivery: malformedDelivery });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, receipt), { valid: false, reason: "malformed_receipt_shape" });
		});

		it("rejects a receipt that is not an object at all", () => {
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			const outboxHash = computeCanonicalSha256(outbox).sha256;
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, null), { valid: false, reason: "malformed_receipt_shape" });
			assert.deepEqual(validateOmReceipt(outbox, outboxHash, "not-a-receipt"), { valid: false, reason: "malformed_receipt_shape" });
		});
	});

	describe("hasPendingOmOutboxes / scanAsyncRunsWithPendingOutboxes", () => {
		it("is false when no om-outbox directory exists", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(hasPendingOmOutboxes(fs, asyncDir), false);
		});

		it("finds only run directories with a non-empty om-outbox", () => {
			const runsRoot = path.join(tempDir, "runs");
			const runA = path.join(runsRoot, "run-a");
			const runB = path.join(runsRoot, "run-b");
			fs.mkdirSync(runA, { recursive: true });
			fs.mkdirSync(runB, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(runA, outbox);

			assert.deepEqual(scanAsyncRunsWithPendingOutboxes(fs, runsRoot), [runA]);
		});

		it("returns an empty list when the runs root does not exist", () => {
			assert.deepEqual(scanAsyncRunsWithPendingOutboxes(fs, path.join(tempDir, "missing-root")), []);
		});
	});

	describe("reconcileOmOutboxesForRun", () => {
		it("retains an outbox with no receipt on disk", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(asyncDir, outbox);

			const outcome = reconcileOmOutboxesForRun(fs, asyncDir);
			assert.deepEqual(outcome.prunedChildIds, []);
			assert.deepEqual(outcome.retainedChildIds, ["c000001"]);
			assert.ok(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")));
		});

		it("prunes an outbox once a matching valid receipt is present", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(asyncDir, outbox);
			const outboxOnDisk = JSON.parse(fs.readFileSync(resolveOmOutboxPath(asyncDir, "c000001"), "utf-8"));
			const outboxHash = computeCanonicalSha256(outboxOnDisk).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);

			fs.mkdirSync(path.join(asyncDir, ASYNC_OM_RECEIPTS_DIRECTORY), { recursive: true });
			fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify(receipt), "utf-8");

			const outcome = reconcileOmOutboxesForRun(fs, asyncDir);
			assert.deepEqual(outcome.prunedChildIds, ["c000001"]);
			assert.deepEqual(outcome.retainedChildIds, []);
			assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), false);
			// The receipt itself is the consumer's artifact; the watcher must not delete it.
			assert.ok(fs.existsSync(resolveOmReceiptPath(asyncDir, "c000001")));
		});

		it("retains an outbox when the on-disk receipt has a well-formed hash but a malformed shape (e.g. a numeric importedAt)", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(asyncDir, outbox);
			const outboxOnDisk = JSON.parse(fs.readFileSync(resolveOmOutboxPath(asyncDir, "c000001"), "utf-8"));
			const outboxHash = computeCanonicalSha256(outboxOnDisk).sha256;
			// The receipt's own self-hash is recomputed over the malformed value, so a hash-only check
			// would pass this receipt — proving this test exercises the schema guard, not the hash check.
			const receipt = makeReceiptWithRawOverrides(outbox, outboxHash, { importedAt: 1752105601000 });

			fs.mkdirSync(path.join(asyncDir, ASYNC_OM_RECEIPTS_DIRECTORY), { recursive: true });
			fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify(receipt), "utf-8");

			const originalConsoleError = console.error;
			console.error = () => {};
			let outcome: ReturnType<typeof reconcileOmOutboxesForRun>;
			try {
				outcome = reconcileOmOutboxesForRun(fs, asyncDir);
			} finally {
				console.error = originalConsoleError;
			}
			assert.deepEqual(outcome.prunedChildIds, []);
			assert.deepEqual(outcome.retainedChildIds, ["c000001"]);
			assert.ok(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), "outbox must remain retained when the receipt shape is malformed");
		});

		it("retains (does not prune) when the receipt fails validation", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(asyncDir, outbox);
			const outboxOnDisk = JSON.parse(fs.readFileSync(resolveOmOutboxPath(asyncDir, "c000001"), "utf-8"));
			const outboxHash = computeCanonicalSha256(outboxOnDisk).sha256;
			const receipt = makeValidReceipt(outbox, outboxHash);
			receipt.snapshotSha256 = "tampered";

			fs.mkdirSync(path.join(asyncDir, ASYNC_OM_RECEIPTS_DIRECTORY), { recursive: true });
			fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify(receipt), "utf-8");

			const originalError = console.error;
			console.error = () => {};
			let outcome: ReturnType<typeof reconcileOmOutboxesForRun>;
			try {
				outcome = reconcileOmOutboxesForRun(fs, asyncDir);
			} finally {
				console.error = originalError;
			}
			assert.deepEqual(outcome.prunedChildIds, []);
			assert.deepEqual(outcome.retainedChildIds, ["c000001"]);
			assert.ok(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")));
		});

		it("returns empty outcome when there is no om-outbox directory", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.deepEqual(reconcileOmOutboxesForRun(fs, asyncDir), { prunedChildIds: [], retainedChildIds: [] });
		});
	});

	describe("hasPendingOmOutboxesOrReceipts", () => {
		it("is false when neither outboxes nor receipts exist", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(hasPendingOmOutboxesOrReceipts(fs, asyncDir), false);
		});

		it("is true when an outbox exists", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			const outbox = buildCompletionOutbox(makeDelivery(), [{ type: "a" }]);
			publishCompletionOutbox(asyncDir, outbox);
			assert.equal(hasPendingOmOutboxesOrReceipts(fs, asyncDir), true);
		});

		it("is true when an unreceipted delivery marker exists (a watcher restart must know to keep waiting)", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			writeDeliveredIntercomMarker(asyncDir, { runId: "run-a", deliveredAt: "t1" });
			assert.equal(hasPendingOmOutboxesOrReceipts(fs, asyncDir), true);
		});

		it("is true when a receipt exists for a different child (other outbox pending)", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.mkdirSync(resolveOmReceiptsDir(asyncDir), { recursive: true });
			fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c999999"), JSON.stringify({ schemaVersion: 1 }), "utf-8");
			assert.equal(hasPendingOmOutboxesOrReceipts(fs, asyncDir), true);
		});

		it("is false only when there are zero outboxes, zero receipts, and no delivery marker", () => {
			const asyncDir = path.join(tempDir, "run-a");
			fs.mkdirSync(asyncDir, { recursive: true });
			assert.equal(hasPendingOmOutboxesOrReceipts(fs, asyncDir), false);
		});
	});
});
