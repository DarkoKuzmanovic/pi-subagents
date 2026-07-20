import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNestedRoute,
	deriveLiveControlOutcome,
	publishLiveControlOwnerEpoch,
	readLiveControlOwnerEpoch,
	readLiveControlRequestState,
	submitLiveControlRequest,
	writeLiveControlRequestState,
} from "../../src/runs/shared/nested-events.ts";
import type { NestedRoute } from "../../src/runs/shared/nested-events.ts";
import { createLiveControlOwnerListener } from "../../src/runs/shared/live-control-owner.ts";

const routes: NestedRoute[] = [];

afterEach(() => {
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
});

function trackRoute(rootRunId = `root-${Math.random().toString(36).slice(2)}`): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

interface FakeSend {
	calls: Array<{ text: string; options?: { deliverAs: "steer" | "followUp" } }>;
	sendUserMessage(text: string, options?: { deliverAs: "steer" | "followUp" }): Promise<void>;
}

function fakeSend(behavior?: (text: string, options?: { deliverAs: "steer" | "followUp" }) => void): FakeSend {
	const calls: FakeSend["calls"] = [];
	return {
		calls,
		async sendUserMessage(text, options) {
			calls.push({ text, options });
			behavior?.(text, options);
		},
	};
}

/**
 * Write a raw v2 live-control request file directly to disk, mirroring submitLiveControlRequest's
 * on-disk shape without going through it. Used to prove the owner defensively suppresses a
 * duplicate requestId even when a caller bypasses the checked submission helper entirely.
 */
function writeRawLiveControlRequest(route: NestedRoute, opts: { childKey: string; epoch: string; sequence: number; requestId: string; mode: "steer" | "followUp"; text: string }): void {
	const dir = path.join(path.dirname(route.eventSink), "live-control", "requests", opts.childKey);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name = `${String(opts.sequence).padStart(10, "0")}-${opts.requestId}.json`;
	const record = {
		schemaVersion: 2,
		type: "subagent.live-control.request",
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		childKey: opts.childKey,
		epoch: opts.epoch,
		sequence: opts.sequence,
		requestId: opts.requestId,
		mode: opts.mode,
		text: opts.text,
		ts: Date.now(),
	};
	fs.writeFileSync(path.join(dir, name), JSON.stringify(record), { mode: 0o600 });
}

describe("live control owner listener — idle vs busy delivery", () => {
	it("delivers without deliverAs and records started-turn when idle", async () => {
		const route = trackRoute();
		const busy = false;
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => busy });
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "followUp", text: "hello idle" });

		await listener.pollOnce();

		assert.equal(send.calls.length, 1);
		assert.equal(send.calls[0]?.text, "hello idle");
		assert.equal(send.calls[0]?.options, undefined);
		const state = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(state?.state, "accepted-by-pi");
		assert.equal(state?.disposition, "started-turn");
	});

	it("preserves requested steer mode while busy and records queued-steer", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => true });
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "focus" });

		await listener.pollOnce();

		assert.equal(send.calls[0]?.options?.deliverAs, "steer");
		const state = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(state?.state, "accepted-by-pi");
		assert.equal(state?.disposition, "queued-steer");
	});

	it("preserves requested followUp mode while busy and never silently downgrades to steer", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => true });
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "followUp", text: "then summarize" });

		await listener.pollOnce();

		assert.equal(send.calls[0]?.options?.deliverAs, "followUp");
		const state = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(state?.disposition, "queued-follow-up");
	});

	it("persists a fsynced delivery-attempted record before calling sendUserMessage", async () => {
		const route = trackRoute();
		const observedStates: string[] = [];
		const send = fakeSend((_text) => {
			const midFlight = readLiveControlRequestState(route, "0", 1, req.requestId);
			observedStates.push(midFlight?.state ?? "missing");
		});
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "x" });

		await listener.pollOnce();

		assert.deepEqual(observedStates, ["delivery-attempted"]);
	});
});

describe("live control owner listener — single-flight FIFO, duplicates, and gaps", () => {
	it("processes requests strictly in sequence order", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "one", sequence: 1 });
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "two", sequence: 2 });
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "three", sequence: 3 });

		await listener.pollOnce();

		assert.deepEqual(send.calls.map((call) => call.text), ["one", "two", "three"]);
	});

	it("idempotently replays a duplicate requestId at an already-consumed sequence without redelivering", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const first = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1);

		// Re-submit the identical request at the same sequence with the same requestId (retry semantics).
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1, requestId: first.requestId });
		await listener.pollOnce();

		assert.equal(send.calls.length, 1, "must not call sendUserMessage twice for the same requestId");
	});

	it("suppresses a raw duplicate requestId that bypasses submitLiveControlRequest and arrives at the next sequence, without calling Pi again", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const first = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1);
		const firstState = readLiveControlRequestState(route, "0", 1, first.requestId);
		assert.equal(firstState?.state, "accepted-by-pi");

		// Raw duplicate: bypasses submitLiveControlRequest's own idempotency check by writing the
		// pending request file directly, reusing the SAME requestId at the next sequence slot.
		writeRawLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, sequence: 2, requestId: first.requestId, mode: "steer", text: "first" });
		await listener.pollOnce();

		assert.equal(send.calls.length, 1, "a duplicate requestId must never call Pi twice, even at a fresh sequence slot");
		const secondState = readLiveControlRequestState(route, "0", 2, first.requestId);
		assert.equal(secondState?.sequence, 2, "the duplicate must be durably terminalized at its own sequence, not silently dropped");
		assert.equal(secondState?.state, "accepted-by-pi", "duplicate reuse must honestly reflect the original terminal outcome");

		// FIFO must still advance so later legitimate work at sequence 3 is not blocked.
		const third = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "third", sequence: 3 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 2, "later valid work must not be blocked by the duplicate");
		const thirdState = readLiveControlRequestState(route, "0", 3, third.requestId);
		assert.equal(thirdState?.state, "accepted-by-pi");
	});

	it("durably rejects a conflicting duplicate at an already-consumed sequence without calling Pi", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1);

		const conflicting = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "conflict", sequence: 1 });
		await listener.pollOnce();

		assert.equal(send.calls.length, 1, "conflicting duplicate must never reach Pi");
		const state = readLiveControlRequestState(route, "0", 1, conflicting.requestId);
		assert.equal(state?.state, "rejected");
	});

	it("durably rejects a sequence gap without blocking the eventually-correct next request", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const gapRequest = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "arrives too early", sequence: 5 });

		await listener.pollOnce();

		assert.equal(send.calls.length, 0, "gap must not be delivered");
		const gapState = readLiveControlRequestState(route, "0", 5, gapRequest.requestId);
		assert.equal(gapState?.state, "rejected");

		// The correct next request establishes a fresh baseline and must proceed normally.
		const proper = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "actual first", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1);
		const properState = readLiveControlRequestState(route, "0", 1, proper.requestId);
		assert.equal(properState?.state, "accepted-by-pi");
	});

	it("reuses a prior sequence-gap rejection for a later raw duplicate at the current exact-next sequence, without calling Pi", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const gapRequest = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "arrives too early", sequence: 5 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 0, "gap must not be delivered");
		const gapState = readLiveControlRequestState(route, "0", 5, gapRequest.requestId);
		assert.equal(gapState?.state, "rejected");

		// Same requestId, now sent raw at the owner's actual current exact-next sequence (1). This must
		// reuse the prior rejection honestly, never invoke Pi, and never overwrite it with an accepted result.
		writeRawLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, sequence: 1, requestId: gapRequest.requestId, mode: "steer", text: "arrives too early" });
		await listener.pollOnce();

		assert.equal(send.calls.length, 0, "a duplicate requestId reusing a prior gap rejection must never call Pi");
		const duplicateState = readLiveControlRequestState(route, "0", 1, gapRequest.requestId);
		assert.equal(duplicateState?.state, "rejected", "the duplicate must reuse the prior rejected outcome, not become accepted");
		const originalGapState = readLiveControlRequestState(route, "0", 5, gapRequest.requestId);
		assert.equal(originalGapState?.state, "rejected", "the original gap rejection must remain untouched");

		// FIFO must have advanced past the consumed duplicate slot so later fresh work proceeds.
		const fresh = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "fresh work", sequence: 2 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1, "later fresh requestId work must still proceed");
		const freshState = readLiveControlRequestState(route, "0", 2, fresh.requestId);
		assert.equal(freshState?.state, "accepted-by-pi");
	});

	it("reuses a prior same-sequence conflict rejection for a later raw duplicate at the current exact-next sequence, without calling Pi", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1);

		const conflicting = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "conflict", sequence: 1 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 1, "conflicting duplicate must never reach Pi");
		const conflictState = readLiveControlRequestState(route, "0", 1, conflicting.requestId);
		assert.equal(conflictState?.state, "rejected");

		// Same requestId as the conflict-rejected request, now sent raw at the owner's actual current
		// exact-next sequence (2). This must reuse the prior rejection honestly and never invoke Pi.
		writeRawLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, sequence: 2, requestId: conflicting.requestId, mode: "steer", text: "conflict" });
		await listener.pollOnce();

		assert.equal(send.calls.length, 1, "a duplicate requestId reusing a prior conflict rejection must never call Pi");
		const duplicateState = readLiveControlRequestState(route, "0", 2, conflicting.requestId);
		assert.equal(duplicateState?.state, "rejected", "the duplicate must reuse the prior rejected outcome, not become accepted");
		const originalConflictState = readLiveControlRequestState(route, "0", 1, conflicting.requestId);
		assert.equal(originalConflictState?.state, "rejected", "the original conflict rejection must remain untouched");

		// FIFO must have advanced past the consumed duplicate slot so later fresh work proceeds.
		const fresh = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "fresh work", sequence: 3 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 2, "later fresh requestId work must still proceed");
		const freshState = readLiveControlRequestState(route, "0", 3, fresh.requestId);
		assert.equal(freshState?.state, "accepted-by-pi");
	});
});

	it("keeps the first accepted result authoritative when a stale-epoch duplicate arrives at the next sequence, and a standard retry resolves the original", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const first = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", sequence: 1 });

		await listener.pollOnce();
		assert.equal(send.calls.length, 1, "original request must be delivered once");
		const firstState = readLiveControlRequestState(route, "0", 1, first.requestId);
		assert.equal(firstState?.state, "accepted-by-pi");
		assert.equal(firstState?.disposition, "started-turn");

		// Authenticated raw stale-epoch duplicate: same requestId, exact-next sequence, but bound to a different epoch.
		const staleEpoch = "00000000-0000-0000-0000-000000000000";
		writeRawLiveControlRequest(route, { childKey: "0", epoch: staleEpoch, sequence: 2, requestId: first.requestId, mode: "steer", text: "first" });
		await listener.pollOnce();

		assert.equal(send.calls.length, 1, "a known accepted requestId must never call Pi again");
		const duplicateState = readLiveControlRequestState(route, "0", 2, first.requestId);
		assert.equal(duplicateState?.state, "accepted-by-pi", "stale-epoch duplicate must reuse the original accepted outcome, not become rejected");
		assert.equal(duplicateState?.disposition, "started-turn", "duplicate must preserve the original disposition");

		// Standard submit retry must resolve the original authoritative sequence and result, not the duplicate copy.
		const retry = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "first", requestId: first.requestId });
		assert.equal(retry.sequence, 1, "retry must resolve the original accepted sequence, not the duplicate sequence");
		assert.equal(retry.epoch, first.epoch, "retry must resolve the original authoritative epoch");
		const retryState = readLiveControlRequestState(route, "0", 1, first.requestId);
		assert.equal(retryState?.state, "accepted-by-pi");
		assert.equal(retryState?.disposition, "started-turn");

		// The duplicate at the exact-next slot advanced FIFO so later fresh work proceeds.
		const fresh = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "fresh", sequence: 3 });
		await listener.pollOnce();
		assert.equal(send.calls.length, 2, "fresh work after the consumed duplicate must proceed");
		const freshState = readLiveControlRequestState(route, "0", 3, fresh.requestId);
		assert.equal(freshState?.state, "accepted-by-pi");
	});


describe("live control owner listener — epoch integrity", () => {
	it("rejects a request bound to a stale (rotated-out) epoch without calling Pi", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const firstListener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const staleEpoch = firstListener.epoch;

		// Simulate the owner restarting: a brand new epoch supersedes the old one.
		const secondListener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		assert.notEqual(secondListener.epoch, staleEpoch);

		const staleRequest = submitLiveControlRequest(route, { childKey: "0", epoch: staleEpoch, mode: "steer", text: "stale" });
		await secondListener.pollOnce();

		assert.equal(send.calls.length, 0);
		const state = readLiveControlRequestState(route, "0", staleRequest.sequence, staleRequest.requestId);
		assert.equal(state?.state, "rejected");
	});

	it("reuses a prior stale-epoch rejection for a later raw duplicate at the current owner's exact-next sequence, without calling Pi", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const firstListener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const staleEpoch = firstListener.epoch;

		// Simulate the owner restarting: a brand new epoch supersedes the old one.
		const secondListener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		assert.notEqual(secondListener.epoch, staleEpoch);

		const staleRequest = submitLiveControlRequest(route, { childKey: "0", epoch: staleEpoch, mode: "steer", text: "stale" });
		await secondListener.pollOnce();
		assert.equal(send.calls.length, 0);
		const staleState = readLiveControlRequestState(route, "0", staleRequest.sequence, staleRequest.requestId);
		assert.equal(staleState?.state, "rejected");

		// Same requestId, now sent raw under the *current* (valid) epoch at secondListener's actual
		// exact-next sequence. This must reuse the prior stale-epoch rejection honestly and never invoke Pi.
		writeRawLiveControlRequest(route, { childKey: "0", epoch: secondListener.epoch, sequence: staleRequest.sequence, requestId: staleRequest.requestId, mode: "steer", text: "stale" });
		await secondListener.pollOnce();

		assert.equal(send.calls.length, 0, "a duplicate requestId reusing a prior stale-epoch rejection must never call Pi");
		const duplicateState = readLiveControlRequestState(route, "0", staleRequest.sequence, staleRequest.requestId);
		assert.equal(duplicateState?.state, "rejected", "the duplicate must reuse the prior rejected outcome, not become accepted");

		// FIFO must have advanced past the consumed duplicate slot so later fresh work proceeds.
		const fresh = submitLiveControlRequest(route, { childKey: "0", epoch: secondListener.epoch, mode: "steer", text: "fresh work" });
		await secondListener.pollOnce();
		assert.equal(send.calls.length, 1, "later fresh requestId work must still proceed");
		const freshState = readLiveControlRequestState(route, "0", fresh.sequence, fresh.requestId);
		assert.equal(freshState?.state, "accepted-by-pi");
	});

	it("same-live-epoch requests remain consumable after a simulated parent-side restart", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const currentEpoch = readLiveControlOwnerEpoch(route, "0")?.epoch;
		assert.equal(currentEpoch, listener.epoch);

		// "Parent restart": a fresh caller re-discovers the still-live epoch and submits against it.
		const rediscoveredEpoch = readLiveControlOwnerEpoch(route, "0")?.epoch as string;
		const request = submitLiveControlRequest(route, { childKey: "0", epoch: rediscoveredEpoch, mode: "followUp", text: "post-restart" });

		await listener.pollOnce();

		assert.equal(send.calls.length, 1);
		const state = readLiveControlRequestState(route, "0", request.sequence, request.requestId);
		assert.equal(state?.state, "accepted-by-pi");
	});

	it("closes the owner epoch on orderly shutdown and future requests bound to it are stale once rotated", () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		listener.close();
		assert.ok(readLiveControlOwnerEpoch(route, "0")?.closedAt);
	});

	it("accepts the first valid request under a replacement owner after orderly rotation, honoring the continued global sequence", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const ownerA = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const reqA = submitLiveControlRequest(route, { childKey: "0", epoch: ownerA.epoch, mode: "steer", text: "first owner request" });

		await ownerA.pollOnce();
		assert.equal(send.calls.length, 1);
		const stateA = readLiveControlRequestState(route, "0", reqA.sequence, reqA.requestId);
		assert.equal(stateA?.state, "accepted-by-pi");

		// Orderly rotation: A closes, B replaces it on the same route/childKey.
		ownerA.close();
		const ownerB = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		assert.notEqual(ownerB.epoch, ownerA.epoch);

		// A stale submission still bound to A's rotated-out epoch (a late retry landing after rotation) must be
		// rejected, not consumed — and must not itself allocate a fresh global sequence slot.
		const staleRequest = submitLiveControlRequest(route, { childKey: "0", epoch: ownerA.epoch, mode: "steer", text: "stale after rotation", sequence: reqA.sequence });
		await ownerB.pollOnce();
		assert.equal(send.calls.length, 1, "stale prior-epoch request must never be delivered");
		const staleState = readLiveControlRequestState(route, "0", staleRequest.sequence, staleRequest.requestId);
		assert.equal(staleState?.state, "rejected");

		// B's first published-epoch request, allocated from the continued global sequence, must be accepted.
		const reqB = submitLiveControlRequest(route, { childKey: "0", epoch: ownerB.epoch, mode: "steer", text: "second owner first request" });
		await ownerB.pollOnce();
		assert.equal(send.calls.length, 2, "replacement owner's first valid request must be accepted");
		const stateB = readLiveControlRequestState(route, "0", reqB.sequence, reqB.requestId);
		assert.equal(stateB?.state, "accepted-by-pi");
	});
});

describe("live control owner listener — crash ambiguity is never silently replayed", () => {
	it("leaves a request stuck at delivery-attempted as outcome-unknown, and a fresh owner never redelivers it", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "will crash" });

		// Simulate a crash exactly after delivery-attempted was fsynced, before any terminal write.
		writeLiveControlRequestState(route, {
			schemaVersion: 2,
			type: "subagent.live-control.result",
			rootRunId: route.rootRunId,
			capabilityToken: route.capabilityToken,
			childKey: "0",
			epoch: owner.epoch,
			sequence: req.sequence,
			requestId: req.requestId,
			state: "delivery-attempted",
			message: "Calling pi.sendUserMessage.",
			ts: Date.now(),
		});

		const stuck = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(deriveLiveControlOutcome(stuck), "outcome-unknown");

		// A fresh owner (new epoch, per restart) must never treat this leftover request file as still pending for itself.
		const send = fakeSend();
		const freshListener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		await freshListener.pollOnce();

		assert.equal(send.calls.length, 0, "a stuck delivery-attempted request must never be blindly replayed");
		const stillStuck = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(deriveLiveControlOutcome(stillStuck), "outcome-unknown");
	});

	it("writes rejected (not a silent swallow) when sendUserMessage throws synchronously", async () => {
		const route = trackRoute();
		const send = fakeSend(() => {
			throw new Error("boom");
		});
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const req = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "will throw" });

		await listener.pollOnce();

		const state = readLiveControlRequestState(route, "0", req.sequence, req.requestId);
		assert.equal(state?.state, "rejected");
		assert.match(state?.message ?? "", /boom/);
	});
});

describe("live control owner listener — malformed and wrong-capability input", () => {
	it("ignores a request for a different capability token without invoking Pi", async () => {
		const route = trackRoute();
		const otherRoute = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		// Craft a raw file directly under this route's request dir but stamped with a foreign capability token.
		submitLiveControlRequest(otherRoute, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "wrong route" });

		await listener.pollOnce();

		assert.equal(send.calls.length, 0);
	});

	it("rejects empty control text at the correct sequence without calling Pi, and still advances past it", async () => {
		const route = trackRoute();
		const send = fakeSend();
		const listener = createLiveControlOwnerListener({ route, childKey: "0", sendUserMessage: send.sendUserMessage, isBusy: () => false });
		const empty = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "   ", sequence: 1 });
		const next = submitLiveControlRequest(route, { childKey: "0", epoch: listener.epoch, mode: "steer", text: "real", sequence: 2 });

		await listener.pollOnce();

		assert.equal(send.calls.length, 1);
		assert.equal(send.calls[0]?.text, "real");
		const emptyState = readLiveControlRequestState(route, "0", 1, empty.requestId);
		assert.equal(emptyState?.state, "rejected");
		const nextState = readLiveControlRequestState(route, "0", 2, next.requestId);
		assert.equal(nextState?.state, "accepted-by-pi");
	});
});
