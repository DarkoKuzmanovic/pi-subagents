import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStreamWatchdog } from "../../src/runs/shared/stream-budget.ts";

function textDelta(delta: string): Record<string, unknown> {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } };
}

// Feed a sequence of streaming text deltas; return the first trip message, if any.
function runDeltas(deltas: Iterable<string>): string | undefined {
	const wd = createStreamWatchdog();
	for (const delta of deltas) {
		const ev = textDelta(delta);
		const bytes = Buffer.byteLength(JSON.stringify(ev));
		wd.addBytes(bytes);
		const msg = wd.observeEvent(ev, bytes);
		if (msg) return msg;
	}
	return undefined;
}

// Same as runDeltas but with watchdog limit overrides (e.g. a small normalized-only tier).
function runDeltasWithLimits(deltas: Iterable<string>, limits: Record<string, number>): string | undefined {
	const wd = createStreamWatchdog(limits);
	for (const delta of deltas) {
		const ev = textDelta(delta);
		const bytes = Buffer.byteLength(JSON.stringify(ev));
		wd.addBytes(bytes);
		const msg = wd.observeEvent(ev, bytes);
		if (msg) return msg;
	}
	return undefined;
}

describe("loop detector — structured data vs genuine loops (H4)", () => {
	it("does NOT trip on a long uniform incrementing numeric CSV table", () => {
		// Legitimate, progressing table output. Digit-normalization makes every row
		// collapse to the same periodic pattern (#,#,#,#,#), but the RAW values keep
		// changing, so the raw tail is aperiodic and must be spared.
		function* rows() {
			for (let r = 0; r < 3000; r++) yield `${r},${r * 2},${r * 3},${r * 4},${r * 5}\n`;
		}
		assert.equal(runDeltas(rows()), undefined);
	});

	it("does NOT trip on a wide incrementing table with many columns", () => {
		function* rows() {
			for (let r = 0; r < 2000; r++) {
				yield `${Array.from({ length: 8 }, (_, c) => r * 10 + c).join(",")}\n`;
			}
		}
		assert.equal(runDeltas(rows()), undefined);
	});

	it("STILL trips on a genuine verbatim repeated fragment (control)", () => {
		// The model re-emits the identical fragment forever: raw-periodic -> real loop.
		function* frags() {
			for (let i = 0; i < 5000; i++) yield `, "timeout": 60000`;
		}
		const msg = runDeltas(frags());
		assert.ok(msg, "expected a verbatim loop to trip");
		assert.match(msg as string, /degenerate streaming loop detected/);
	});

	it("STILL trips on a low-cardinality cycling-values loop (control)", () => {
		// Cycling over a tiny value set keeps the raw tail periodic (period = cycle length).
		const values = [30000, 60000, 10000];
		function* frags() {
			for (let i = 0; i < 5000; i++) yield `, "timeout": ${values[i % values.length]}`;
		}
		const msg = runDeltas(frags());
		assert.ok(msg, "expected a cycling-values loop to trip");
		assert.match(msg as string, /degenerate streaming loop detected/);
	});

	it("trips on a raw-aperiodic value-incrementing loop once it dwarfs a realistic table", () => {
		// Reviewer's regression: `, "timeout": 0/1/2/...` normalizes to a periodic tail but the RAW
		// values keep changing (raw-aperiodic), so the low-sustain raw gate spares it. The
		// normalized-only volume tier must still catch it. Small override avoids the 256 KB default.
		function* frags() {
			for (let i = 0; i < 5000; i++) yield `, "timeout": ${i}`;
		}
		const msg = runDeltasWithLimits(frags(), { loopNormalizedOnlySustainChars: 4096 });
		assert.ok(msg, "expected a sustained incrementing loop to trip at the normalized-only tier");
		assert.match(msg as string, /sustained a ~\d+-char incrementing pattern/);
	});

	it("spares that same incrementing pattern at realistic table scale (default threshold)", () => {
		// ~3000 iterations (~42 KB) is well under the 256 KB normalized-only tier, so a bounded
		// incrementing stream (indistinguishable from a real table) is not killed.
		function* frags() {
			for (let i = 0; i < 3000; i++) yield `, "timeout": ${i}`;
		}
		assert.equal(runDeltas(frags()), undefined);
	});
});
