/**
 * M6.1 Phase 2B: durable intercom-delivery marker for OM-registered async runs.
 *
 * The watcher's in-memory completion-dedupe map (`state.completionSeen`) does not survive a
 * process restart. To keep intercom delivery exactly-once across a watcher restart for runs
 * with pending OM receipts, the watcher durably records "intercom was already delivered for
 * run R" in this marker file (separate from the receipt — receipt is the OM consumer's
 * acknowledgment; this is the watcher's own delivery checkpoint).
 *
 * Layout:
 *   <asyncDir>/om-delivery/delivered.json            (readable/promoted marker — the ONLY path
 *                                                      hasDeliveredIntercomMarker ever checks)
 *   <asyncDir>/om-delivery/delivered.candidate.json   (non-readable staging path — see
 *                                                      writeDeliveredIntercomMarker doc)
 *
 * Two-stage candidate/promote write:
 *   `writeDurableJson` can still land bytes on disk on a "degraded" outcome (directory fsync
 *   unsupported) even though that outcome must never be trusted as delivery proof. A single-path
 *   write directly to `delivered.json` therefore cannot avoid a window where degraded content is
 *   visible at the one path callers treat as proof. writeDeliveredIntercomMarker instead writes a
 *   durable candidate to the non-readable candidate path first, and only PROMOTES it into the
 *   readable path — via an atomic rename/move, never a second `writeDurableJson` call — once the
 *   candidate write itself reports "committed". See that function's own doc for the full protocol.
 *
 * Lifetime:
 *   - Written by the watcher IMMEDIATELY after a successful intercom delivery attempt for an
 *     OM-registered result.json. Best-effort, non-throwing.
 *   - Unlinked by the watcher only when EVERY retained OM outbox for that run has been
 *     acknowledged (a valid receipt has been validated and the outbox pruned). At that point
 *     result.json, the marker, and all outboxes are pruned together.
 *   - On startup/poll, the marker's presence lets the watcher skip re-delivering intercom for
 *     a retained result.json while still attempting the OM-receipt-driven prune.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { writeDurableJson, type DurableWriteResult, type WriteDurableJsonOptions } from "../../shared/durable-json.ts";

export const ASYNC_OM_DELIVERY_DIRECTORY = "om-delivery";
export const ASYNC_OM_DELIVERY_MARKER_FILENAME = "delivered.json";
export const ASYNC_OM_DELIVERY_CANDIDATE_FILENAME = "delivered.candidate.json";

export interface AsyncOmDeliveryMarkerV1 {
	schemaVersion: typeof ASYNC_OM_DELIVERY_MARKER_SCHEMA_VERSION;
	runId: string;
	deliveredAt: string;
}

export const ASYNC_OM_DELIVERY_MARKER_SCHEMA_VERSION = 1;

export function resolveOmDeliveryDir(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_OM_DELIVERY_DIRECTORY);
}

/** The readable/promoted marker path — the ONLY path hasDeliveredIntercomMarker and
 * readDeliveredIntercomMarker ever consult. */
export function resolveOmDeliveryMarkerPath(asyncDir: string): string {
	return path.join(resolveOmDeliveryDir(asyncDir), ASYNC_OM_DELIVERY_MARKER_FILENAME);
}

/** Non-readable staging path for the two-stage candidate/promote write in
 * writeDeliveredIntercomMarker. Never consulted by hasDeliveredIntercomMarker or
 * readDeliveredIntercomMarker — only a committed write at the promoted path above counts as proof
 * of delivery. */
export function resolveOmDeliveryCandidatePath(asyncDir: string): string {
	return path.join(resolveOmDeliveryDir(asyncDir), ASYNC_OM_DELIVERY_CANDIDATE_FILENAME);
}

/** Writer FS ops allow tests to inject failure modes without touching real fs; forwarded as-is
 * to the durable JSON primitive, which owns directory creation, fsync, and atomic replace. */
export type DeliveryMarkerFsOps = NonNullable<WriteDurableJsonOptions["fsOps"]>;

/**
 * Two-stage candidate/promote write so the READABLE marker path (resolveOmDeliveryMarkerPath) is
 * populated ONLY from a `writeDurableJson` "committed" candidate outcome — never from a
 * "degraded" one (a degraded write can still land bytes on disk; its whole point is that the
 * directory-fsync durability guarantee could not be confirmed, so a caller must never treat its
 * presence as proof).
 *
 *  1. Write a durable candidate to the non-readable candidate path (see
 *     resolveOmDeliveryCandidatePath) via `writeDurableJson`. A degraded outcome here is safe
 *     precisely BECAUSE nothing ever reads the candidate path as delivery proof.
 *  2. Only when that candidate write reports `status === "committed"` do we attempt to promote
 *     it: an atomic rename/move of the candidate onto the readable marker path — NEVER a second
 *     `writeDurableJson` call. A second durable write at the readable path would reopen the exact
 *     hazard step 1 exists to close: a "degraded" outcome there could still leave bytes visible
 *     at the one path callers treat as proof, and cleaning that up is inherently best-effort (the
 *     cleanup call can itself fail). A rename has no analogous quasi-committed state: on a given
 *     filesystem it is atomic — it either fully replaces the readable path with the
 *     already-durably-committed candidate's bytes, or it fails and leaves the readable path
 *     completely untouched.
 *  3. If the rename fails, DO NOT attempt any best-effort cleanup of the readable marker path —
 *     that "cleanup of a possibly-degraded readable file" is exactly the defect this two-stage
 *     rename design removes. A failed rename never populates the readable path (see above), so
 *     there is nothing to clean up there. The candidate, which is still durably committed on
 *     disk, is also left in place (not deleted): the next call to writeDeliveredIntercomMarker
 *     will simply overwrite it with a fresh committed write and retry the rename — a safe,
 *     at-least-once retry. If delivered.json exists after a restart, it can only have originated
 *     from an already-committed candidate that a rename promoted whole.
 *
 * Best-effort, non-throwing throughout. Returns true ONLY when the candidate was durably
 * committed AND the promotion rename succeeded — a false return must NEVER be treated by the
 * caller as proof the marker durably landed, but is also not fatal: the marker is best-effort
 * durability by design (see module header) — the worst case of a missing/uncommitted marker is a
 * one-time intercom redelivery on the next watcher startup, which is bounded by the consumer's
 * idempotency guarantees. Callers must never gate retained-outbox/result-file cleanup on this
 * return value (see result-watcher.ts: retention already depends solely on
 * `hasPendingOmOutboxes`, not on marker-write success).
 */
export function writeDeliveredIntercomMarker(
	asyncDir: string,
	payload: Omit<AsyncOmDeliveryMarkerV1, "schemaVersion">,
	fsOps: Partial<DeliveryMarkerFsOps> = {},
): boolean {
	const fullPayload: AsyncOmDeliveryMarkerV1 = { schemaVersion: ASYNC_OM_DELIVERY_MARKER_SCHEMA_VERSION, ...payload };
	const candidatePath = resolveOmDeliveryCandidatePath(asyncDir);
	const markerPath = resolveOmDeliveryMarkerPath(asyncDir);
	const rm = fsOps.rmSync ?? fs.rmSync;
	const removeQuietly = (targetPath: string): void => {
		try {
			rm(targetPath, { force: true });
		} catch {
			// Best-effort cleanup only; a leftover stray file here is a hygiene concern, never a
			// correctness one (hasDeliveredIntercomMarker never reads the candidate path, and a
			// non-committed marker path is fully rewritten from scratch on the next call).
		}
	};

	let candidateResult: DurableWriteResult;
	try {
		candidateResult = writeDurableJson(candidatePath, fullPayload, { exclusive: false, fsOps });
	} catch {
		return false;
	}
	if (candidateResult.status !== "committed") {
		// A degraded (or otherwise non-committed) candidate must never be promoted — that is
		// exactly the "readable marker treats a degraded write as delivery proof" hazard this
		// two-stage protocol exists to close.
		removeQuietly(candidatePath);
		return false;
	}

	// The candidate is now durably committed. Promote it to the readable path with a single
	// atomic rename/move — NEVER a second `writeDurableJson` call (see doc above for why).
	const rename = fsOps.renameSync ?? fs.renameSync;
	try {
		rename(candidatePath, markerPath);
	} catch {
		// The rename either did not run at all or failed before completing; either way it is
		// atomic, so the readable path is guaranteed untouched — there is nothing to clean up
		// there. Do NOT best-effort-remove markerPath here: that "cleanup of a possibly-degraded
		// readable file" is exactly the defect this rename-based promotion removes. The candidate
		// is still durably committed on disk, so it is deliberately left in place (not deleted):
		// the next writeDeliveredIntercomMarker call safely retries by overwriting it with a fresh
		// committed candidate and re-attempting the rename.
		return false;
	}

	return true;
}

/** Existence check. Cheap; does not parse the marker file. Checks ONLY the promoted (readable)
 * marker path — a candidate that never got promoted (degraded, or a crash between a committed
 * candidate write and its promotion) must never suppress restart retry. */
export function hasDeliveredIntercomMarker(
	fsOps: { existsSync: (targetPath: string) => boolean },
	asyncDir: string,
): boolean {
	return fsOps.existsSync(resolveOmDeliveryMarkerPath(asyncDir));
}

/** Read-and-parse the marker payload. `undefined` for missing OR malformed (never throws). Reads
 * ONLY the promoted (readable) marker path — same rationale as hasDeliveredIntercomMarker. */
export function readDeliveredIntercomMarker(
	fsOps: { existsSync: (targetPath: string) => boolean; readFileSync: (targetPath: string, encoding: string) => string },
	asyncDir: string,
): AsyncOmDeliveryMarkerV1 | undefined {
	const markerPath = resolveOmDeliveryMarkerPath(asyncDir);
	if (!fsOps.existsSync(markerPath)) return undefined;
	try {
		return JSON.parse(fsOps.readFileSync(markerPath, "utf-8")) as AsyncOmDeliveryMarkerV1;
	} catch {
		return undefined;
	}
}

/**
 * Best-effort, non-throwing removal of the marker. Called once every retained OM outbox for a
 * run has been acknowledged and pruned, alongside the retained result.json itself (see
 * result-watcher.ts). A missing marker is not an error. Also cleans up any stale candidate
 * artifact left behind by a crash between a committed candidate write and its promotion — by the
 * time the marker is being removed, the run is fully resolved and no candidate is needed anymore
 * either.
 */
export function removeDeliveredIntercomMarker(
	fsOps: { existsSync: (targetPath: string) => boolean; unlinkSync: (targetPath: string) => void },
	asyncDir: string,
): boolean {
	try {
		const markerPath = resolveOmDeliveryMarkerPath(asyncDir);
		if (fsOps.existsSync(markerPath)) fsOps.unlinkSync(markerPath);
		const candidatePath = resolveOmDeliveryCandidatePath(asyncDir);
		if (fsOps.existsSync(candidatePath)) fsOps.unlinkSync(candidatePath);
		return true;
	} catch {
		return false;
	}
}
