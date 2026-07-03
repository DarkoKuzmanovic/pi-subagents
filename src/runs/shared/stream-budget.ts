/**
 * Protections against unbounded child event streams.
 *
 * Two independent guards, both motivated by runaway MiniMax-style thinking
 * loops observed in production (231 MB of `--mode json` thinking events with
 * zero text output; a 2.5 GB events.jsonl that filled /tmp):
 *
 * 1. `createStreamWatchdog` — per-child-process byte accounting over stdout.
 *    Trips when a child floods output without ever producing a meaningful
 *    progress marker (assistant text or a tool call), or when it exceeds a
 *    hard byte cap regardless of progress.
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
 * Runaway trip: bytes of child stdout with NO progress marker yet.
 * Healthy runs sit in the 90 KB–550 KB range; heavy-but-healthy runs reach
 * ~30 MB only WITH text present — hence the no-progress qualifier.
 */
export const RUNAWAY_NO_PROGRESS_BYTES = 30 * 1024 * 1024; // 30 MB

/** Hard cap: abort the child at this many stdout bytes even with progress. */
export const RUNAWAY_HARD_CAP_BYTES = 200 * 1024 * 1024; // 200 MB

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

export interface StreamWatchdogLimits {
	noProgressBytes?: number;
	hardCapBytes?: number;
}

export interface StreamWatchdog {
	/**
	 * Account for received stdout bytes. Returns an error message exactly once
	 * when a trip condition is first met, undefined otherwise. Never throws.
	 */
	addBytes(count: number): string | undefined;
	/** Feed a parsed child event; sets the progress flag when it qualifies. */
	observeEvent(event: unknown): void;
	readonly bytes: number;
	readonly hasProgress: boolean;
	readonly tripped: boolean;
}

export function createStreamWatchdog(limits: StreamWatchdogLimits = {}): StreamWatchdog {
	const noProgressBytes = limits.noProgressBytes ?? RUNAWAY_NO_PROGRESS_BYTES;
	const hardCapBytes = limits.hardCapBytes ?? RUNAWAY_HARD_CAP_BYTES;
	let bytes = 0;
	let hasProgress = false;
	let tripped = false;

	return {
		addBytes(count: number): string | undefined {
			if (tripped) return undefined;
			if (typeof count === "number" && Number.isFinite(count) && count > 0) {
				bytes += count;
			}
			if (bytes > hardCapBytes) {
				tripped = true;
				return `runaway output aborted: ${formatMb(bytes)} MB of model events exceeded the ${formatMb(hardCapBytes)} MB hard output cap`;
			}
			if (!hasProgress && bytes > noProgressBytes) {
				tripped = true;
				return `runaway output aborted: ${formatMb(bytes)} MB of model events with no text or tool activity (likely a thinking loop)`;
			}
			return undefined;
		},
		observeEvent(event: unknown): void {
			if (hasProgress) return;
			try {
				hasProgress = eventShowsProgress(event);
			} catch {
				// Progress detection is best-effort; malformed events never throw.
			}
		},
		get bytes() {
			return bytes;
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
