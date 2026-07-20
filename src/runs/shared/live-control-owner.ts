import {
	deleteLiveControlRequestFile,
	closeLiveControlOwnerEpoch,
	publishLiveControlOwnerEpoch,
	readLiveControlRequestState,
	readLiveControlSequenceBaseline,
	readPendingLiveControlRequests,
	writeLiveControlRequestState,
	type NestedRoute,
} from "./nested-events.ts";
import type { LiveControlDisposition, LiveControlMode, LiveControlRequestRecord, LiveControlResultRecord } from "../../shared/types.ts";

export interface LiveControlOwnerDeps {
	route: NestedRoute;
	childKey: string;
	/** Bound to the extension's pi.sendUserMessage. Must throw (not swallow) on failure. */
	sendUserMessage: (text: string, options?: { deliverAs: LiveControlMode }) => unknown | Promise<unknown>;
	/** True while Pi is processing an agent run / retry / queued continuation (mirrors ctx.isIdle() === false). */
	isBusy: () => boolean;
	now?: () => number;
	pid?: number;
}

export interface LiveControlOwnerListener {
	readonly epoch: string;
	pollOnce(): Promise<void>;
	close(): void;
}

function nowOf(deps: LiveControlOwnerDeps): number {
	return deps.now?.() ?? Date.now();
}

function baseResult(record: LiveControlRequestRecord, now: number): Omit<LiveControlResultRecord, "state" | "message" | "disposition"> {
	return {
		schemaVersion: 2,
		type: "subagent.live-control.result",
		rootRunId: record.rootRunId,
		capabilityToken: record.capabilityToken,
		childKey: record.childKey,
		epoch: record.epoch,
		sequence: record.sequence,
		requestId: record.requestId,
		ts: now,
	};
}

/**
 * Create and start a single-flight owner listener for one (rootRunId, childKey) slot.
 * Publishing the owner epoch happens synchronously at construction time so a caller can
 * immediately discover the live epoch (e.g. to stamp new requests) without an extra read.
 */
export function createLiveControlOwnerListener(deps: LiveControlOwnerDeps): LiveControlOwnerListener {
	// Fix this replacement owner's expected FIFO baseline to the continued global sequence *before*
	// publishing its epoch, so no parent can ever discover the new epoch ahead of the baseline being set.
	const baseline = readLiveControlSequenceBaseline(deps.route, deps.childKey);
	const owner = publishLiveControlOwnerEpoch(deps.route, deps.childKey, { now: deps.now?.(), pid: deps.pid });
	let lastConsumed = baseline;
	const consumedRequestIdBySequence = new Map<number, string>();
	// requestId is the idempotency key within this owner's epoch, independent of sequence.
	// resultByRequestId is the single authoritative source of truth for "has this requestId already
	// reached a durable terminal result?" (accepted OR rejected). It is write-once per requestId and
	// is consulted before any check (epoch, sequence gap, sequence conflict) can invoke Pi again.
	const resultByRequestId = new Map<string, LiveControlResultRecord>();
	let inFlight = false;
	let closed = false;

	function reject(record: LiveControlRequestRecord, message: string): void {
		const result: LiveControlResultRecord = {
			...baseResult(record, nowOf(deps)),
			state: "rejected",
			message,
		};
		writeLiveControlRequestState(deps.route, result);
		resultByRequestId.set(record.requestId, result);
	}

	/**
	 * Durably persist a duplicate requestId's known outcome at its own (fresh or stale) sequence
	 * slot, honestly reflecting the original result without invoking Pi again. Never mutates
	 * resultByRequestId: the original durable result stays the write-once authoritative cache, so a
	 * duplicate copy can never demote or replace it (rejected must never become accepted).
	 */
	function writeDuplicateResult(record: LiveControlRequestRecord, prior: LiveControlResultRecord): void {
		const result: LiveControlResultRecord = {
			...baseResult(record, nowOf(deps)),
			state: prior.state,
			...(prior.disposition ? { disposition: prior.disposition } : {}),
			message: `Duplicate requestId already processed at sequence ${prior.sequence} (${prior.state}); reusing that result without calling Pi again.`,
		};
		writeLiveControlRequestState(deps.route, result);
	}

	async function processOne(record: LiveControlRequestRecord, filePath: string): Promise<void> {
		// resultByRequestId is the single authoritative source of truth for "has this requestId already
		// reached a durable terminal result?" (accepted OR rejected, however it got there). It must be
		// consulted before any other check (epoch, sequence gap, sequence conflict) can invoke Pi again:
		// a rejected result is just as authoritative as an accepted one, so a later raw record reusing
		// a known requestId must never re-run Pi.
		const priorResult = resultByRequestId.get(record.requestId);
		if (priorResult) {
			if (record.sequence === lastConsumed + 1) {
				// Exact next FIFO slot: consume it so later legitimate work is not blocked, but reuse
				// the known outcome instead of calling Pi again.
				lastConsumed = record.sequence;
				consumedRequestIdBySequence.set(record.sequence, record.requestId);
			}
			// Else: stale, already-consumed, or still a gap relative to this owner's FIFO — never
			// fabricate FIFO progress for a duplicate. Either way, persist the duplicate outcome at its
			// own (sequence, requestId) slot for observability without ever replacing the authoritative
			// cached result.
			writeDuplicateResult(record, priorResult);
			deleteLiveControlRequestFile(filePath);
			return;
		}

		if (record.epoch !== owner.epoch) {
			// A different (rotated-out or foreign) generation. Never let it influence this owner's FIFO baseline.
			const existing = readLiveControlRequestState(deps.route, deps.childKey, record.sequence, record.requestId);
			if (existing?.state === "delivery-attempted") {
				// Ambiguous already-attempted delivery under a lost/rotated owner must never be
				// silently reclassified as rejected, and must never be replayed by a fresh epoch.
				deleteLiveControlRequestFile(filePath);
				return;
			}
			reject(record, "Stale epoch: this owner has since restarted or the request targeted a different owner generation.");
			deleteLiveControlRequestFile(filePath);
			return;
		}

		if (record.sequence <= lastConsumed) {
			const consumedBy = consumedRequestIdBySequence.get(record.sequence);
			if (consumedBy !== record.requestId) {
				reject(record, `Conflicting duplicate for sequence ${record.sequence}: a different request already consumed this slot.`);
			}
			// Else: legitimate retry of an already-processed requestId. Leave the original terminal record untouched.
			deleteLiveControlRequestFile(filePath);
			return;
		}

		if (record.sequence > lastConsumed + 1) {
			reject(record, `Sequence gap: expected ${lastConsumed + 1}, got ${record.sequence}. Resubmit at the correct next sequence.`);
			deleteLiveControlRequestFile(filePath);
			return;
		}

		// record.sequence === lastConsumed + 1 here, and requestId has never been seen before: the correct next slot.
		lastConsumed = record.sequence;
		consumedRequestIdBySequence.set(record.sequence, record.requestId);

		const text = record.text.trim();
		if (!text) {
			reject(record, "Empty control text.");
			deleteLiveControlRequestFile(filePath);
			return;
		}

		writeLiveControlRequestState(deps.route, {
			...baseResult(record, nowOf(deps)),
			state: "delivery-attempted",
			message: "Calling pi.sendUserMessage.",
		});

		try {
			const busy = deps.isBusy();
			let disposition: LiveControlDisposition;
			if (!busy) {
				await deps.sendUserMessage(text);
				disposition = "started-turn";
			} else {
				await deps.sendUserMessage(text, { deliverAs: record.mode });
				disposition = record.mode === "steer" ? "queued-steer" : "queued-follow-up";
			}
			const result: LiveControlResultRecord = {
				...baseResult(record, nowOf(deps)),
				state: "accepted-by-pi",
				disposition,
				message: `Accepted by Pi (${disposition}).`,
			};
			writeLiveControlRequestState(deps.route, result);
			resultByRequestId.set(record.requestId, result);
		} catch (error) {
			const result: LiveControlResultRecord = {
				...baseResult(record, nowOf(deps)),
				state: "rejected",
				message: error instanceof Error ? error.message : String(error),
			};
			writeLiveControlRequestState(deps.route, result);
			resultByRequestId.set(record.requestId, result);
		}
		deleteLiveControlRequestFile(filePath);
	}

	async function pollOnce(): Promise<void> {
		if (closed || inFlight) return;
		inFlight = true;
		try {
			const pending = readPendingLiveControlRequests(deps.route, deps.childKey);
			for (const { record, filePath } of pending) {
				await processOne(record, filePath);
			}
		} finally {
			inFlight = false;
		}
	}

	function close(): void {
		if (closed) return;
		closed = true;
		closeLiveControlOwnerEpoch(deps.route, deps.childKey, owner.epoch, nowOf(deps));
	}

	return { epoch: owner.epoch, pollOnce, close };
}
