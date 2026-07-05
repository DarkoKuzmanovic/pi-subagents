import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RunEntry {
	agent: string;
	task: string;
	ts: number;
	status: "ok" | "error";
	duration: number;
	exit?: number;
}

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

/**
 * Resolve the run-history file path.
 *
 * An explicit override via PI_SUBAGENTS_HISTORY_PATH wins — the test suite
 * points this at a throwaway temp file so integration tests (which drive the
 * real executeChain/runSync) never pollute the per-user production history.
 * Read at call time (not captured in a module const) so tests can set it after
 * this module is imported.
 */
export function resolveHistoryPath(): string {
	const override = process.env.PI_SUBAGENTS_HISTORY_PATH;
	if (override && override.length > 0) return override;
	return path.join(os.homedir(), ".pi", "agent", "run-history.jsonl");
}

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
	const override = process.env.PI_SUBAGENTS_HISTORY_PATH;
	// Never touch the production history file from the test runner unless a test
	// has explicitly redirected writes to a path of its own.
	if (!(override && override.length > 0) && process.env.NODE_ENV === "test") return;
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		const historyPath = resolveHistoryPath();
		fs.mkdirSync(path.dirname(historyPath), { recursive: true });
		fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
		rotateHistory(historyPath);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}

/**
 * Keep the history file bounded. Once it grows past ROTATE_READ_THRESHOLD lines,
 * retain only the most recent ROTATE_KEEP and atomically rewrite (tmp + rename)
 * so a reader never observes a torn file.
 */
function rotateHistory(historyPath: string): void {
	let raw: string;
	try {
		raw = fs.readFileSync(historyPath, "utf-8");
	} catch {
		return;
	}
	const lines = raw.split("\n").filter((line) => line.length > 0);
	if (lines.length <= ROTATE_READ_THRESHOLD) return;
	const kept = lines.slice(-ROTATE_KEEP);
	const tmpPath = `${historyPath}.tmp-${process.pid}`;
	try {
		fs.writeFileSync(tmpPath, `${kept.join("\n")}\n`, "utf-8");
		fs.renameSync(tmpPath, historyPath);
	} catch {
		try {
			fs.rmSync(tmpPath, { force: true });
		} catch {
			// ignore cleanup failure
		}
	}
}
