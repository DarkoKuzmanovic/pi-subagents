import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import {
	createNestedRoute,
	readNestedControlRequests,
	readNestedControlResults,
	writeNestedControlRequest,
	writeNestedControlResult,
} from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentState,
} from "../../src/shared/types.ts";

type PiEventHandler = (event: unknown, context: unknown) => unknown;
type IntercomEventHandler = (data: unknown) => void;

function createControlledIntercomBus(): {
	events: ExtensionAPI["events"];
	deliveryRequests: Array<{ requestId: string }>;
	acknowledge(index: number): void;
} {
	const handlers = new Map<string, Set<IntercomEventHandler>>();
	const deliveryRequests: Array<{ requestId: string }> = [];
	const events = {
		on(name: string, handler: IntercomEventHandler) {
			const current = handlers.get(name) ?? new Set<IntercomEventHandler>();
			current.add(handler);
			handlers.set(name, current);
			return () => current.delete(handler);
		},
		emit(name: string, data: unknown) {
			if (name === SUBAGENT_RESULT_INTERCOM_EVENT) {
				const requestId = (data as { requestId?: unknown }).requestId;
				assert.equal(typeof requestId, "string");
				deliveryRequests.push({ requestId });
			}
			for (const handler of handlers.get(name) ?? []) handler(data);
		},
	} as ExtensionAPI["events"];
	return {
		events,
		deliveryRequests,
		acknowledge(index: number) {
			const request = deliveryRequests[index];
			assert.ok(request, `missing intercom delivery request ${index}`);
			events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, { requestId: request.requestId, delivered: true });
		},
	};
}

function createFakePi(events?: ExtensionAPI["events"]): { pi: ExtensionAPI; emit(name: string): Promise<void> } {
	const handlers = new Map<string, PiEventHandler[]>();
	const pi = {
		events: events ?? { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		on(name: string, handler: PiEventHandler) {
			const existing = handlers.get(name) ?? [];
			existing.push(handler);
			handlers.set(name, existing);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		async emit(name: string): Promise<void> {
			for (const handler of handlers.get(name) ?? []) {
				await handler({}, {});
			}
		},
	};
}

function createTestState(runId: string): SubagentState {
	const now = Date.now();
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map([
			[runId, { runId, mode: "single", startedAt: now, updatedAt: now, currentAgent: "worker", currentIndex: 0 }],
		]),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

test("fanout-child reload hands off in-flight and retry state without duplicate delivery", async () => {
	const route = createNestedRoute("fanout-child-lifecycle-test");
	const routeRoot = path.dirname(route.eventSink);
	const envValues = new Map<string, string | undefined>();
	const envUpdates: Record<string, string> = {
		[SUBAGENT_CHILD_ENV]: "1",
		[SUBAGENT_FANOUT_CHILD_ENV]: "1",
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
	};
	for (const [key, value] of Object.entries(envUpdates)) {
		envValues.set(key, process.env[key]);
		process.env[key] = value;
	}

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const listenerKey = "__piSubagentFanoutChildControlLifecycle";
	const originalRegistered = globalStore[registeredKey];
	const originalListener = globalStore[listenerKey];
	delete globalStore[registeredKey];
	delete globalStore[listenerKey];

	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const timerCallbacks = new Map<NodeJS.Timeout, () => void>();
	globalThis.setInterval = (((callback: TimerHandler) => {
		assert.equal(typeof callback, "function");
		const timer = { unref() {} } as unknown as NodeJS.Timeout;
		timerCallbacks.set(timer, callback as () => void);
		return timer;
	}) as unknown) as typeof setInterval;
	globalThis.clearInterval = (((timer: NodeJS.Timeout | undefined) => {
		if (timer !== undefined) timerCallbacks.delete(timer);
	}) as unknown) as typeof clearInterval;

	const runOnlyTimer = (): void => {
		assert.equal(timerCallbacks.size, 1, "expected exactly one active listener timer");
		const callback = [...timerCallbacks.values()][0];
		assert.ok(callback);
		callback();
	};

	try {
		const targetRunId = "live-nested-run";
		const state = createTestState(targetRunId);
		let interruptCalls = 0;
		const control = state.foregroundControls.get(targetRunId);
		assert.ok(control);
		control.interrupt = () => {
			interruptCalls++;
			return true;
		};
		const intercom = createControlledIntercomBus();
		const first = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(first.pi, { state });
		await first.emit("session_start");
		assert.strictEqual(timerCallbacks.size, 1);

		writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "reload-drain-request",
			targetRunId,
			action: "resume",
			message: "Continue after reload.",
		});
		runOnlyTimer();
		assert.equal(intercom.deliveryRequests.length, 1, "the old listener should begin one intercom delivery");

		const replacement = createFakePi(intercom.events);
		let replacementRegistered = false;
		const replacementRegistration = Promise.resolve(registerFanoutChildSubagentExtension(replacement.pi, { state })).then(() => {
			replacementRegistered = true;
		});
		await Promise.resolve();
		assert.equal(replacementRegistered, false, "reload registration must wait for the old in-flight request");
		assert.equal(timerCallbacks.size, 0, "the old listener timer must stop while its request drains");

		intercom.acknowledge(0);
		await replacementRegistration;
		assert.equal(readNestedControlRequests(route).length, 0, "the drained request should be removed before replacement starts");
		assert.equal(readNestedControlResults(route).length, 1, "the drained request should publish exactly one result");

		await replacement.emit("session_start");
		assert.equal(timerCallbacks.size, 1);
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(intercom.deliveryRequests.length, 1, "the replacement listener must not redeliver the drained request");
		assert.equal(readNestedControlResults(route).length, 1, "the replacement listener must not duplicate the result");

		const failing = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(failing.pi, {
			state,
			logError() {},
			writeControlResult(resultRoute, result) {
				if (result.requestId === "reload-pending-result") throw new Error("simulated result write failure");
				writeNestedControlResult(resultRoute, result);
			},
		});
		await failing.emit("session_start");
		writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "reload-pending-result",
			targetRunId,
			action: "interrupt",
		});
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 1, "the failing owner should deliver the interrupt once");
		assert.equal(readNestedControlRequests(route).length, 1, "a failed result write should retain the request");

		const intermediate = createFakePi(intercom.events);
		const final = createFakePi(intercom.events);
		const intermediateRegistration = registerFanoutChildSubagentExtension(intermediate.pi, { state });
		const finalRegistration = registerFanoutChildSubagentExtension(final.pi, { state });
		await Promise.all([intermediateRegistration, finalRegistration]);
		await final.emit("session_start");
		assert.equal(timerCallbacks.size, 1, "only the final overlapping reload owner should poll");
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 1, "the final owner must publish the pending result without redelivering the interrupt");
		assert.equal(readNestedControlRequests(route).length, 0, "the final owner should remove the retained request after writing its result");
		assert.equal(readNestedControlResults(route).length, 2, "the pending result should be published exactly once");

		const ambiguousWrite = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(ambiguousWrite.pi, {
			state,
			logError() {},
			writeControlResult(resultRoute, result) {
				writeNestedControlResult(resultRoute, result);
				if (result.requestId === "reload-ambiguous-result") throw new Error("simulated post-write failure");
			},
		});
		await ambiguousWrite.emit("session_start");
		writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "reload-ambiguous-result",
			targetRunId,
			action: "interrupt",
		});
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 2, "the ambiguous-write owner should deliver the interrupt once");
		assert.equal(readNestedControlRequests(route).length, 1, "a post-write failure should retain the request");
		assert.equal(readNestedControlResults(route).length, 3, "the post-write failure should leave one durable result");

		const afterAmbiguousWrite = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(afterAmbiguousWrite.pi, { state });
		await afterAmbiguousWrite.emit("session_start");
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 2, "the replacement must not redeliver an ambiguously completed request");
		assert.equal(readNestedControlRequests(route).length, 0, "the replacement should clean up the ambiguously completed request");
		assert.equal(readNestedControlResults(route).length, 3, "the replacement must not duplicate an already-durable result");

		const unlinkFailing = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(unlinkFailing.pi, {
			state,
			unlinkControlRequest() {
				throw new Error("simulated request unlink failure");
			},
		});
		await unlinkFailing.emit("session_start");
		writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "reload-retained-request",
			targetRunId,
			action: "interrupt",
		});
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 3, "the unlink-failing owner should deliver the interrupt once");
		assert.equal(readNestedControlRequests(route).length, 1, "an unlink failure should retain the completed request");
		assert.equal(readNestedControlResults(route).length, 4, "the unlink-failing owner should still publish its result");

		const afterUnlinkFailure = createFakePi(intercom.events);
		await registerFanoutChildSubagentExtension(afterUnlinkFailure.pi, { state });
		await afterUnlinkFailure.emit("session_start");
		runOnlyTimer();
		await Promise.resolve();
		assert.equal(interruptCalls, 3, "the replacement must not redeliver a request that already has a result");
		assert.equal(readNestedControlRequests(route).length, 0, "the replacement should clean up the retained completed request");
		assert.equal(readNestedControlResults(route).length, 4, "cleanup must not duplicate the durable result");

		for (const stale of [first, replacement, failing, intermediate, final, ambiguousWrite, afterAmbiguousWrite, unlinkFailing]) {
			await stale.emit("session_shutdown");
			assert.strictEqual(timerCallbacks.size, 1, "stale shutdown must not stop the final replacement listener");
		}
		await afterUnlinkFailure.emit("session_shutdown");
		assert.strictEqual(timerCallbacks.size, 0);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		if (originalRegistered === undefined) delete globalStore[registeredKey];
		else globalStore[registeredKey] = originalRegistered;
		if (originalListener === undefined) delete globalStore[listenerKey];
		else globalStore[listenerKey] = originalListener;
		for (const [key, value] of envValues) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(routeRoot, { recursive: true, force: true });
	}
});
