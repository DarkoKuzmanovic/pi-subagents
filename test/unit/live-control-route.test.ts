import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	allocateLiveControlSequence,
	closeLiveControlOwnerEpoch,
	createNestedRoute,
	deleteLiveControlRequestFile,
	deriveLiveControlOutcome,
	publishLiveControlOwnerEpoch,
	readLiveControlOwnerEpoch,
	readLiveControlRequestState,
	readNestedControlRequests,
	readPendingLiveControlRequests,
	submitLiveControlRequest,
	writeLiveControlRequestState,
} from "../../src/runs/shared/nested-events.ts";
import type { NestedRoute } from "../../src/runs/shared/nested-events.ts";

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

describe("live control v2 route — owner epoch", () => {
	it("publishes an atomic, owner-only epoch record for a child key", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		assert.equal(owner.schemaVersion, 2);
		assert.equal(owner.rootRunId, route.rootRunId);
		assert.equal(owner.childKey, "0");
		assert.ok(owner.epoch.length > 0);
		assert.equal(owner.pid, process.pid);
		assert.equal(readLiveControlOwnerEpoch(route, "0")?.epoch, owner.epoch);
	});

	it("rotates to a new epoch on republish, invalidating the old one", () => {
		const route = trackRoute();
		const first = publishLiveControlOwnerEpoch(route, "0");
		const second = publishLiveControlOwnerEpoch(route, "0");
		assert.notEqual(first.epoch, second.epoch);
		assert.equal(readLiveControlOwnerEpoch(route, "0")?.epoch, second.epoch);
	});

	it("marks orderly shutdown as closed without touching a superseding epoch", () => {
		const route = trackRoute();
		const first = publishLiveControlOwnerEpoch(route, "0");
		closeLiveControlOwnerEpoch(route, "0", first.epoch);
		assert.ok(readLiveControlOwnerEpoch(route, "0")?.closedAt);

		const second = publishLiveControlOwnerEpoch(route, "0");
		closeLiveControlOwnerEpoch(route, "0", first.epoch); // stale close must not clobber the live epoch
		const current = readLiveControlOwnerEpoch(route, "0");
		assert.equal(current?.epoch, second.epoch);
		assert.equal(current?.closedAt, undefined);
	});

	it("keeps live control owner directories and files owner-only", () => {
		const route = trackRoute();
		publishLiveControlOwnerEpoch(route, "0");
		const ownerDir = path.join(path.dirname(route.eventSink), "live-control", "owners");
		const stat = fs.statSync(ownerDir);
		assert.equal(stat.mode & 0o777, 0o700);
		const file = fs.readdirSync(ownerDir).find((entry) => entry.startsWith("0."));
		assert.ok(file);
		const fileStat = fs.statSync(path.join(ownerDir, file as string));
		assert.equal(fileStat.mode & 0o777, 0o600);
	});
});

describe("live control v2 route — sequence allocation", () => {
	it("allocates a strictly increasing per-child-key sequence", () => {
		const route = trackRoute();
		assert.equal(allocateLiveControlSequence(route, "0"), 1);
		assert.equal(allocateLiveControlSequence(route, "0"), 2);
		assert.equal(allocateLiveControlSequence(route, "0"), 3);
		assert.equal(allocateLiveControlSequence(route, "1"), 1); // independent per child key
	});
});

describe("live control v2 route — request submission and state", () => {
	it("submits a bounded request and an initial durable submitted state", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const record = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "Focus on X" });
		assert.equal(record.schemaVersion, 2);
		assert.equal(record.mode, "steer");
		assert.equal(record.sequence, 1);

		const pending = readPendingLiveControlRequests(route, "0");
		assert.equal(pending.length, 1);
		assert.equal(pending[0]?.record.requestId, record.requestId);

		const state = readLiveControlRequestState(route, "0", record.sequence, record.requestId);
		assert.equal(state?.state, "submitted");
	});

	it("rejects request text over the bounded control-text limit", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const huge = "x".repeat(20 * 1024);
		assert.throws(() => submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "followUp", text: huge }));
	});

	it("never writes child transcript-shaped payloads: only bounded control text and metadata round-trip", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const record = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "followUp", text: "small note" });
		const [pending] = readPendingLiveControlRequests(route, "0");
		assert.deepEqual(Object.keys(pending?.record ?? {}).sort(), [
			"capabilityToken", "childKey", "epoch", "requestId", "rootRunId", "schemaVersion", "sequence", "text", "ts", "type", "mode",
		].sort());
		assert.equal(pending?.record.requestId, record.requestId);
	});

	it("moves terminal state via writeLiveControlRequestState and derives outcome-unknown while stuck at delivery-attempted", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const record = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "hi" });

		writeLiveControlRequestState(route, {
			schemaVersion: 2,
			type: "subagent.live-control.result",
			rootRunId: route.rootRunId,
			capabilityToken: route.capabilityToken,
			childKey: "0",
			epoch: owner.epoch,
			sequence: record.sequence,
			requestId: record.requestId,
			state: "delivery-attempted",
			message: "Calling pi.sendUserMessage.",
			ts: Date.now(),
		});

		const stuck = readLiveControlRequestState(route, "0", record.sequence, record.requestId);
		assert.equal(deriveLiveControlOutcome(stuck), "outcome-unknown");

		writeLiveControlRequestState(route, {
			schemaVersion: 2,
			type: "subagent.live-control.result",
			rootRunId: route.rootRunId,
			capabilityToken: route.capabilityToken,
			childKey: "0",
			epoch: owner.epoch,
			sequence: record.sequence,
			requestId: record.requestId,
			state: "accepted-by-pi",
			disposition: "started-turn",
			message: "Accepted by Pi (started-turn).",
			ts: Date.now(),
		});
		const done = readLiveControlRequestState(route, "0", record.sequence, record.requestId);
		assert.equal(deriveLiveControlOutcome(done), "accepted-by-pi");
	});

	it("deletes a processed request file without disturbing sibling requests", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const first = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "a" });
		submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "b" });
		const [firstPending] = readPendingLiveControlRequests(route, "0");
		assert.equal(firstPending?.record.requestId, first.requestId);
		deleteLiveControlRequestFile(firstPending?.filePath as string);
		const remaining = readPendingLiveControlRequests(route, "0");
		assert.equal(remaining.length, 1);
		assert.notEqual(remaining[0]?.record.requestId, first.requestId);
	});

	it("reuses the original durable state/sequence on an exact requestId retry and never downgrades a terminal accepted-by-pi state", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		const first = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "first" });

		// Simulate the owner having already delivered and accepted this request.
		writeLiveControlRequestState(route, {
			schemaVersion: 2,
			type: "subagent.live-control.result",
			rootRunId: route.rootRunId,
			capabilityToken: route.capabilityToken,
			childKey: "0",
			epoch: owner.epoch,
			sequence: first.sequence,
			requestId: first.requestId,
			state: "accepted-by-pi",
			disposition: "started-turn",
			message: "Accepted by Pi (started-turn).",
			ts: Date.now(),
		});
		// The owner deletes the pending request file once it has written a terminal state.
		const [pendingBeforeRetry] = readPendingLiveControlRequests(route, "0");
		deleteLiveControlRequestFile(pendingBeforeRetry?.filePath as string);
		// Exact retry: same childKey, sequence, and requestId reaching the standard submit helper again.
		const retry = submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "first", sequence: 1, requestId: first.requestId });

		assert.equal(retry.sequence, 1, "retry must reuse the original sequence, not allocate a new one");
		const state = readLiveControlRequestState(route, "0", 1, first.requestId);
		assert.equal(state?.state, "accepted-by-pi", "an exact retry must never downgrade a terminal accepted-by-pi state to submitted");
		assert.equal(state?.disposition, "started-turn");

		// The retry must not have written a new pending request file or consumed a fresh sequence slot.
		assert.equal(readPendingLiveControlRequests(route, "0").length, 0, "the retry must not write a duplicate request file");
		assert.equal(allocateLiveControlSequence(route, "0"), 2, "no extra sequence should have been consumed by the retry");
	});
});

describe("live control v2 route — backward compatibility with the v1 nested control route", () => {
	it("leaves legacy interrupt/resume control-request reads unaffected by v2 records in the same route", () => {
		const route = trackRoute();
		const owner = publishLiveControlOwnerEpoch(route, "0");
		submitLiveControlRequest(route, { childKey: "0", epoch: owner.epoch, mode: "steer", text: "v2 only" });
		// v1 control-request reader only looks at route.controlInbox; v2 lives under a separate live-control/ subtree.
		assert.deepEqual(readNestedControlRequests(route), []);
	});
});
