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
