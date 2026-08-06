export const STDERR_TAIL_BYTES = 64 * 1024;
export const STDERR_HARD_CAP_BYTES = 32 * 1024 * 1024;

export interface BoundedStderrBufferOptions {
	tailBytes?: number;
	hardCapBytes?: number;
}

export interface BoundedStderrBuffer {
	/** Append raw stderr bytes. Returns the hard-cap diagnostic exactly once. */
	append(chunk: string | Uint8Array): string | undefined;
	/** UTF-8 text retained from the end of the stream. */
	text(): string;
	readonly totalBytes: number;
	readonly tripped: boolean;
}

function positiveByteLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function formatByteLimit(bytes: number): string {
	const megabyte = 1024 * 1024;
	if (bytes % megabyte === 0) return `${bytes / megabyte} MB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KB`;
	return `${bytes} bytes`;
}

/**
 * Keeps only a small UTF-8-safe tail while counting every received stderr byte.
 * The caller owns process termination when append() returns a hard-cap diagnostic.
 */
export function createBoundedStderrBuffer(options: BoundedStderrBufferOptions = {}): BoundedStderrBuffer {
	const tailBytes = positiveByteLimit(options.tailBytes, STDERR_TAIL_BYTES);
	const hardCapBytes = positiveByteLimit(options.hardCapBytes, STDERR_HARD_CAP_BYTES);
	let tail = Buffer.alloc(0);
	let totalBytes = 0;
	let tripped = false;

	const retainTail = (bytes: Buffer): void => {
		if (bytes.length === 0) return;
		const combined = bytes.length >= tailBytes ? bytes : Buffer.concat([tail, bytes]);
		let start = Math.max(0, combined.length - tailBytes);
		// If the byte cap lands inside a UTF-8 sequence, discard its orphaned continuation bytes.
		while (start < combined.length) {
			const byte = combined[start];
			if (byte === undefined || (byte & 0xc0) !== 0x80) break;
			start++;
		}
		// Copy the slice so a tiny tail never retains a huge child-process chunk backing store.
		tail = Buffer.from(combined.subarray(start));
	};

	return {
		append(chunk: string | Uint8Array): string | undefined {
			if (tripped) return undefined;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += bytes.length;
			retainTail(bytes);
			if (totalBytes > hardCapBytes) {
				tripped = true;
				return `runaway stderr aborted: child stderr exceeded the ${formatByteLimit(hardCapBytes)} hard cap (${formatByteLimit(totalBytes)} received); retained only the last ${formatByteLimit(tailBytes)}`;
			}
			return undefined;
		},
		text(): string {
			return tail.toString("utf8");
		},
		get totalBytes() {
			return totalBytes;
		},
		get tripped() {
			return tripped;
		},
	};
}

/**
 * Formats a bounded tail of stderr for inclusion in parent-facing failure results.
 *
 * - Takes last 8 lines, each truncated to 200 chars
 * - Enforces ~800 char total cap
 * - Strips ANSI escape sequences
 * - Returns empty string if input is falsy or only whitespace
 */
export function getStderrTail(stderr: string | undefined | null): string {
	// Runtime type guard: jiti strips TS types, so a non-string can reach us.
	if (typeof stderr !== "string" || !stderr.trim()) {
		return "";
	}

	// Strip ANSI escape sequences (includes color codes, formatting, etc.)
	// Pattern: ESC [ followed by zero or more digits/semicolons, then a letter
	// eslint-disable-next-line no-control-regex
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires matching the ESC control char
	const stripped = stderr.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");

	// Split into lines, take last 8, trim each
	const lines = stripped.split("\n").map((line) => line.trim()).filter((line) => line);
	if (lines.length === 0) {
		return "";
	}

	const tailLines = lines.slice(-8);

	// Truncate each line to 200 chars
	const truncatedLines = tailLines.map((line) => {
		if (line.length > 200) {
			return line.slice(0, 197) + "...";
		}
		return line;
	});

	// Join and enforce ~800 char total cap
	let joined = truncatedLines.join("\n");
	if (joined.length > 800) {
		joined = joined.slice(-797) + "...";
	}

	return joined;
}
