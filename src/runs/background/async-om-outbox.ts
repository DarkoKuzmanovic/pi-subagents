/**
 * M6.1 Phase 2B: runner-side durable child-completion outbox.
 *
 * The detached runner (subagent-runner.ts) is the sole owner of:
 *  - dynamic-fanout slot allocation (durably reopening the launch manifest before a
 *    materialized batch starts, so each dynamic child gets a stable structural slot), and
 *  - terminal snapshot capture + durable `AsyncOmCompletionOutboxV1` publication for every
 *    top-level registered child (static or dynamic).
 *
 * Every function here is best-effort and side-effect-isolated: a missing/unreadable manifest,
 * an unregistered logical key, or an unreadable session file all resolve to a no-op rather than
 * throwing, so a durability failure in the OM protocol can never corrupt ordinary async
 * status/result behavior. Retry for a failed *delivery* (an outbox published but never
 * receipted) is the result watcher's job (see `async-om-retention.ts`); retry for a failed
 * *manifest reopen* falls back to running the batch without OM registration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { computeCanonicalSha256, writeDurableJson, type DurableWriteResult, type WriteDurableJsonOptions } from "../../shared/durable-json.ts";
import { ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION } from "../../shared/types.ts";
import type {
	AsyncChildDeliveryBindingV1,
	AsyncChildSlotV1,
	AsyncOmCompletionOutboxV1,
	AsyncOmLaunchManifestV1,
} from "../../shared/types.ts";
import { generateDeliveryId } from "./async-launch-binding.ts";

export const ASYNC_OM_OUTBOX_DIRECTORY = "om-outbox";

export function resolveOmOutboxDir(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_OM_OUTBOX_DIRECTORY);
}

export function resolveOmOutboxPath(asyncDir: string, childId: string): string {
	return path.join(resolveOmOutboxDir(asyncDir), `${childId}.json`);
}

/** Load and minimally schema-check a launch manifest from disk. `undefined` on any failure. */
export function loadOmManifest(manifestPath: string | undefined): AsyncOmLaunchManifestV1 | undefined {
	if (!manifestPath) return undefined;
	try {
		const raw = fs.readFileSync(manifestPath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<AsyncOmLaunchManifestV1>;
		if (
			parsed.schemaVersion !== 1
			|| typeof parsed.runId !== "string"
			|| typeof parsed.runNonce !== "string"
			|| typeof parsed.nextChildSequence !== "number"
			|| typeof parsed.childSlots !== "object"
			|| parsed.childSlots === null
			|| typeof parsed.consumer !== "object"
			|| parsed.consumer === null
		) {
			return undefined;
		}
		return parsed as AsyncOmLaunchManifestV1;
	} catch {
		return undefined;
	}
}

export function buildOmDeliveryBinding(manifest: AsyncOmLaunchManifestV1, childId: string): AsyncChildDeliveryBindingV1 {
	return {
		deliveryId: generateDeliveryId(manifest.runNonce, childId),
		runId: manifest.runId,
		runNonce: manifest.runNonce,
		childId,
		consumer: manifest.consumer,
	};
}

function formatChildId(sequence: number): string {
	return `c${String(sequence).padStart(6, "0")}`;
}

export interface DynamicOmSlotAllocation {
	manifest: AsyncOmLaunchManifestV1;
	slots: AsyncChildSlotV1[];
}

export interface AllocateDynamicOmSlotsOptions {
	fsOps?: WriteDurableJsonOptions["fsOps"];
}

/**
 * Durably reopen and update the launch manifest to add slots for a materialized dynamic-fanout
 * batch, BEFORE any child in the batch starts. Idempotent per logical key (a key that already
 * has a slot is reused, never re-minted), so a caller may safely retry the whole batch.
 *
 * Returns `undefined` if the manifest cannot be read or the update cannot be durably committed
 * (mirrors `persistLaunchManifest`'s strict "only a committed write counts" rule) — callers must
 * then run the batch WITHOUT OM registration: no outbox, no forced per-item session file.
 */
export function allocateDynamicOmSlots(
	manifestPath: string,
	logicalChildKeys: string[],
	agentName: string,
	options?: AllocateDynamicOmSlotsOptions,
): DynamicOmSlotAllocation | undefined {
	const manifest = loadOmManifest(manifestPath);
	if (!manifest) return undefined;

	const childSlots = { ...manifest.childSlots };
	let nextChildSequence = manifest.nextChildSequence;
	const slots: AsyncChildSlotV1[] = [];
	for (const logicalChildKey of logicalChildKeys) {
		const existing = childSlots[logicalChildKey];
		if (existing) {
			slots.push(existing);
			continue;
		}
		const slot: AsyncChildSlotV1 = {
			logicalChildKey,
			childId: formatChildId(nextChildSequence),
			agentName,
			allocation: "dynamic",
		};
		childSlots[logicalChildKey] = slot;
		nextChildSequence += 1;
		slots.push(slot);
	}

	const updatedManifest: AsyncOmLaunchManifestV1 = { ...manifest, childSlots, nextChildSequence };
	try {
		const result = writeDurableJson(manifestPath, updatedManifest, { exclusive: false, fsOps: options?.fsOps });
		if (result.status !== "committed") return undefined;
	} catch {
		return undefined;
	}
	return { manifest: updatedManifest, slots };
}

/**
 * Read a child's session file (newline-delimited JSON) into a snapshot entry array. Returns
 * `undefined` (rather than a partial snapshot) if the file is missing or any line fails to
 * parse — an incomplete or corrupt snapshot must never be published as if it were terminal.
 */
export function captureSessionSnapshotEntries(sessionFile: string): unknown[] | undefined {
	try {
		const raw = fs.readFileSync(sessionFile, "utf-8");
		const entries: unknown[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			entries.push(JSON.parse(trimmed));
		}
		return entries;
	} catch {
		return undefined;
	}
}

export function buildCompletionOutbox(
	delivery: AsyncChildDeliveryBindingV1,
	entries: unknown[],
	completedAt: string = new Date().toISOString(),
): AsyncOmCompletionOutboxV1 {
	const { sha256, byteLength } = computeCanonicalSha256(entries);
	return {
		schemaVersion: ASYNC_OM_COMPLETION_OUTBOX_SCHEMA_VERSION,
		delivery,
		completedAt,
		snapshot: { entries, sha256, byteLength },
	};
}

/** Durably publish a completion outbox under a fresh owner-only directory, keyed by childId. */
export function publishCompletionOutbox(asyncDir: string, outbox: AsyncOmCompletionOutboxV1): DurableWriteResult | undefined {
	try {
		fs.mkdirSync(resolveOmOutboxDir(asyncDir), { recursive: true, mode: 0o700 });
		return writeDurableJson(resolveOmOutboxPath(asyncDir, outbox.delivery.childId), outbox);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort end-to-end publish for one completed top-level registered child: resolve its slot
 * from the manifest, capture a session-entry snapshot, and durably publish the outbox. No-ops
 * (returns `false`) when the run has no OM manifest, the child has no registered logical key or
 * slot, or the session snapshot cannot be read — never throws, never blocks normal completion.
 */
export function publishChildOmOutbox(
	manifest: AsyncOmLaunchManifestV1 | undefined,
	logicalChildKey: string | undefined,
	sessionFile: string | undefined,
	asyncDir: string,
): boolean {
	if (!manifest || !logicalChildKey || !sessionFile) return false;
	const slot = manifest.childSlots[logicalChildKey];
	if (!slot) return false;
	const entries = captureSessionSnapshotEntries(sessionFile);
	if (!entries) return false;
	const delivery = buildOmDeliveryBinding(manifest, slot.childId);
	const outbox = buildCompletionOutbox(delivery, entries);
	const result = publishCompletionOutbox(asyncDir, outbox);
	// A degraded write can land bytes on disk without a durable commit; we do NOT treat that as
	// delivered (return false), but surface it so a silently-dropped OM outbox stays diagnosable.
	if (result && result.status !== "committed") {
		console.warn(`[pi-subagents] OM completion outbox for child ${slot.childId} not committed (status=${result.status}); treating as undelivered.`);
	}
	return result?.status === "committed";
}
