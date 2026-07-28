/**
 * M6.1 Phase 2B: result-watcher-side outbox retention, receipt validation, and pruning.
 *
 * The result watcher (result-watcher.ts) owns retained-outbox cleanup: an outbox published by
 * the runner (see `async-om-outbox.ts`) is retained on disk under `<asyncDir>/om-outbox/` until
 * a matching, durably-written `AsyncOmCompletionReceiptV1` appears under
 * `<asyncDir>/om-receipts/`. Only then is the outbox pruned. No receipt means retain — this
 * module never deletes an outbox it cannot positively validate.
 *
 * Outbox retention is paired with result.json/intercom retention (see result-watcher.ts): a
 * result.json for an OM-registered run is retained past the ordinary post-intercom unlink point
 * until every outbox for that run has a validated receipt. This is safe across a watcher restart
 * because the completion-dedupe map that guards duplicate intercom delivery is in-memory only —
 * the durable delivery marker (`async-om-delivery-marker.ts`) is the restart-safe substitute:
 * once intercom has been delivered for a retained result, the marker records that fact on disk
 * so a fresh watcher process retains the result (waiting on the outbox) without re-delivering
 * intercom. `scanAsyncRunsWithPendingOutboxes` rediscovers retained outboxes independently of
 * result.json, so retry/prune keeps working even if the result file itself is ever lost.
 */

import * as path from "node:path";
import { computeCanonicalSha256 } from "../../shared/durable-json.ts";
import { ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION, ASYNC_OM_CONSUMER_ID, ASYNC_OM_CONTRACT_VERSION } from "../../shared/types.ts";
import type {
	AsyncChildDeliveryBindingV1,
	AsyncOmCompletionOutboxV1,
	AsyncOmCompletionReceiptV1,
	AsyncOmConsumerRegistrationV1,
	OriginParentBindingV1,
} from "../../shared/types.ts";
import { hasDeliveredIntercomMarker } from "./async-om-delivery-marker.ts";
import { resolveOmOutboxDir } from "./async-om-outbox.ts";

export const ASYNC_OM_RECEIPTS_DIRECTORY = "om-receipts";

export function resolveOmReceiptsDir(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_OM_RECEIPTS_DIRECTORY);
}

export function resolveOmReceiptPath(asyncDir: string, childId: string): string {
	return path.join(resolveOmReceiptsDir(asyncDir), `${childId}.json`);
}

export interface OmRetentionFsOps {
	existsSync(targetPath: string): boolean;
	readFileSync(targetPath: string, encoding: string): string;
	readdirSync(targetPath: string): string[];
	unlinkSync(targetPath: string): void;
}

export function hasPendingOmOutboxes(fsOps: Pick<OmRetentionFsOps, "existsSync" | "readdirSync">, asyncDir: string): boolean {
	const outboxDir = resolveOmOutboxDir(asyncDir);
	if (!fsOps.existsSync(outboxDir)) return false;
	try {
		return fsOps.readdirSync(outboxDir).some((f) => String(f).endsWith(".json"));
	} catch {
		return false;
	}
}

/**
 * Broader "is this asyncDir under any OM tracking at all" gate used to decide whether a
 * completed run should even enter the OM retention path in the first place (see
 * result-watcher.ts). True when there's a pending outbox, an unreceipted delivery marker (a
 * watcher restart must know to keep waiting rather than treat this as a plain non-OM run), or
 * any receipt on disk (a sibling child may still have a pending outbox not yet discovered).
 * Deliberately NOT used to decide when a fully-resolved run's retained result.json/marker may be
 * pruned — receipts are never deleted (see `reconcileOmOutboxesForRun`), so that decision must
 * stay on the narrower `hasPendingOmOutboxes` once reconciliation has run.
 */
export function hasPendingOmOutboxesOrReceipts(
	fsOps: Pick<OmRetentionFsOps, "existsSync" | "readdirSync">,
	asyncDir: string,
): boolean {
	if (hasPendingOmOutboxes(fsOps, asyncDir)) return true;
	if (hasDeliveredIntercomMarker(fsOps, asyncDir)) return true;
	const receiptsDir = resolveOmReceiptsDir(asyncDir);
	if (!fsOps.existsSync(receiptsDir)) return false;
	try {
		return fsOps.readdirSync(receiptsDir).some((f) => String(f).endsWith(".json"));
	} catch {
		return false;
	}
}

function receiptSelfHash(receipt: AsyncOmCompletionReceiptV1): string {
	const { receiptSha256: _receiptSha256, ...rest } = receipt;
	return computeCanonicalSha256(rest).sha256;
}

export type OmReceiptValidation = { valid: true } | { valid: false; reason: string };

// A producer-verifiable well-formedness check only — the watcher does not (and cannot) verify
// that this hash matches anything on the OM consumer's side; it only rejects receipts whose
// inboxSha256 could not possibly be a real sha256 digest (empty, wrong length, non-hex).
const INBOX_SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isWellFormedOriginParentBinding(value: unknown): value is OriginParentBindingV1 {
	return (
		isPlainRecord(value)
		&& isNonEmptyString(value.sessionFile)
		&& isNonEmptyString(value.sessionHeaderId)
		&& isNonEmptyString(value.rootEntryId)
		&& isNonEmptyString(value.launchLeafId)
		&& isNonEmptyString(value.launchCwd)
	);
}

function isWellFormedConsumerRegistration(value: unknown): value is AsyncOmConsumerRegistrationV1 {
	return (
		isPlainRecord(value)
		&& typeof value.consumerId === "string"
		&& typeof value.contractVersion === "number"
		&& isWellFormedOriginParentBinding(value.originParent)
	);
}

function isWellFormedDeliveryBinding(value: unknown): value is AsyncChildDeliveryBindingV1 {
	return (
		isPlainRecord(value)
		&& isNonEmptyString(value.deliveryId)
		&& isNonEmptyString(value.runId)
		&& isNonEmptyString(value.runNonce)
		&& isNonEmptyString(value.childId)
		&& isWellFormedConsumerRegistration(value.consumer)
	);
}

/**
 * Runtime shape guard for a receipt read from disk. A `JSON.parse(...) as AsyncOmCompletionReceiptV1`
 * cast is a compile-time-only claim: it does nothing to stop a receipt whose fields are the wrong
 * *type* (a numeric `importedAt`, a non-string hash, a delivery binding missing its nested
 * consumer/origin-parent fields) from reaching the semantic checks below — and a receipt whose
 * `receiptSha256` was recomputed over that malformed value would sail through the self-hash check
 * too, since a hash only proves internal self-consistency, never shape. This must run before any
 * semantic/hash check, directly against the `unknown` value read off disk.
 */
export function isWellFormedAsyncOmCompletionReceipt(value: unknown): value is AsyncOmCompletionReceiptV1 {
	return (
		isPlainRecord(value)
		&& typeof value.schemaVersion === "number"
		&& typeof value.consumerId === "string"
		&& typeof value.contractVersion === "number"
		&& isWellFormedDeliveryBinding(value.delivery)
		&& isNonEmptyString(value.importedAt)
		&& isNonEmptyString(value.snapshotSha256)
		&& typeof value.snapshotByteLength === "number"
		&& isNonEmptyString(value.outboxSha256)
		// inboxSha256's format (hex/length) is deliberately left to INBOX_SHA256_PATTERN below, not
		// this shape guard, so that check keeps returning its own specific "malformed_inbox_hash"
		// reason; here we only reject a completely non-string value.
		&& typeof value.inboxSha256 === "string"
		&& isNonEmptyString(value.receiptSha256)
	);
}

/**
 * Validate a receipt against its outbox before allowing a prune. Checks (in order): receipt
 * schema version, consumer identity, contract version, exact delivery-binding match (including
 * the nested consumer registration bound at delivery time — not just the top-level delivery ids),
 * the outbox's own snapshot self-consistency (its stated sha256/byteLength must match a fresh hash
 * of its own entries — catches a tampered/corrupt on-disk outbox even when the receipt correctly
 * cites the outbox's stated-but-wrong values), snapshot hash/length match between receipt and
 * outbox, the outbox's own on-disk canonical hash, a well-formed `inboxSha256` (format only — deep
 * verification of `inboxSha256` is the OM consumer's own concern, Phase 3A; the watcher only owns
 * delivery + outbox integrity), and the receipt's self-consistency hash (canonical hash of the
 * receipt with `receiptSha256` itself excluded). A receipt may prune only when every check passes.
 */
export function validateOmReceipt(
	outbox: AsyncOmCompletionOutboxV1,
	outboxCanonicalSha256: string,
	receipt: unknown,
): OmReceiptValidation {
	// Runtime shape guard — not a TypeScript cast. Must run before any field access below: a
	// receipt whose receiptSha256 was recomputed over a malformed value would otherwise pass every
	// semantic/hash check that follows.
	if (!isWellFormedAsyncOmCompletionReceipt(receipt)) return { valid: false, reason: "malformed_receipt_shape" };
	if (receipt.schemaVersion !== ASYNC_OM_COMPLETION_RECEIPT_SCHEMA_VERSION) return { valid: false, reason: "schema_version_mismatch" };
	if (receipt.consumerId !== ASYNC_OM_CONSUMER_ID) return { valid: false, reason: "consumer_id_mismatch" };
	if (receipt.contractVersion !== ASYNC_OM_CONTRACT_VERSION) return { valid: false, reason: "contract_version_mismatch" };
	if (
		receipt.delivery.deliveryId !== outbox.delivery.deliveryId
		|| receipt.delivery.runId !== outbox.delivery.runId
		|| receipt.delivery.runNonce !== outbox.delivery.runNonce
		|| receipt.delivery.childId !== outbox.delivery.childId
	) {
		return { valid: false, reason: "delivery_mismatch" };
	}
	// The top-level delivery ids above bind identity/routing; the nested consumer registration
	// (consumerId/contractVersion/originParent) is the actual authorization binding captured at
	// manifest-registration time and must match exactly too, not just be independently well-formed.
	if (computeCanonicalSha256(receipt.delivery.consumer).sha256 !== computeCanonicalSha256(outbox.delivery.consumer).sha256) {
		return { valid: false, reason: "delivery_consumer_mismatch" };
	}
	const recomputedSnapshot = computeCanonicalSha256(outbox.snapshot.entries);
	if (recomputedSnapshot.sha256 !== outbox.snapshot.sha256 || recomputedSnapshot.byteLength !== outbox.snapshot.byteLength) {
		return { valid: false, reason: "outbox_snapshot_inconsistent" };
	}
	if (receipt.snapshotSha256 !== outbox.snapshot.sha256 || receipt.snapshotByteLength !== outbox.snapshot.byteLength) {
		return { valid: false, reason: "snapshot_mismatch" };
	}
	if (receipt.outboxSha256 !== outboxCanonicalSha256) return { valid: false, reason: "outbox_hash_mismatch" };
	if (!INBOX_SHA256_PATTERN.test(receipt.inboxSha256)) return { valid: false, reason: "malformed_inbox_hash" };
	if (receipt.receiptSha256 !== receiptSelfHash(receipt)) return { valid: false, reason: "receipt_hash_mismatch" };
	return { valid: true };
}

export interface OmReconcileOutcome {
	prunedChildIds: string[];
	retainedChildIds: string[];
}

/**
 * Reconcile every outbox retained for one run: prune those with a valid matching receipt, keep
 * the rest for the next retry pass. The receipt file itself is never deleted — it is the
 * consumer's artifact, not the watcher's.
 */
export function reconcileOmOutboxesForRun(fsOps: OmRetentionFsOps, asyncDir: string): OmReconcileOutcome {
	const outboxDir = resolveOmOutboxDir(asyncDir);
	const prunedChildIds: string[] = [];
	const retainedChildIds: string[] = [];
	if (!fsOps.existsSync(outboxDir)) return { prunedChildIds, retainedChildIds };

	let files: string[];
	try {
		files = fsOps.readdirSync(outboxDir).map(String).filter((f) => f.endsWith(".json"));
	} catch {
		return { prunedChildIds, retainedChildIds };
	}

	for (const file of files) {
		const childId = file.replace(/\.json$/, "");
		const outboxPath = path.join(outboxDir, file);
		try {
			const outbox = JSON.parse(fsOps.readFileSync(outboxPath, "utf-8")) as AsyncOmCompletionOutboxV1;
			const outboxCanonicalSha256 = computeCanonicalSha256(outbox).sha256;

			const receiptPath = resolveOmReceiptPath(asyncDir, childId);
			if (!fsOps.existsSync(receiptPath)) {
				retainedChildIds.push(childId);
				continue;
			}
			const receipt: unknown = JSON.parse(fsOps.readFileSync(receiptPath, "utf-8"));
			const outcome = validateOmReceipt(outbox, outboxCanonicalSha256, receipt);
			if (outcome.valid === false) {
				console.error(`[pi-subagents] async OM receipt for child '${childId}' in '${asyncDir}' failed validation (${outcome.reason}); retaining outbox for retry.`);
				retainedChildIds.push(childId);
				continue;
			}
			try {
				fsOps.unlinkSync(outboxPath);
			} catch (error) {
				if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
			}
			prunedChildIds.push(childId);
		} catch (error) {
			console.error(`[pi-subagents] failed to reconcile async OM outbox '${outboxPath}':`, error);
			retainedChildIds.push(childId);
		}
	}
	return { prunedChildIds, retainedChildIds };
}

/** Durable startup/retry discovery: every run directory (under `asyncRunsRoot`) with at least one retained outbox. */
export function scanAsyncRunsWithPendingOutboxes(
	fsOps: Pick<OmRetentionFsOps, "existsSync" | "readdirSync">,
	asyncRunsRoot: string,
): string[] {
	if (!fsOps.existsSync(asyncRunsRoot)) return [];
	let runIds: string[];
	try {
		runIds = fsOps.readdirSync(asyncRunsRoot).map(String);
	} catch {
		return [];
	}
	const pending: string[] = [];
	for (const runId of runIds) {
		const asyncDir = path.join(asyncRunsRoot, runId);
		if (hasPendingOmOutboxes(fsOps, asyncDir)) pending.push(asyncDir);
	}
	return pending;
}
