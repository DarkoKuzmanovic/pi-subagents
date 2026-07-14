import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DELTA_EVENT_OVERHEAD_BYTES,
	EVENTS_CAPPED_EVENT_TYPE,
	EVENTS_JSONL_BYTE_BUDGET,
	LOOP_MAX_PERIOD_CHARS,
	LOOP_SUFFIX_CHARS,
	LOOP_SUSTAIN_CHARS,
	RUNAWAY_ACCOUNTED_NO_PROGRESS_BYTES,
	RUNAWAY_HARD_CAP_BYTES,
	RUNAWAY_NO_PROGRESS_BYTES,
	RUNAWAY_RAW_HARD_CAP_BYTES,
	createRunEventAppender,
	createStreamWatchdog,
	eventShowsProgress,
	extractStreamingDelta,
	isPassthroughEventType,
	normalizeForLoopDetection,
	periodicTailPeriod,
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

/** A streaming `message_update` event carrying one content delta. */
function deltaEvent(kind: string, contentIndex: number, delta: string): Record<string, unknown> {
	return {
		type: "message_update",
		assistantMessageEvent: { type: kind, contentIndex, delta },
	};
}

/**
 * Degenerate tool-call loop fixture modeled on captured production stream
 * 7aaa139c (MiniMax-M3): the model repeats the trailing key-value pair of a
 * tool call's JSON arguments with CYCLING values (30000/60000/10000) and
 * VARYING chunk boundaries (one or two fragment copies per delta). Exact-match
 * consecutive-delta detection never fires on this shape — the real streams
 * max out at 9 consecutive identical deltas.
 */
function m3TimeoutLoopDeltas(count: number): Array<Record<string, unknown>> {
	const values = [30000, 60000, 10000];
	const events: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) {
		const copies = i % 3 === 0 ? 2 : 1;
		let delta = "";
		for (let c = 0; c < copies; c++) {
			delta += `, "timeout": ${values[(i + c) % values.length]}`;
		}
		events.push(deltaEvent("toolcall_delta", 1, delta));
	}
	return events;
}

/**
 * Interleaved two-block loop fixture modeled on captured production stream
 * a44b411f (MiniMax-M3): TWO tool calls stream concurrently and their looping
 * deltas alternate contentIndex 0/1 on every event, so any single-block
 * detector state resets on each delta.
 */
function m3InterleavedLoopDeltas(count: number): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (let i = 0; i < count; i++) {
		if (i % 2 === 0) {
			const copies = i % 4 === 0 ? 2 : 1;
			events.push(deltaEvent("toolcall_delta", 0, ', "glob": "", "summary": false'.repeat(copies)));
		} else {
			const copies = i % 3 === 0 ? 3 : 1;
			events.push(deltaEvent("toolcall_delta", 1, ', "map": true'.repeat(copies)));
		}
	}
	return events;
}

/** Aperiodic letters-only token (digits collapse under normalization, so avoid them). */
function tok(n: number): string {
	return n.toString(36).replace(/[0-9]/g, (c) => "ghijklmnopq"[Number(c)] ?? "z");
}

describe("stream-budget constants", () => {
	it("uses 50 MB events budget, 8 MB delta-aware / 32 MB non-JSON no-progress trips, 200 MB accounted hard cap, 1 GB raw backstop", () => {
		assert.equal(EVENTS_JSONL_BYTE_BUDGET, 50 * MB);
		assert.equal(RUNAWAY_ACCOUNTED_NO_PROGRESS_BYTES, 8 * MB);
		assert.equal(RUNAWAY_NO_PROGRESS_BYTES, 32 * MB);
		assert.equal(RUNAWAY_HARD_CAP_BYTES, 200 * MB);
		assert.equal(RUNAWAY_RAW_HARD_CAP_BYTES, 1024 * MB);
	});

	it("loop detector tuning stays at the calibrated values", () => {
		assert.equal(LOOP_SUFFIX_CHARS, 1024);
		assert.equal(LOOP_MAX_PERIOD_CHARS, 128);
		assert.equal(LOOP_SUSTAIN_CHARS, 8192);
		assert.equal(DELTA_EVENT_OVERHEAD_BYTES, 64);
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

	it("uses the current streaming delta, not stale snapshot content, as progress", () => {
		const staleSnapshot = {
			...deltaEvent("thinking_delta", 1, "still thinking"),
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "earlier text from this message" },
					{ type: "thinking", thinking: "still thinking" },
				],
			},
		};

		assert.equal(eventShowsProgress(staleSnapshot), false);
		assert.equal(eventShowsProgress(deltaEvent("text_delta", 0, "new text")), true);
		assert.equal(eventShowsProgress(deltaEvent("toolcall_delta", 1, '{"path":"src"}')), true);
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

describe("extractStreamingDelta", () => {
	it("extracts kind, contentIndex and delta from message_update events", () => {
		const extracted = extractStreamingDelta(deltaEvent("toolcall_delta", 1, ', "timeout": 60000'));
		assert.deepEqual(extracted, { kind: "toolcall_delta", contentIndex: 1, delta: ', "timeout": 60000' });
	});

	it("falls back to assistantEvent when assistantMessageEvent is absent", () => {
		const extracted = extractStreamingDelta({
			type: "message_update",
			assistantEvent: { type: "text_delta", contentIndex: 0, delta: "hi" },
		});
		assert.equal(extracted?.delta, "hi");
	});

	it("returns undefined for non-update events, empty deltas, and malformed shapes", () => {
		assert.equal(extractStreamingDelta(textEvent()), undefined);
		assert.equal(extractStreamingDelta(deltaEvent("text_delta", 0, "")), undefined);
		assert.equal(extractStreamingDelta({ type: "message_update" }), undefined);
		assert.equal(extractStreamingDelta({ type: "message_update", assistantMessageEvent: { delta: 42 } }), undefined);
		assert.equal(extractStreamingDelta(null), undefined);
	});
});

describe("normalizeForLoopDetection", () => {
	it("collapses cycling numeric literals into one pattern", () => {
		assert.equal(normalizeForLoopDetection(', "timeout": 30000'), normalizeForLoopDetection(', "timeout": 60000'));
	});

	it("collapses whitespace runs", () => {
		assert.equal(normalizeForLoopDetection("a  \n\tb"), "a b");
	});
});

describe("periodicTailPeriod", () => {
	it("finds the smallest period of a periodic suffix", () => {
		assert.equal(periodicTailPeriod("abc".repeat(20), 32, 8), 3);
	});

	it("returns 0 for non-periodic or too-short tails", () => {
		assert.equal(periodicTailPeriod("the quick brown fox jumps over the lazy dog".repeat(2), 32, 8), 0);
		assert.equal(periodicTailPeriod("abcabc", 32, 8), 0, "tail shorter than the suffix window");
	});

	it("respects the max period bound", () => {
		const fragment = "abcdefghijklmnopqrst"; // 20 distinct chars: smallest period 20
		assert.equal(periodicTailPeriod(fragment.repeat(10), 100, 8), 0, "period 20 > max 8");
		assert.equal(periodicTailPeriod(fragment.repeat(10), 100, 32), 20);
	});
});

describe("createStreamWatchdog: raw-byte guards (addBytes)", () => {
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

	it("trips just past the 32 MB non-JSON backstop with no progress marker", () => {
		const watchdog = createStreamWatchdog();
		assert.equal(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES), undefined, "exactly at the limit must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message, "must trip past the limit");
		assert.match(message!, /^runaway output aborted: 32 MB of unparsed non-JSON stdout since last text or tool activity/);
		assert.equal(watchdog.tripped, true);
	});

	it("returns the trip message exactly once", () => {
		const watchdog = createStreamWatchdog();
		assert.ok(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES + 1));
		assert.equal(watchdog.addBytes(10 * MB), undefined);
		assert.equal(watchdog.addBytes(500 * MB), undefined);
		assert.equal(watchdog.tripped, true);
	});

	it("trips on a later no-progress flood even after earlier progress", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(textEvent("real output"));
		assert.equal(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES), undefined, "exactly one rolling window must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message);
		assert.match(message!, /since last text or tool activity/);
		assert.match(message!, /accounted .* amplification/);
		assert.equal(watchdog.tripped, true);
	});

	it("a tool event resets only the current no-progress byte window", () => {
		const watchdog = createStreamWatchdog({ noProgressBytes: 100, rawHardCapBytes: 10_000 });
		assert.equal(watchdog.addBytes(80), undefined);
		watchdog.observeEvent({ type: "tool_execution_start", toolName: "read" });
		assert.equal(watchdog.addBytes(100), undefined, "exactly one window after progress must not trip");
		assert.match(watchdog.addBytes(1) ?? "", /since last text or tool activity/);
	});

	it("a current text delta resets the rolling window", () => {
		const watchdog = createStreamWatchdog({ noProgressBytes: 100, rawHardCapBytes: 10_000 });
		assert.equal(watchdog.addBytes(80), undefined);
		watchdog.observeEvent(deltaEvent("text_delta", 0, "working"));
		assert.equal(watchdog.addBytes(100), undefined);
		assert.ok(watchdog.addBytes(1));
	});

	it("thinking-only events do not count as progress: still trips at the raw backstop", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(thinkingEvent());
		assert.ok(watchdog.addBytes(RUNAWAY_NO_PROGRESS_BYTES + 1));
	});

	it("raw backstop trips past 1 GB even with progress", () => {
		const watchdog = createStreamWatchdog({ noProgressBytes: RUNAWAY_RAW_HARD_CAP_BYTES * 2 });
		watchdog.observeEvent(textEvent("real output"));
		assert.equal(watchdog.addBytes(RUNAWAY_RAW_HARD_CAP_BYTES), undefined, "exactly at the backstop must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message);
		assert.match(message!, /raw output backstop/);

		assert.match(message!, /accounted .* amplification/);
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
});

describe("createStreamWatchdog: delta-aware accounted hard cap (observeEvent)", () => {
	it("accounts streaming deltas at delta size + flat overhead, NOT full snapshot size", () => {
		const watchdog = createStreamWatchdog();
		// A snapshot-heavy 100 KB serialized line whose actual delta is 5 chars.
		watchdog.observeEvent(deltaEvent("text_delta", 0, "hello"), 100_000);
		assert.equal(watchdog.accountedBytes, 5 + DELTA_EVENT_OVERHEAD_BYTES);
	});

	it("never accounts more than the serialized line for tiny events", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(deltaEvent("text_delta", 0, "hi"), 20);
		assert.equal(watchdog.accountedBytes, 20);
	});

	it("accounts non-delta events at full serialized size", () => {
		const watchdog = createStreamWatchdog();
		watchdog.observeEvent(textEvent("done"), 500);
		assert.equal(watchdog.accountedBytes, 500);
	});

	it("trips the hard cap on accounted bytes even with progress", () => {
		const watchdog = createStreamWatchdog({ hardCapBytes: 1000 });
		watchdog.observeEvent(textEvent("progress"));
		assert.equal(watchdog.observeEvent(thinkingEvent(), 1000), undefined, "exactly at the cap must not trip");
		const message = watchdog.observeEvent(thinkingEvent(), 1);
		assert.ok(message);
		assert.match(message!, /hard output cap/);
		assert.equal(watchdog.tripped, true);
	});

	it("quadratic snapshot amplification does NOT trip the cap (the false-positive fix)", () => {
		// Simulate a growing message streamed as full snapshots: N updates whose
		// serialized size grows linearly, but each carrying a tiny delta. Under
		// raw accounting this sums quadratically; delta-aware accounting keeps
		// it proportional to actual generated content.
		const watchdog = createStreamWatchdog({ hardCapBytes: 1 * MB });
		let rawTotal = 0;
		const alpha = (n: number): string => n.toString(36).replace(/[0-9]/g, (c) => "ghijklmnopq"[Number(c)] ?? "z");
		for (let i = 1; i <= 2000; i++) {
			const serialized = i * 100; // snapshot grows every delta
			rawTotal += serialized;
			// Aperiodic letters-only content: honest generation, not a loop.
			const error = watchdog.observeEvent(deltaEvent("thinking_delta", 0, ` word${alpha(i)}`), serialized);
			assert.equal(error, undefined, `must not trip at update ${i}`);
		}
		assert.ok(rawTotal > 100 * MB, "raw stream would have blown a 100 MB raw cap");
		assert.ok(watchdog.accountedBytes < 1 * MB, "accounted bytes stay proportional to content");
	});
});

describe("createStreamWatchdog: delta-aware no-progress trip (snapshot-amplification fix)", () => {
	it("trips when ACCOUNTED output since progress exceeds the limit", () => {
		const watchdog = createStreamWatchdog({ accountedNoProgressBytes: 1000 });
		let message: string | undefined;
		for (let i = 0; i < 200 && !message; i++) {
			message = watchdog.observeEvent(deltaEvent("thinking_delta", 0, ` reasoning about ${tok(i)}`), 50_000);
		}
		assert.ok(message, "must trip on accounted-since-progress");
		assert.match(message!, /model output since last text or tool activity/);
		assert.match(message!, /likely a thinking loop/);
		assert.equal(watchdog.tripped, true);
	});

	it("does NOT trip on snapshot-amplified micro-delta thinking (the captured HY false positive)", () => {
		// Coherent thinking streamed as thousands of ~6-char deltas, each re-serialized into
		// a growing snapshot. Total raw balloons far past the 32 MB non-JSON backstop, but every
		// delta is a PARSED event that credits its bytes back, so only one uncredited snapshot is
		// ever in flight and the real generated content (accounted) stays tiny.
		const watchdog = createStreamWatchdog();
		let rawSinceProgress = 0;
		for (let i = 1; i <= 4000; i++) {
			const snapshotBytes = i * 12; // snapshot grows every delta (quadratic raw)
			rawSinceProgress += snapshotBytes;
			assert.equal(watchdog.addBytes(snapshotBytes), undefined, `raw addBytes must not trip at ${i}`);
			assert.equal(
				watchdog.observeEvent(deltaEvent("thinking_delta", 0, ` w${tok(i)}`), snapshotBytes),
				undefined,
				`observeEvent must not trip at ${i}`,
			);
		}
		assert.ok(rawSinceProgress > RUNAWAY_NO_PROGRESS_BYTES, "total raw must exceed the 32 MB non-JSON backstop");
		assert.ok(watchdog.accountedBytes < 8 * MB, "real generated content stays small");
		assert.equal(watchdog.tripped, false, "coherent micro-delta thinking must survive");
	});

	it("does NOT trip the raw hard cap on fully-parsed snapshot-amplified progress streams (v0.42.1 regression)", () => {
		// Production failure: a fully parsed GLM JSON stream reached 1,024 MB cumulative
		// raw bytes while delta-aware accounted content was ~8 MB (121x snapshot
		// amplification), and the cumulative raw hard cap aborted an otherwise progressing
		// run. The raw backstop exists to catch non-JSON stdout floods; a fully-parsed
		// JSON stream whose raw bytes balloon from snapshot re-serialization must never
		// trip it — the accounted guards govern parsed streams.
		const rawHardCapBytes = 2 * MB; // small injected cap; production default is 1 GB
		const hardCapBytes = 50 * MB; // generous accounted cap; accounted bytes stay far below
		const watchdog = createStreamWatchdog({ rawHardCapBytes, hardCapBytes });

		// Each event: a full-snapshot serialized line (amplifying raw) carrying a tiny
		// unique text delta (meaningful progress; accounted bytes stay small).
		const snapshotSize = 100_000; // 100 KB per snapshot line
		const eventCount = Math.ceil(rawHardCapBytes / snapshotSize) + 10; // push past raw cap

		let rawTotal = 0;
		for (let i = 0; i < eventCount; i++) {
			const delta = ` progress text ${tok(i)}`; // aperiodic, progress-bearing
			rawTotal += snapshotSize;
			assert.equal(watchdog.addBytes(snapshotSize), undefined, `addBytes must not trip at event ${i} (raw ${rawTotal})`);
			assert.equal(
				watchdog.observeEvent(deltaEvent("text_delta", 0, delta), snapshotSize),
				undefined,
				`observeEvent must not trip at event ${i}`,
			);
		}

		assert.ok(rawTotal > rawHardCapBytes, "cumulative raw snapshots must exceed the raw hard cap");
		assert.ok(watchdog.accountedBytes < hardCapBytes, "accounted bytes must stay below the accounted hard cap");
		assert.equal(watchdog.tripped, false, "cumulative reserialized raw snapshots alone must not trip the watchdog");
	});

	it("pure unparsed raw output exactly at the injected cumulative cap survives, one byte over trips", () => {
		// No parsed events at all -> creditedRawBytes stays 0, so cumulative unaccounted
		// raw bytes equals total raw bytes. Boundary is `>`, not `>=`.
		const rawHardCapBytes = 500;
		const watchdog = createStreamWatchdog({ rawHardCapBytes, noProgressBytes: 10_000 });
		assert.equal(watchdog.addBytes(rawHardCapBytes), undefined, "exactly at the cumulative cap must not trip");
		const message = watchdog.addBytes(1);
		assert.ok(message, "one byte over the cumulative cap must trip");
		assert.match(message!, /raw output backstop/);
		assert.match(message!, /cumulative unaccounted \(unparsed\)/);
		assert.equal(watchdog.tripped, true);
	});

	it("repeated sub-threshold unparsed bursts separated by credited progress eventually trip the cumulative cap", () => {
		// Each burst alone stays under the ROLLING no-progress window (which credited
		// progress keeps resetting), so the rolling guard never fires. But the bursts are
		// genuinely unparsed (never credited), so they accumulate unboundedly in the
		// cumulative counter until the raw hard cap trips -- proving the cumulative backstop
		// still catches unparsed floods that repeatedly reset the no-progress window.
		const rawHardCapBytes = 1000;
		const noProgressBytes = 350;
		const watchdog = createStreamWatchdog({ rawHardCapBytes, noProgressBytes });
		const burst = 300; // unparsed stdout bytes, never credited
		const credited = 50; // small parsed progress event; credits its own bytes

		for (let cycle = 0; cycle < 3; cycle++) {
			assert.equal(watchdog.addBytes(burst), undefined, `burst ${cycle} alone must stay under the rolling window`);
			assert.equal(watchdog.addBytes(credited), undefined, `credited chunk ${cycle} must not trip`);
			assert.equal(
				watchdog.observeEvent(textEvent(`progress ${cycle}`), credited),
				undefined,
				`credited progress ${cycle} must reset the rolling window without tripping`,
			);
		}
		assert.equal(watchdog.tripped, false, "three sub-threshold cycles must not yet trip the cumulative cap");

		const message = watchdog.addBytes(burst);
		assert.ok(message, "the next unparsed burst must push cumulative unaccounted bytes past the cap");
		assert.match(message!, /raw output backstop/);
		assert.equal(watchdog.tripped, true);
	});

	it("credits parsed JSON bytes: only UNPARSED stdout counts toward the non-JSON backstop", () => {
		const watchdog = createStreamWatchdog({ noProgressBytes: 1000 });
		// Raw stdout fully consumed by parsed events -> credited -> the backstop never fires.
		for (let i = 0; i < 10; i++) {
			assert.equal(watchdog.addBytes(500), undefined);
			assert.equal(watchdog.observeEvent(deltaEvent("thinking_delta", 0, ` ${tok(i)}`), 500), undefined);
		}
		assert.equal(watchdog.tripped, false, "a fully-parsed stream never trips the non-JSON backstop");
		// Raw stdout that never parses (no crediting) accumulates and trips.
		const message = watchdog.addBytes(1001);
		assert.ok(message, "unparsed stdout past the backstop trips");
		assert.match(message!, /unparsed non-JSON stdout/);
	});

	it("resets the accounted no-progress window on a progress marker", () => {
		const watchdog = createStreamWatchdog({ accountedNoProgressBytes: 1000 });
		const feed = (kind: string, idx: number, n: number) => {
			for (let i = 0; i < n; i++) {
				assert.equal(watchdog.observeEvent(deltaEvent(kind, idx, ` ${tok(i)}`), 40), undefined);
			}
		};
		feed("thinking_delta", 0, 20); // 20 * 40 = 800 accounted, under 1000
		watchdog.observeEvent(deltaEvent("text_delta", 0, "verdict text"), 40); // progress resets window
		feed("thinking_delta", 1, 20); // another window, still under 1000 because it reset
		assert.equal(watchdog.tripped, false);
	});
});

describe("createStreamWatchdog: degenerate-loop detector", () => {
	it("trips on the captured M3 timeout-loop shape (cycling values, varying chunks)", () => {
		const watchdog = createStreamWatchdog();
		let message: string | undefined;
		let atEvent = 0;
		for (const [i, event] of m3TimeoutLoopDeltas(1500).entries()) {
			message = watchdog.observeEvent(event, 1000);
			if (message) {
				atEvent = i;
				break;
			}
		}
		assert.ok(message, "loop must trip");
		assert.match(message!, /degenerate streaming loop detected \(toolcall_delta repeating a ~\d+-char fragment/);
		assert.ok(atEvent < 600, `must trip early in the loop, tripped at ${atEvent}`);
		assert.equal(watchdog.tripped, true);
	});

	it("trips on the captured M3 interleaved two-block loop shape", () => {
		const watchdog = createStreamWatchdog();
		let message: string | undefined;
		for (const event of m3InterleavedLoopDeltas(3000)) {
			message = watchdog.observeEvent(event, 1000);
			if (message) break;
		}
		assert.ok(message, "interleaved loop must trip despite alternating contentIndex");
		assert.match(message!, /degenerate streaming loop detected/);
	});

	it("does NOT trip on varied healthy prose deltas", () => {
		const watchdog = createStreamWatchdog();
		// Letters-only unique token per delta (digits would be collapsed by
		// normalization): genuinely aperiodic, like real prose. A cyclic word
		// list would itself be a repetition loop and rightly trip the detector.
		const alpha = (n: number): string => n.toString(36).replace(/[0-9]/g, (c) => "ghijklmnopq"[Number(c)] ?? "z");
		for (let i = 0; i < 5000; i++) {
			const delta = ` word${alpha(i)}${i % 7 === 0 ? "." : ""}`;
			assert.equal(watchdog.observeEvent(deltaEvent("text_delta", 0, delta), 500), undefined, `false positive at delta ${i}`);
		}
		assert.equal(watchdog.tripped, false);
	});

	it("DOES trip on a long cyclic word pattern — cyclic output IS a repetition loop", () => {
		const watchdog = createStreamWatchdog();
		const words = "the quick brown fox jumps over one lazy dog".split(" ");
		let message: string | undefined;
		for (let i = 0; i < 5000 && !message; i++) {
			message = watchdog.observeEvent(deltaEvent("text_delta", 0, ` ${words[i % words.length]}`), 500);
		}
		assert.ok(message, "a short cyclic pattern sustained for ~9 KB is a degenerate loop");
	});

	it("a message boundary resets loop state", () => {
		const watchdog = createStreamWatchdog({ loopSuffixChars: 64, loopMaxPeriodChars: 16, loopSustainChars: 128 });
		// Feed just under the sustain threshold, break with a non-delta event,
		// then feed just under it again: no trip.
		const halfLoop = () => {
			for (let i = 0; i < 12; i++) {
				const error = watchdog.observeEvent(deltaEvent("toolcall_delta", 0, ', "map": true'), 200);
				assert.equal(error, undefined);
			}
		};
		halfLoop();
		watchdog.observeEvent(thinkingEvent(), 200);
		halfLoop();
		assert.equal(watchdog.tripped, false);
	});

	it("honors custom loop limits (compact trip)", () => {
		const watchdog = createStreamWatchdog({ loopSuffixChars: 64, loopMaxPeriodChars: 16, loopSustainChars: 128 });
		let message: string | undefined;
		for (let i = 0; i < 100 && !message; i++) {
			message = watchdog.observeEvent(deltaEvent("toolcall_delta", 0, ', "map": true'), 200);
		}
		assert.ok(message);
		assert.match(message!, /degenerate streaming loop detected/);
	});

	it("returns the trip message exactly once, and further events are ignored", () => {
		const watchdog = createStreamWatchdog({ loopSuffixChars: 64, loopMaxPeriodChars: 16, loopSustainChars: 128 });
		let trips = 0;
		for (let i = 0; i < 200; i++) {
			if (watchdog.observeEvent(deltaEvent("toolcall_delta", 0, ', "map": true'), 200)) trips++;
		}
		assert.equal(trips, 1);
	});

	it("observeEvent never throws on hostile inputs", () => {
		const watchdog = createStreamWatchdog();
		const hostile = { get message() { throw new Error("boom"); } };
		assert.equal(watchdog.observeEvent(hostile), undefined);
		assert.equal(watchdog.observeEvent(hostile, 100), undefined);
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
