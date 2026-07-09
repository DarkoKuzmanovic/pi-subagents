import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION,
	ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION,
	ASYNC_OM_CONSUMER_ID,
	ASYNC_OM_CONTRACT_VERSION,
	ASYNC_OM_DELIVERY_PREFIX,
	type AsyncChildDeliveryBindingV1,
	type AsyncOmCompletionOutboxV1,
	type AsyncOmCompletionReceiptV1,
	type AsyncOmConsumerRegistrationV1,
	type OriginParentBindingV1,
} from "../../src/shared/types.ts";

describe("async OM durable-completion protocol types", () => {
	it("exports the expected contract constants", () => {
		assert.equal(ASYNC_OM_CONSUMER_ID, "observational-memory");
		assert.equal(ASYNC_OM_CONTRACT_VERSION, 1);
		assert.equal(ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION, 1);
		assert.equal(ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION, 1);
		assert.equal(ASYNC_OM_DELIVERY_PREFIX, "om-async-v1");
	});

	it("supports parent binding, delivery binding, outbox, and receipt shapes", () => {
		const originParent: OriginParentBindingV1 = {
			sessionFile: "/tmp/parent.jsonl",
			sessionHeaderId: "session-header-1",
			rootEntryId: "root-entry-1",
			launchLeafId: "leaf-entry-1",
			launchCwd: "/repo",
		};
		const consumer: AsyncOmConsumerRegistrationV1 = {
			consumerId: ASYNC_OM_CONSUMER_ID,
			contractVersion: ASYNC_OM_CONTRACT_VERSION,
			originParent,
		};
		const delivery: AsyncChildDeliveryBindingV1 = {
			deliveryId: `${ASYNC_OM_DELIVERY_PREFIX}:550e8400-e29b-41d4-a716-446655440000:child-7`,
			runId: "run-7",
			runNonce: "550e8400-e29b-41d4-a716-446655440000",
			childId: "child-7",
			consumer,
		};
		const outbox: AsyncOmCompletionOutboxV1 = {
			schemaVersion: ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION,
			delivery,
			completedAt: "2026-07-09T12:00:00.000Z",
			snapshot: {
				entries: [{ type: "message", role: "assistant" }],
				sha256: "a".repeat(64),
				byteLength: 1234,
			},
		};
		const receipt: AsyncOmCompletionReceiptV1 = {
			schemaVersion: ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION,
			consumerId: ASYNC_OM_CONSUMER_ID,
			contractVersion: ASYNC_OM_CONTRACT_VERSION,
			delivery,
			importedAt: "2026-07-09T12:00:01.000Z",
			snapshotSha256: outbox.snapshot.sha256,
			snapshotByteLength: outbox.snapshot.byteLength,
			outboxSha256: "b".repeat(64),
			inboxSha256: "d".repeat(64),
			receiptSha256: "c".repeat(64),
		};

		assert.equal(receipt.delivery.consumer.originParent.sessionHeaderId, "session-header-1");
		assert.equal(receipt.snapshotSha256, outbox.snapshot.sha256);
		assert.equal(receipt.snapshotByteLength, outbox.snapshot.byteLength);
		assert.equal(receipt.inboxSha256, "d".repeat(64));
	});
});
