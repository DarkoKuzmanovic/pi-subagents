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
 *    - Delta-aware no-progress trip (accounted bytes): the PRIMARY guard against
 *      thinking floods. pi's `--mode json` re-serializes the entire partial message
 *      on every streaming delta, so RAW stdout grows ~quadratically with message
 *      length and inversely with delta granularity — a 6-char-delta streamer inflates
 *      ~25 KB of real thought into ~30 MB of raw stream. Counting RAW there is a false
 *      positive that kills coherent reviews for their streaming shape alone, so the
 *      trip counts only ACCOUNTED bytes (delta payload + flat envelope) since the last
 *      progress marker.
 *    - Non-JSON stdout backstop (raw bytes): bytes that DON'T resolve into a parsed
 *      event accumulate in a raw no-progress window; every successfully-parsed event
 *      credits its bytes back, so this guard sees only non-JSON floods (a child spewing
 *      raw stdout) and never fires on amplified JSON streams.
 *    - Degenerate-loop trip (parsed deltas): a periodic-suffix detector over
 *      the normalized streaming-delta tail of the current content block.
 *      Chunking-independent and value-cycle-tolerant, because real loops vary
 *      both the delta boundaries (one or two fragment copies per delta) and
 *      embedded numeric literals (30000/60000/10000).
 *    - Hard caps: a 200 MB accounted-byte cap and a 1 GB raw-byte cap bound total
 *      output as final backstops even when the stream keeps showing progress.
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
 * Delta-aware no-progress trip: ACCOUNTED model-output bytes since the latest
 * meaningful progress marker (assistant text or tool activity) — the PRIMARY guard
 * against thinking floods. pi's `--mode json` re-serializes the full growing message
 * on every streaming delta, so RAW stdout grows ~quadratically with message length
 * and inversely with delta granularity: a fine-grained streamer (e.g. 6-char thinking
 * deltas) inflates ~25 KB of real thought into ~30 MB of raw stream (measured ~1,100x
 * on captured tencent/hy3, umans-glm-5.2 and deepseek-v4-flash runs) with zero
 * misbehaviour. Tripping on RAW there is a FALSE POSITIVE that kills coherent,
 * near-complete reviews for their streaming shape alone. Counting delta-aware ACCOUNTED
 * bytes strips the snapshot amplification, so a genuine runaway (real MBs generated
 * without ever acting) trips while honest micro-delta thinking survives. The raw
 * no-progress window credits back every parsed event (see RUNAWAY_NO_PROGRESS_BYTES),
 * so this accounted trip — not the raw backstop — is what governs JSON streams.
 * Verbatim loops are caught earlier and independently by the degenerate-loop detector.
 * Calibration: the confirmed runaway reached only ~609 KB accounted by the time it hit the
 * old 30 MB raw trip (honest runs 554-727 KB), so accounted volume alone does not discriminate
 * at small scale — 8 MB is a generous no-progress ceiling, well above honest between-progress
 * thinking yet still far below any sustained real-content flood.
 */
export const RUNAWAY_ACCOUNTED_NO_PROGRESS_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Non-JSON stdout backstop: raw bytes since the last progress marker that did NOT
 * resolve into a parsed child event. Every successfully-parsed event credits its
 * serialized size back to this window (see observeEvent), so amplified JSON streams
 * never reach it — it bounds only genuine non-JSON stdout floods (a child spewing raw
 * bytes) and caps how much unparsed stdout the runner buffers before aborting.
 */
export const RUNAWAY_NO_PROGRESS_BYTES = 32 * 1024 * 1024; // 32 MB

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
 * that way for LOOP_SUSTAIN_CHARS more normalized chars. Because digit
 * normalization also makes legitimate incrementing tabular output (CSV, numeric
 * tables) look periodic, a trip is confirmed against the RAW tail: only a genuine
 * verbatim/cycling loop — one that repeats a bounded raw fragment (raw-periodic
 * within LOOP_RAW_MAX_PERIOD_CHARS) — trips, at LOOP_SUSTAIN_CHARS. A raw-aperiodic
 * but normalized-periodic stream is EITHER a real incrementing table OR a
 * value-incrementing loop; the two are indistinguishable by both shape and volume,
 * so the detector does NOT kill them (that would abort legitimate large tables) — a
 * no-progress stream of them is bounded by the accounted no-progress trip, a progressing
 * one by the accounted hard cap.
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
// Max period for the RAW-tail confirmation. Kept well below LOOP_SUFFIX_CHARS so a confirmed
// period must repeat several times within the window (1024/256 = 4x); a near-window cap would
// declare spurious periodicity on incrementing tables from a tiny suffix overlap. Verbatim
// loops have raw period == normalized period (<= LOOP_MAX_PERIOD_CHARS), so 256 never misses a
// verbatim loop; a wider-period cycling loop is caught by the accounted no-progress trip
// (or hard cap) rather than risk a spurious early trip on a real table.
export const LOOP_RAW_MAX_PERIOD_CHARS = 256;

/** Structural notice appended once when the events.jsonl budget trips. */
export const EVENTS_CAPPED_EVENT_TYPE = "subagent.events.capped";

const BYTES_PER_MB = 1024 * 1024;

function formatMb(bytes: number): number {
	return Math.round(bytes / BYTES_PER_MB);
}

function formatAmplification(rawBytes: number, accountedBytes: number): string {
	if (accountedBytes <= 0) return "n/a";
	const ratio = rawBytes / accountedBytes;
	return `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}x`;
}

function formatStreamStats(rawBytes: number, accountedBytes: number): string {
	return `raw total ${formatMb(rawBytes)} MB, accounted ${formatMb(accountedBytes)} MB, amplification ${formatAmplification(rawBytes, accountedBytes)}`;
}

/**
 * True when the CURRENT parsed child event carries meaningful progress. For
 * `message_update`, inspect the delta event rather than the re-serialized full
 * message snapshot: stale text from earlier in the same message must not make
 * a later thinking-only update look productive.
 */
export function eventShowsProgress(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const evt = event as { type?: unknown; message?: unknown };
	if (evt.type === "tool_execution_start" || evt.type === "tool_execution_end" || evt.type === "tool_result_end") {
		return true;
	}
	if (evt.type === "message_update") {
		const streamingDelta = extractStreamingDelta(event);
		if (!streamingDelta) return false;
		const kind = streamingDelta.kind.toLowerCase();
		if (kind === "text_delta") return streamingDelta.delta.trim().length > 0;
		return kind === "toolcall_delta" || kind === "tool_call_delta" || kind === "tool_use_delta";
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
	accountedNoProgressBytes?: number;
	hardCapBytes?: number;
	rawHardCapBytes?: number;
	loopSuffixChars?: number;
	loopMaxPeriodChars?: number;
	loopSustainChars?: number;
	loopRawMaxPeriodChars?: number;
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
	/** Raw stdout bytes received since the latest meaningful progress event. */
	readonly bytesSinceProgress: number;
	readonly hasProgress: boolean;
	readonly tripped: boolean;
}

export function createStreamWatchdog(limits: StreamWatchdogLimits = {}): StreamWatchdog {
	const noProgressBytes = limits.noProgressBytes ?? RUNAWAY_NO_PROGRESS_BYTES;
	const accountedNoProgressBytes = limits.accountedNoProgressBytes ?? RUNAWAY_ACCOUNTED_NO_PROGRESS_BYTES;
	const hardCapBytes = limits.hardCapBytes ?? RUNAWAY_HARD_CAP_BYTES;
	const rawHardCapBytes = limits.rawHardCapBytes ?? RUNAWAY_RAW_HARD_CAP_BYTES;
	const loopSuffixChars = limits.loopSuffixChars ?? LOOP_SUFFIX_CHARS;
	const loopMaxPeriodChars = limits.loopMaxPeriodChars ?? LOOP_MAX_PERIOD_CHARS;
	const loopSustainChars = limits.loopSustainChars ?? LOOP_SUSTAIN_CHARS;
	const loopRawMaxPeriodChars = limits.loopRawMaxPeriodChars ?? LOOP_RAW_MAX_PERIOD_CHARS;

	let rawBytes = 0;
	let accountedBytes = 0;
	let hasProgress = false;
	let lastProgressRawBytes = 0;
	let lastProgressAccountedBytes = 0;
	let creditedRawBytes = 0;
	let lastProgressCreditedBytes = 0;
	let tripped = false;

	// Degenerate-loop detector state, tracked PER content block because real
	// loops interleave deltas across concurrently streaming blocks (captured
	// M3 stream a44b411f alternated contentIndex 0/1 on every event). Cleared
	// at message boundaries; bounded as a safety valve against hostile streams.
	const MAX_TRACKED_BLOCKS = 32;
	const blocks = new Map<string, { tail: string; rawTail: string; periodicChars: number }>();

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
			const rawSinceProgress = rawBytes - lastProgressRawBytes;
			const unaccountedSinceProgress = Math.max(0, rawSinceProgress - (creditedRawBytes - lastProgressCreditedBytes));
			if (unaccountedSinceProgress > noProgressBytes) {
				return trip(
					`runaway output aborted: ${formatMb(unaccountedSinceProgress)} MB of unparsed non-JSON stdout since last text or tool activity (${formatStreamStats(rawBytes, accountedBytes)})`,
				);
			}
			if (rawBytes > rawHardCapBytes) {
				return trip(
					`runaway output aborted: ${formatMb(rawBytes)} MB of raw model events exceeded the ${formatMb(rawHardCapBytes)} MB raw output backstop (${formatStreamStats(rawBytes, accountedBytes)}, ${formatMb(rawSinceProgress)} MB since last text or tool activity)`,
				);
			}
			return undefined;
		},
		observeEvent(event: unknown, serializedBytes?: number): string | undefined {
			if (tripped) return undefined;
			try {
				// Progress resets all three no-progress windows. The snapshot is taken BEFORE this
				// event's own bytes are accounted, so a single progress-bearing event whose serialized
				// size alone exceeds the accounted trip would self-trip — unreachable at realistic
				// per-message output sizes.
				if (eventShowsProgress(event)) {
					hasProgress = true;
					lastProgressRawBytes = rawBytes;
					lastProgressAccountedBytes = accountedBytes;
					lastProgressCreditedBytes = creditedRawBytes;
				}

				const streamingDelta = extractStreamingDelta(event);

				// Delta-aware byte accounting toward the hard cap.
				if (typeof serializedBytes === "number" && Number.isFinite(serializedBytes) && serializedBytes > 0) {
					accountedBytes += streamingDelta
						? Math.min(serializedBytes, Buffer.byteLength(streamingDelta.delta, "utf8") + DELTA_EVENT_OVERHEAD_BYTES)
						: serializedBytes;
					// Credit this parsed event's raw footprint back to the non-JSON no-progress
					// window so snapshot-amplified JSON streams never reach the raw backstop;
					// only genuinely unparsed stdout accumulates there.
					creditedRawBytes += serializedBytes;
				}

				// Degenerate-loop detection over the normalized per-block delta tail.
				if (streamingDelta) {
					const key = `${streamingDelta.kind}#${streamingDelta.contentIndex ?? -1}`;
					let block = blocks.get(key);
					if (!block) {
						if (blocks.size >= MAX_TRACKED_BLOCKS) blocks.clear();
						block = { tail: "", rawTail: "", periodicChars: 0 };
						blocks.set(key, block);
					}
					const normalized = normalizeForLoopDetection(streamingDelta.delta);
					block.tail = (block.tail + normalized).slice(-loopSuffixChars);
					block.rawTail = (block.rawTail + streamingDelta.delta).slice(-loopSuffixChars);
					const period = periodicTailPeriod(block.tail, loopSuffixChars, loopMaxPeriodChars);
					if (period > 0) {
						block.periodicChars += normalized.length;
						if (block.periodicChars > loopSustainChars) {
							// The NORMALIZED tail is periodic, but digit-normalization also makes
							// legitimate incrementing tabular output look periodic. Only trip when the
							// RAW tail is ALSO periodic — a genuine verbatim/cycling loop repeats a bounded
							// fragment. A raw-aperiodic-but-normalized-periodic stream is either a real
							// incrementing table or a value-incrementing loop, indistinguishable by both
							// shape and volume, so it is left to the accounted hard cap, not killed here (H4).
							const rawPeriod = periodicTailPeriod(block.rawTail, loopSuffixChars, loopRawMaxPeriodChars);
							if (rawPeriod > 0) {
								const preview = block.tail.slice(-Math.min(60, block.tail.length));
								return trip(
									`runaway output aborted: degenerate streaming loop detected (${streamingDelta.kind} repeating a ~${period}-char fragment for ${block.periodicChars}+ chars): ${JSON.stringify(preview)}`,
								);
							}
						}
					} else {
						block.periodicChars = 0;
					}
				} else {
					// Any non-delta event marks a message boundary.
					resetLoopState();
				}

				const accountedSinceProgress = accountedBytes - lastProgressAccountedBytes;
				if (accountedSinceProgress > accountedNoProgressBytes) {
					return trip(
						`runaway output aborted: ${formatMb(accountedSinceProgress)} MB of model output since last text or tool activity (${formatStreamStats(rawBytes, accountedBytes)}; likely a thinking loop)`,
					);
				}
				if (accountedBytes > hardCapBytes) {
					return trip(`runaway output aborted: ${formatMb(accountedBytes)} MB of model output exceeded the ${formatMb(hardCapBytes)} MB hard output cap (${formatStreamStats(rawBytes, accountedBytes)})`);
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
		get bytesSinceProgress() {
			return rawBytes - lastProgressRawBytes;
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
