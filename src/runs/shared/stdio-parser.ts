/** JSON stdout line processor for subagent child processes. */

export interface LineProcessor {
	processLine(line: string): void;
}

export interface LineProcessorCallbacks {
	/** Called for each successfully parsed JSON line. */
	onJson: (parsed: Record<string, unknown>) => void;
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
				callbacks.onJson(parsed);
			} catch {
				callbacks.onRaw?.(line);
			}
		},
	};
}
