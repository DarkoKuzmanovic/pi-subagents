import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	EVENTS_CAPPED_EVENT_TYPE,
	EVENTS_JSONL_BYTE_BUDGET,
	RUNAWAY_HARD_CAP_BYTES,
	RUNAWAY_NO_PROGRESS_BYTES,
	createRunEventAppender,
	createStreamWatchdog,
	eventShowsProgress,
	isPassthroughEventType,
} from "../../src/runs/shared/stream-budget.js";

const MB = 1024 * 1024;

function thinkingEvent(size = 32): Record<string, unknown> {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(size) }] },
	};
}

function textEvent(text = "hello"): Record<string, unknown> {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

describe("stream-budget constants", () => {
	it("uses 50 MB events budget, 30 MB no-progress trip, 200 MB hard cap", () => {
		assert.equal(EVENTS_JSONL_BYTE_BUDGET, 50 * MB);
		assert.equal(RUNAWAY_NO_PROGRESS_BYTES, 30 * MB);
		assert.equal(RUNAWAY_HARD_CAP_BYTES, 200 * MB);
	});
});

describe("eventShowsProgress", () => {
	it("treats non-empty assistant text blocks as progress", () => {
		assert.equal(eventShowsProgress(textEvent()), true);
	});

	it("treats toolCall and tool_use blocks as progress", () => {
		for (const type of ["toolCall", "tool_use"]) {
			const event = {
				type: "message_end",
				message: { role: "assistant", content: [{ type, id: "t1", name: "bash" }] },
			};
			assert.equal(eventShowsProgress(event), true, type);
		}
	});

	it("treats tool execution events as progress", () => {
		assert.equal(eventShowsProgress({ type: "tool_execution_start", toolName: "bash" }), true);
		assert.equal(eventShowsProgress({ type: "tool_execution_end", toolName: "bash" }), true);
		assert.equal(eventShowsProgress({ type: "tool_result_end", message: { role: "toolResult" } }), true);
	});

	it("does NOT treat thinking-only assistant messages as progress", () => {
		assert.equal(eventShowsProgress(thinkingEvent()), false);
	});

	it("does NOT treat empty/whitespace text blocks as progress", () => {
		assert.equal(eventShowsProgress(textEvent("")), false);
		assert.equal(eventShowsProgress(textEvent("   \n")), false);
	});

	it("does NOT treat non-assistant messages or malformed events as progress", () => {
		assert.equal(eventShowsProgress({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }), false);
		assert.equal(eventShowsProgress(null), false);
		assert.equal(eventShowsProgress("junk"), false);
		assert.equal(eventShowsProgress({ type: "message_end", message: { role: "assistant", content: "not-an-array" } }), false);
		assert.equal(eventShowsProgress({}), false);
	});
});

describe("createStreamWatchdog", () => {
	it("accounts bytes cumulatively and ignores bogus counts", () => {
		const watchdog = createStreamWatchdog();
		watchdog.addBytes(100);
		watchdog.addBytes(250);
		watchdog.addBytes(Number.NaN);
		watchdog.addBytes(-50);
		assert.equal(watchdog.bytes, 350);
		assert.equal(watchdog.tripped, false);
	});

	it("does not trip on a healthy small stream (90 KB - 550 KB)", () => {
		const watchdog = createStreamWatchdog();
		for (let i = 0; i < 550; i++) {
			assert.equal(watchdog.addBytes(1024), undefined);
			watchdog.observeEvent(thinkingEvent());
		}
		assert.equal(watchdog.tripped, false);
		assert.equal(watchdog.bytes, 550 * 1024);
	});

	it("trips just past 30 MB with no progress marker, with a thinking-loop message", () => {
		const watchdog = createStreamWatchdog();
		assert.equal(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES), undefined, "exactly at the limit must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message, "must trip past the limit");
		assert.match(message!, /^runaway output aborted: 30 MB of model events with no text or tool activity \(likely a thinking loop\)$/);
		assert.equal(watchdog.tripped, true);
	});

	it("returns the trip message exactly once", () => {
		const watchdog = createStreamWatchdog();
		assert.ok(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES + 1));
		assert.equal(watchdog.addBytes(10 * MB), undefined);
		assert.equal(watchdog.addBytes(500 * MB), undefined);
		assert.equal(watchdog.tripped, true);
	});

	it("does NOT trip at 30 MB+ when a progress marker was seen (heavy healthy run)", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(textEvent("real output"));
		assert.equal(watchdog.addBytes(35 * MB), undefined);
		assert.equal(watchdog.tripped, false);
		assert.equal(watchdog.hasProgress, true);
	});

	it("progress observed via tool_execution_start also suppresses the 30 MB trip", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent({ type: "tool_execution_start", toolName: "read" });
		assert.equal(watchdog.addBytes(35 * MB), undefined);
		assert.equal(watchdog.tripped, false);
	});

	it("thinking-only events do not count as progress: still trips at 30 MB", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(thinkingEvent());
		assert.ok(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES + 1));
	});

	it("hard cap trips past 200 MB even with progress", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(textEvent("real output"));
		assert.equal(watchdog.addBytes(RUNAWAY_HARD_CAP_BYTES), undefined, "exactly at the hard cap must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message);
		assert.match(message!, /^runaway output aborted: 200 MB of model events exceeded the 200 MB hard output cap$/);
		assert.equal(watchdog.tripped, true);
	});

	it("late progress after tripping does not un-trip", () => {
		const watchdog = createStreamWatchdog();
		assert.ok(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES + 1));
		watchdog.observeEvent(textEvent("too late"));
		assert.equal(watchdog.tripped, true);
	});

	it("honors custom limits", () => {
		const watchdog = createStreamWatchdog({ noProgressBytes: 100, hardCapBytes: 1000 });
		assert.equal(watchdog.addBytes(100), undefined);
		assert.ok(watchdog.addBytes(1));
	});

	it("observeEvent never throws on hostile inputs", () => {
		const watchdog = createStreamWatchdog();
		const hostile = { get message() { throw new Error("boom"); } };
		watchdog.observeEvent(hostile);
		assert.equal(watchdog.hasProgress, false);
	});
});

describe("isPassthroughEventType", () => {
	it("classifies child stdout/stderr relays and raw child events as passthrough", () => {
		assert.equal(isPassthroughEventType("subagent.child.stdout"), true);
		assert.equal(isPassthroughEventType("subagent.child.stderr"), true);
		assert.equal(isPassthroughEventType("message_end"), true);
		assert.equal(isPassthroughEventType("message_delta"), true);
		assert.equal(isPassthroughEventType(undefined), true);
		assert.equal(isPassthroughEventType(42), true);
	});

	it("classifies subagent.* lifecycle events as structural", () => {
		for (const type of [
			"subagent.run.started",
			"subagent.run.completed",
			"subagent.step.started",
			"subagent.step.completed",
			"subagent.step.failed",
			"subagent.parallel.completed",
			"subagent.control",
			"subagent.fanout.materialized",
			EVENTS_CAPPED_EVENT_TYPE,
		]) {
			assert.equal(isPassthroughEventType(type), false, type);
		}
	});
});

describe("createRunEventAppender", () => {
	function collector(): { lines: Array<{ path: string; line: string }>; write: (path: string, line: string) => void } {
		const lines: Array<{ path: string; line: string }> = [];
		return { lines, write: (path, line) => lines.push({ path, line }) };
	}

	it("appends everything and accounts bytes while under budget", () => {
		const sink = collector();
		const appender = createRunEventAppender(sink.write, 10_000);
		appender.append("/run/events.jsonl", { type: "subagent.run.started", ts: 1 });
		appender.append("/run/events.jsonl", { type: "message_end", message: { role: "assistant" } });
		assert.equal(sink.lines.length, 2);
		const expectedBytes = sink.lines.reduce((sum, entry) => sum + Buffer.byteLength(entry.line) + 1, 0);
		assert.equal(appender.bytesFor("/run/events.jsonl"), expectedBytes);
		assert.equal(appender.cappedFor("/run/events.jsonl"), false);
	});

	it("emits exactly one capped notice with droppedFrom when the budget trips", () => {
		const sink = collector();
		const appender = createRunEventAppender(sink.write, 200);
		appender.append("/run/events.jsonl", { type: "message_end", junk: "x".repeat(300) });
		assert.equal(appender.cappedFor("/run/events.jsonl"), true);
		const notices = sink.lines.filter((entry) => entry.line.includes(EVENTS_CAPPED_EVENT_TYPE));
		assert.equal(notices.length, 1);
		const parsed = JSON.parse(notices[0]!.line) as { type: string; droppedFrom: number };
		assert.equal(parsed.type, EVENTS_CAPPED_EVENT_TYPE);
		assert.ok(parsed.droppedFrom > 200, "droppedFrom records the byte count at cap time");
	});

	it("after the cap, drops passthrough events but keeps structural ones", () => {
		const sink = collector();
		const appender = createRunEventAppender(sink.write, 100);
		appender.append("/run/events.jsonl", { type: "message_end", junk: "x".repeat(200) }); // trips
		sink.lines.length = 0;

		appender.append("/run/events.jsonl", { type: "subagent.child.stdout", line: "spam" });
		appender.append("/run/events.jsonl", { type: "subagent.child.stderr", line: "spam" });
		appender.append("/run/events.jsonl", { type: "message_end", message: {} });
		appender.append("/run/events.jsonl", { junk: "no type" });
		assert.equal(sink.lines.length, 0, "passthrough events are dropped after the cap");

		appender.append("/run/events.jsonl", { type: "subagent.step.completed", stepIndex: 0 });
		appender.append("/run/events.jsonl", { type: "subagent.run.completed", status: "complete" });
		assert.deepEqual(
			sink.lines.map((entry) => (JSON.parse(entry.line) as { type: string }).type),
			["subagent.step.completed", "subagent.run.completed"],
		);
	});

	it("does not emit a second capped notice", () => {
		const sink = collector();
		const appender = createRunEventAppender(sink.write, 100);
		appender.append("/run/events.jsonl", { type: "message_end", junk: "x".repeat(200) });
		appender.append("/run/events.jsonl", { type: "subagent.step.failed", junk: "y".repeat(200) });
		appender.append("/run/events.jsonl", { type: "subagent.step.failed", junk: "z".repeat(200) });
		const notices = sink.lines.filter((entry) => entry.line.includes(EVENTS_CAPPED_EVENT_TYPE));
		assert.equal(notices.length, 1);
	});

	it("tracks budgets independently per events file", () => {
		const sink = collector();
		const appender = createRunEventAppender(sink.write, 100);
		appender.append("/run-a/events.jsonl", { type: "message_end", junk: "x".repeat(200) });
		assert.equal(appender.cappedFor("/run-a/events.jsonl"), true);
		assert.equal(appender.cappedFor("/run-b/events.jsonl"), false);
		appender.append("/run-b/events.jsonl", { type: "message_end", small: true });
		assert.ok(sink.lines.some((entry) => entry.path === "/run-b/events.jsonl"));
	});

	it("never throws: unserializable payloads and failing writers are swallowed", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const appender = createRunEventAppender(() => {
			throw new Error("disk full");
		});
		assert.doesNotThrow(() => appender.append("/run/events.jsonl", cyclic));
		assert.doesNotThrow(() => appender.append("/run/events.jsonl", { type: "subagent.run.started" }));
	});
});
