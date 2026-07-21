import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNestedRoute,
	closeLiveControlOwnerEpoch,
	publishLiveControlOwnerEpoch,
	readPendingLiveControlRequests,
	writeLiveControlRequestState,
} from "../../src/runs/shared/nested-events.ts";
import type { LiveControlDisposition, LiveControlRequestState } from "../../src/shared/types.ts";
import type { NestedRoute } from "../../src/runs/shared/nested-events.ts";
import { performLiveControlAction, WRAP_UP_DIRECTIVE } from "../../src/runs/shared/live-control-client.ts";

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

/** Deterministic fake clock: no real timers, no interleaving hazard since nothing else writes concurrently. */
function fakeClock(startMs = 0) {
	let now = startMs;
	return {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
	};
}

/**
 * Pre-write a terminal (or delivery-attempted) durable result at a fixed (childKey=0, sequence=1,
 * requestId) BEFORE calling performLiveControlAction with the same requestId. submitLiveControlRequest's
 * requestId-idempotency check finds this existing record and reuses its sequence/requestId, so
 * performLiveControlAction's very first (synchronous, pre-sleep) poll read observes it immediately —
 * no timing race with a background writer required.
 */
function seedResult(route: NestedRoute, epoch: string, requestId: string, state: LiveControlRequestState, disposition?: LiveControlDisposition, message = state): void {
	writeLiveControlRequestState(route, {
		schemaVersion: 2,
		type: "subagent.live-control.result",
		rootRunId: route.rootRunId,
		capabilityToken: route.capabilityToken,
		childKey: "0",
		epoch,
		sequence: 1,
		requestId,
		state,
		...(disposition ? { disposition } : {}),
		message,
		ts: Date.now(),
	});
}

describe("performLiveControlAction — what gets submitted", () => {
	it("submits steer mode with the given text", async () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		await performLiveControlAction({ route, childKey: "0", action: "steer", text: "focus on X", waitMs: 0 });
		const [pending] = readPendingLiveControlRequests(route, "0");
		assert.equal(pending?.record.mode, "steer");
		assert.equal(pending?.record.text, "focus on X");
	});

	it("submits followUp mode with the given text, never silently downgrading to steer", async () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		await performLiveControlAction({ route, childKey: "0", action: "follow-up", text: "then summarize", waitMs: 0 });
		const [pending] = readPendingLiveControlRequests(route, "0");
		assert.equal(pending?.record.mode, "followUp");
		assert.equal(pending?.record.text, "then summarize");
	});

	it("wrap-up submits steer mode (not follow-up) with the canonical WRAP_UP_DIRECTIVE, ignoring any caller text", async () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		await performLiveControlAction({ route, childKey: "0", action: "wrap-up", text: "ignored", waitMs: 0 });
		const [pending] = readPendingLiveControlRequests(route, "0");
		assert.equal(pending?.record.mode, "steer");
		assert.equal(pending?.record.text, WRAP_UP_DIRECTIVE);
	});

	it("rejects steer/follow-up with an empty or missing message without submitting anything", async () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "   " });
		assert.equal(result.ok, false);
		assert.match(result.message, /requires a non-empty message/);
		assert.deepEqual(readPendingLiveControlRequests(route, "0"), []);
	});

	it("rejects without submitting when no live owner epoch is registered for the child", async () => {
		const route = trackRoute();
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "hi" });
		assert.equal(result.ok, false);
		assert.equal(result.state, "rejected");
		assert.match(result.message, /No live control owner/);
		assert.deepEqual(readPendingLiveControlRequests(route, "0"), []);
	});
});

describe("performLiveControlAction — honest disposition/state reporting", () => {
	it("maps accepted-by-pi + queued-steer to an ok result naming the queued disposition", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-steer", "accepted-by-pi", "queued-steer");
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "hi", requestId: "r-steer" });
		assert.equal(result.ok, true);
		assert.equal(result.state, "accepted-by-pi");
		assert.equal(result.disposition, "queued-steer");
		assert.match(result.message, /Steer accepted/);
	});

	it("maps accepted-by-pi + queued-follow-up to an ok result naming the queued disposition", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-followup", "accepted-by-pi", "queued-follow-up");
		const result = await performLiveControlAction({ route, childKey: "0", action: "follow-up", text: "hi", requestId: "r-followup" });
		assert.equal(result.disposition, "queued-follow-up");
		assert.match(result.message, /Follow-up accepted/);
	});

	it("maps accepted-by-pi + started-turn (idle delivery) to an ok result for wrap-up", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-wrapup", "accepted-by-pi", "started-turn");
		const result = await performLiveControlAction({ route, childKey: "0", action: "wrap-up", requestId: "r-wrapup" });
		assert.equal(result.ok, true);
		assert.match(result.message, /Wrap-up accepted/);
	});

	it("reports rejected honestly (never claims accepted) when the owner durably rejects the request", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-rejected", "rejected", undefined, "sequence gap: expected 2");
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "hi", requestId: "r-rejected" });
		assert.equal(result.ok, false);
		assert.equal(result.state, "rejected");
		assert.match(result.message, /rejected/i);
		assert.match(result.message, /sequence gap: expected 2/);
	});

	it("waits through a transient delivery-attempted state and returns the later acceptance", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-attempted-accepted", "delivery-attempted");
		let now = 0;
		let sleeps = 0;
		const result = await performLiveControlAction({
			route,
			childKey: "0",
			action: "steer",
			text: "hi",
			requestId: "r-attempted-accepted",
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				if (++sleeps === 1) seedResult(route, owner.epoch, "r-attempted-accepted", "accepted-by-pi", "queued-steer");
			},
			pollMs: 10,
			waitMs: 35,
		});
		assert.equal(result.ok, true);
		assert.equal(result.state, "accepted-by-pi");
		assert.equal(result.disposition, "queued-steer");
		assert.equal(now, 10);
	});

	it("reports outcome-unknown only after a stuck delivery-attempted record reaches the deadline", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-attempted", "delivery-attempted");
		const clock = fakeClock();
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "hi", requestId: "r-attempted", now: clock.now, sleep: clock.sleep, pollMs: 10, waitMs: 35 });
		assert.equal(result.ok, false);
		assert.equal(result.state, "outcome-unknown");
		assert.ok(clock.now() >= 35);
		assert.match(result.message, /crashed or exited/);
	});

	it("concludes outcome-unknown early when the attempted request's owner closes", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-attempted-closed", "delivery-attempted");
		let now = 0;
		const result = await performLiveControlAction({
			route,
			childKey: "0",
			action: "steer",
			text: "hi",
			requestId: "r-attempted-closed",
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				closeLiveControlOwnerEpoch(route, "0", owner.epoch, now);
			},
			pollMs: 10,
			waitMs: 100,
		});
		assert.equal(result.state, "outcome-unknown");
		assert.equal(now, 10);
	});

	it("concludes outcome-unknown early when a replacement owner rotates the attempted request's epoch", async () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		seedResult(route, owner.epoch, "r-attempted-rotated", "delivery-attempted");
		let now = 0;
		const result = await performLiveControlAction({
			route,
			childKey: "0",
			action: "steer",
			text: "hi",
			requestId: "r-attempted-rotated",
			now: () => now,
			sleep: async (ms) => {
				now += ms;
				publishLiveControlOwnerEpoch(route, "0", { now });
			},
			pollMs: 10,
			waitMs: 100,
		});
		assert.equal(result.state, "outcome-unknown");
		assert.equal(now, 10);
	});

	it("reports submitted honestly (never fabricates outcome-unknown or acceptance) when the owner never picks up the request within the wait window", async () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		const clock = fakeClock();
		const result = await performLiveControlAction({ route, childKey: "0", action: "steer", text: "hi", now: clock.now, sleep: clock.sleep, pollMs: 10, waitMs: 35 });
		assert.equal(result.ok, false);
		assert.equal(result.state, "submitted");
		assert.match(result.message, /not yet acknowledged/);
	});
});
