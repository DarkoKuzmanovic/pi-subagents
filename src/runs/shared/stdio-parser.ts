/** JSON stdout line processor for subagent child processes. */

export interface LineProcessor {
	processLine(line: string): void;
}

export interface LineProcessorCallbacks {
	/**
	 * Called for each successfully parsed JSON line. Receives the raw line so
	 * callers can do byte accounting without re-serializing the parsed event.
	 */
	onJson: (parsed: Record<string, unknown>, line: string) => void;
	/**
	 * Called for non-JSON lines (parse errors). Optional.
	 * Foreground ignores non-JSON; background writes to output file and event log.
	 */
	onRaw?: (line: string) => void;
}

export function createLineProcessor(callbacks: LineProcessorCallbacks): LineProcessor {
	return {
		processLine(line: string): void {
			if (!line.trim()) return;
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				callbacks.onJson(parsed, line);
			} catch {
				callbacks.onRaw?.(line);
			}
		},
	};
}
