/** Ring buffer for recent agent output lines. */

export interface RecentOutputBuffer {
	append(lines: string[]): void;
	snapshot(): string[];
}

export function createRecentOutputBuffer(maxLines = 50): RecentOutputBuffer {
	let buffer: string[] = [];
	return {
		append(lines: string[]): void {
			const nonEmpty = lines.filter((l) => l.trim());
			if (nonEmpty.length === 0) return;
			buffer.push(...nonEmpty);
			if (buffer.length > maxLines) {
				buffer.splice(0, buffer.length - maxLines);
			}
		},
		/** Returns a shallow copy — mutations to the returned array do not affect the buffer. */
		snapshot(): string[] {
			return [...buffer];
		},
	};
}
