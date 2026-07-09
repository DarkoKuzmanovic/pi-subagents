/**
 * Protections against unbounded child event streams.
 *
 * Three independent guards, motivated by runaway loops observed in production
 * (231 MB of `--mode json` thinking events with zero text output; a 2.5 GB
 * events.jsonl that filled /tmp; MiniMax-M3 tool-call loops that repeat the
 * trailing key-value pair of a tool call's JSON arguments indefinitely —
 * `, "timeout": 60000, "timeout": 60000, ...` — and never close the object):
 *
 * 1. `createStreamWatchdog` — per-child-process guard over the `--mode json`
 *    stdout stream:
 *    - No-progress trip (raw bytes): a child that floods stdout without ever
 *      producing a meaningful progress marker (assistant text or a tool call).
 *    - Degenerate-loop trip (parsed deltas): a periodic-suffix detector over
 *      the normalized streaming-delta tail of the current content block.
 *      Chunking-independent and value-cycle-tolerant, because real loops vary
 *      both the delta boundaries (one or two fragment copies per delta) and
 *      embedded numeric literals (30000/60000/10000).
 *    - Hard cap (accounted bytes): `message_update` events re-serialize the
 *      entire partial message on every delta, so raw stdout grows
 *      quadratically with message length. The hard cap therefore counts only
 *      the delta payload (plus a flat envelope overhead) for streaming
 *      updates, keeping it proportional to what the model actually generated
 *      — verbose-but-honest runs no longer trip it. A generous raw-byte
 *      backstop still bounds any flood shape.
 *
 * 2. `createRunEventAppender` — a per-run byte budget for the async runner's
 *    events.jsonl. Once the budget is exceeded it appends one structural
 *    `subagent.events.capped` notice, then drops high-volume passthrough
 *    events (child stdout/stderr relays, raw child model events) while still
 *    appending small structural `subagent.*` lifecycle events.
 *
 * Kept pure (writer injected, no fs/process access) so it is unit-testable
 * with synthetic streams.
 */

/** Per-run byte budget for the async runner's events.jsonl (Feature A). */
export const EVENTS_JSONL_BYTE_BUDGET = 50 * 1024 * 1024; // 50 MB

/**
 * Runaway trip: raw stdout bytes with NO progress marker yet.
 * Healthy runs sit in the 90 KB–550 KB range; heavy-but-healthy runs reach
 * ~30 MB only WITH text present — hence the no-progress qualifier.
 */
export const RUNAWAY_NO_PROGRESS_BYTES = 30 * 1024 * 1024; // 30 MB

/**
 * Hard cap on ACCOUNTED model-output bytes (delta-aware; streaming
 * `message_update` events count only their delta payload + envelope overhead,
 * everything else counts at full serialized size). Abort the child past this
 * even with progress.
 */
export const RUNAWAY_HARD_CAP_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Backstop on RAW stdout bytes even with progress. Bounds flood shapes the
 * accounted cap cannot see (e.g. non-JSON stdout spam). Deliberately generous:
 * honest heavy runs previously died at 200 MB raw purely from snapshot
 * re-serialization amplification.
 */
export const RUNAWAY_RAW_HARD_CAP_BYTES = 1024 * 1024 * 1024; // 1 GB

/** Flat accounted overhead per streaming delta event (envelope minus snapshot). */
export const DELTA_EVENT_OVERHEAD_BYTES = 64;

/**
 * Degenerate-loop detector tuning. The detector normalizes streaming deltas
 * (numeric literals -> '#', whitespace runs -> ' '), accumulates a rolling
 * per-content-block tail, and trips when the trailing LOOP_SUFFIX_CHARS are
 * periodic with period <= LOOP_MAX_PERIOD_CHARS and the block keeps growing
 * that way for LOOP_SUSTAIN_CHARS more normalized chars.
 *
 * Calibrated against captured production streams: MiniMax-M3 tool-call loops
 * show a ~13–14 char normalized period sustained for tens of KB, while honest
 * runs (12 captured streams across 6 models) never sustain a periodic suffix.
 * LOOP_SUSTAIN_CHARS is set high enough that legitimately repetitive content
 * (e.g. a digit-heavy fixture array) has to repeat for ~8 KB after an already
 * periodic 1 KB suffix before tripping.
 */
export const LOOP_SUFFIX_CHARS = 1024;
export const LOOP_MAX_PERIOD_CHARS = 128;
export const LOOP_SUSTAIN_CHARS = 8192;

/** Structural notice appended once when the events.jsonl budget trips. */
export const EVENTS_CAPPED_EVENT_TYPE = "subagent.events.capped";

const BYTES_PER_MB = 1024 * 1024;

function formatMb(bytes: number): number {
	return Math.round(bytes / BYTES_PER_MB);
}

/**
 * True when a parsed `--mode json` child event carries a meaningful progress
 * marker: a tool actually executing, or an assistant content block of type
 * `text` (non-empty) or `toolCall`/`tool_use`. Thinking-only assistant
 * messages are NOT progress — that is exactly the runaway-loop signature.
 */
export function eventShowsProgress(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const evt = event as { type?: unknown; message?: unknown };
	// Tool execution events imply the model emitted a tool call — progress.
	if (evt.type === "tool_execution_start" || evt.type === "tool_execution_end" || evt.type === "tool_result_end") {
		return true;
	}
	const message = evt.message;
	if (!message || typeof message !== "object") return false;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "assistant" || !Array.isArray(content)) return false;
	return content.some((block) => {
		if (!block || typeof block !== "object") return false;
		const { type, text } = block as { type?: unknown; text?: unknown };
		if (type === "toolCall" || type === "tool_use") return true;
		return type === "text" && typeof text === "string" && text.trim().length > 0;
	});
}

/** A streaming content delta extracted from a `message_update` child event. */
export interface StreamingDelta {
	/** Assistant-event type, e.g. `toolcall_delta`, `thinking_delta`, `text_delta`. */
	kind: string;
	/** Content block index within the streaming message, when present. */
	contentIndex: number | undefined;
	/** The raw delta payload. */
	delta: string;
}

/**
 * Extract the streaming delta from a `message_update` event, if any.
 * Supports both `assistantMessageEvent` (current child stream shape) and
 * `assistantEvent` (defensive fallback).
 */
export function extractStreamingDelta(event: unknown): StreamingDelta | undefined {
	if (!event || typeof event !== "object") return undefined;
	const evt = event as { type?: unknown; assistantMessageEvent?: unknown; assistantEvent?: unknown };
	if (evt.type !== "message_update") return undefined;
	const ame = evt.assistantMessageEvent ?? evt.assistantEvent;
	if (!ame || typeof ame !== "object") return undefined;
	const { type, contentIndex, delta } = ame as { type?: unknown; contentIndex?: unknown; delta?: unknown };
	if (typeof delta !== "string" || delta.length === 0) return undefined;
	return {
		kind: typeof type === "string" ? type : "delta",
		contentIndex: typeof contentIndex === "number" ? contentIndex : undefined,
		delta,
	};
}

/**
 * Normalize a delta for loop detection: collapse numeric literals so cycling
 * values (30000/60000/10000) converge to one pattern, and collapse whitespace
 * runs so formatting jitter does not break periodicity.
 */
export function normalizeForLoopDetection(delta: string): string {
	return delta.replace(/\d+/g, "#").replace(/\s+/g, " ");
}

/**
 * Smallest period `p <= maxPeriod` such that the trailing `suffixChars` of
 * `tail` satisfy s[i] === s[i - p]; 0 when the suffix is not periodic or the
 * tail is too short to judge.
 */
export function periodicTailPeriod(tail: string, suffixChars: number = LOOP_SUFFIX_CHARS, maxPeriod: number = LOOP_MAX_PERIOD_CHARS): number {
	if (tail.length < suffixChars) return 0;
	const s = tail.slice(-suffixChars);
	for (let p = 1; p <= maxPeriod; p++) {
		let periodic = true;
		for (let i = p; i < s.length; i++) {
			if (s.charCodeAt(i) !== s.charCodeAt(i - p)) {
				periodic = false;
				break;
			}
		}
		if (periodic) return p;
	}
	return 0;
}

export interface StreamWatchdogLimits {
	noProgressBytes?: number;
	hardCapBytes?: number;
	rawHardCapBytes?: number;
	loopSuffixChars?: number;
	loopMaxPeriodChars?: number;
	loopSustainChars?: number;
}

export interface StreamWatchdog {
	/**
	 * Account for received RAW stdout bytes. Returns an error message exactly
	 * once when a trip condition is first met, undefined otherwise. Never throws.
	 */
	addBytes(count: number): string | undefined;
	/**
	 * Feed a parsed child event. Sets the progress flag, runs the
	 * degenerate-loop detector over streaming deltas, and (when
	 * `serializedBytes` is provided) adds delta-aware accounted bytes toward
	 * the hard cap. Returns an error message exactly once when a trip
	 * condition is first met, undefined otherwise. Never throws.
	 */
	observeEvent(event: unknown, serializedBytes?: number): string | undefined;
	/** Raw stdout bytes seen so far. */
	readonly bytes: number;
	/** Delta-aware accounted model-output bytes seen so far. */
	readonly accountedBytes: number;
	readonly hasProgress: boolean;
	readonly tripped: boolean;
}

export function createStreamWatchdog(limits: StreamWatchdogLimits = {}): StreamWatchdog {
	const noProgressBytes = limits.noProgressBytes ?? RUNAWAY_NO_PROGRESS_BYTES;
	const hardCapBytes = limits.hardCapBytes ?? RUNAWAY_HARD_CAP_BYTES;
	const rawHardCapBytes = limits.rawHardCapBytes ?? RUNAWAY_RAW_HARD_CAP_BYTES;
	const loopSuffixChars = limits.loopSuffixChars ?? LOOP_SUFFIX_CHARS;
	const loopMaxPeriodChars = limits.loopMaxPeriodChars ?? LOOP_MAX_PERIOD_CHARS;
	const loopSustainChars = limits.loopSustainChars ?? LOOP_SUSTAIN_CHARS;

	let rawBytes = 0;
	let accountedBytes = 0;
	let hasProgress = false;
	let tripped = false;

	// Degenerate-loop detector state, tracked PER content block because real
	// loops interleave deltas across concurrently streaming blocks (captured
	// M3 stream a44b411f alternated contentIndex 0/1 on every event). Cleared
	// at message boundaries; bounded as a safety valve against hostile streams.
	const MAX_TRACKED_BLOCKS = 32;
	const blocks = new Map<string, { tail: string; periodicChars: number }>();

	const trip = (message: string): string => {
		tripped = true;
		return message;
	};

	const resetLoopState = (): void => {
		blocks.clear();
	};

	return {
		addBytes(count: number): string | undefined {
			if (tripped) return undefined;
			if (typeof count === "number" && Number.isFinite(count) && count > 0) {
				rawBytes += count;
			}
			if (rawBytes > rawHardCapBytes) {
				return trip(`runaway output aborted: ${formatMb(rawBytes)} MB of raw model events exceeded the ${formatMb(rawHardCapBytes)} MB raw output backstop`);
			}
			if (!hasProgress && rawBytes > noProgressBytes) {
				return trip(`runaway output aborted: ${formatMb(rawBytes)} MB of model events with no text or tool activity (likely a thinking loop)`);
			}
			return undefined;
		},
		observeEvent(event: unknown, serializedBytes?: number): string | undefined {
			if (tripped) return undefined;
			try {
				if (!hasProgress) hasProgress = eventShowsProgress(event);

				const streamingDelta = extractStreamingDelta(event);

				// Delta-aware byte accounting toward the hard cap.
				if (typeof serializedBytes === "number" && Number.isFinite(serializedBytes) && serializedBytes > 0) {
					accountedBytes += streamingDelta
						? Math.min(serializedBytes, streamingDelta.delta.length + DELTA_EVENT_OVERHEAD_BYTES)
						: serializedBytes;
				}

				// Degenerate-loop detection over the normalized per-block delta tail.
				if (streamingDelta) {
					const key = `${streamingDelta.kind}#${streamingDelta.contentIndex ?? -1}`;
					let block = blocks.get(key);
					if (!block) {
						if (blocks.size >= MAX_TRACKED_BLOCKS) blocks.clear();
						block = { tail: "", periodicChars: 0 };
						blocks.set(key, block);
					}
					const normalized = normalizeForLoopDetection(streamingDelta.delta);
					block.tail = (block.tail + normalized).slice(-loopSuffixChars);
					const period = periodicTailPeriod(block.tail, loopSuffixChars, loopMaxPeriodChars);
					if (period > 0) {
						block.periodicChars += normalized.length;
						if (block.periodicChars > loopSustainChars) {
							const preview = block.tail.slice(-Math.min(60, block.tail.length));
							return trip(
								`runaway output aborted: degenerate streaming loop detected (${streamingDelta.kind} repeating a ~${period}-char fragment for ${block.periodicChars}+ chars): ${JSON.stringify(preview)}`,
							);
						}
					} else {
						block.periodicChars = 0;
					}
				} else {
					// Any non-delta event marks a message boundary.
					resetLoopState();
				}

				if (accountedBytes > hardCapBytes) {
					return trip(`runaway output aborted: ${formatMb(accountedBytes)} MB of model output exceeded the ${formatMb(hardCapBytes)} MB hard output cap`);
				}
			} catch {
				// Watchdog observation is best-effort; malformed events never throw.
			}
			return undefined;
		},
		get bytes() {
			return rawBytes;
		},
		get accountedBytes() {
			return accountedBytes;
		},
		get hasProgress() {
			return hasProgress;
		},
		get tripped() {
			return tripped;
		},
	};
}

/**
 * High-volume passthrough events are droppable after the cap: child
 * stdout/stderr relays and raw child model events (which carry pi event types
 * like `message_delta`/`message_end`, not `subagent.*`). Structural
 * `subagent.*` lifecycle events stay.
 */
export function isPassthroughEventType(type: unknown): boolean {
	if (typeof type !== "string") return true;
	if (type === "subagent.child.stdout" || type === "subagent.child.stderr") return true;
	return !type.startsWith("subagent.");
}

export interface RunEventAppender {
	/** Serialize and append one event, subject to the per-file byte budget. Never throws. */
	append(eventsPath: string, payload: Record<string, unknown>): void;
	/** Cumulative bytes accounted for a given events file (for tests/diagnostics). */
	bytesFor(eventsPath: string): number;
	/** Whether a given events file has hit its budget. */
	cappedFor(eventsPath: string): boolean;
}

export function createRunEventAppender(
	writeLine: (eventsPath: string, line: string) => void,
	limitBytes: number = EVENTS_JSONL_BYTE_BUDGET,
): RunEventAppender {
	const state = new Map<string, { bytes: number; capped: boolean }>();
	const stateFor = (eventsPath: string) => {
		let entry = state.get(eventsPath);
		if (!entry) {
			entry = { bytes: 0, capped: false };
			state.set(eventsPath, entry);
		}
		return entry;
	};

	return {
		append(eventsPath: string, payload: Record<string, unknown>): void {
			try {
				const entry = stateFor(eventsPath);
				const passthrough = isPassthroughEventType(payload?.type);
				if (entry.capped && passthrough) return;
				const line = JSON.stringify(payload);
				entry.bytes += Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
				writeLine(eventsPath, line);
				if (!entry.capped && entry.bytes > limitBytes) {
					entry.capped = true;
					writeLine(eventsPath, JSON.stringify({ type: EVENTS_CAPPED_EVENT_TYPE, droppedFrom: entry.bytes }));
				}
			} catch {
				// Event relay is best-effort observability; it must never break the run.
			}
		},
		bytesFor(eventsPath: string): number {
			return state.get(eventsPath)?.bytes ?? 0;
		},
		cappedFor(eventsPath: string): boolean {
			return state.get(eventsPath)?.capped ?? false;
		},
	};
}
