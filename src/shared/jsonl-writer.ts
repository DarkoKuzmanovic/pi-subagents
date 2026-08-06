import * as fs from "node:fs";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	once(event: "error", listener: (err: Error) => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;

interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
}

interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
		};
	}

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let stream: JsonlWriteStream | undefined;
	try {
		stream = createWriteStream(filePath);
	} catch {
		return {
			writeLine() {},
			async close() {},
		};
	}

	let backpressured = false;
	let closed = false;
	let bytesWritten = 0;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
	// Async stream errors (EISDIR, ENOSPC, permission change) are not catchable around
	// write(); an unhandled "error" event would crash the host Pi process. Degrade this
	// writer to a no-op instead, and resume a backpressured source so the run never wedges.
	stream.once("error", (err) => {
		console.error(`[pi-subagents] jsonl write failed for ${filePath}:`, err);
		if (backpressured) {
			backpressured = false;
			source.resume();
		}
		closed = true;
		stream = undefined;
	});

	return {
		writeLine(line: string) {
			if (!stream || closed || !line.trim()) return;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch {}
		},
		async close() {
			if (!stream || closed) return;
			closed = true;
			const current = stream;
			stream = undefined;
			await new Promise<void>((resolve) => current.end(() => resolve()));
		},
	};
}
