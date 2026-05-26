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

const HISTORY_PATH = path.join(os.homedir(), ".pi", "agent", "run-history.jsonl");
const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

export function recordRun(agent: string, task: string, exitCode: number, durationMs: number): void {
	try {
		const entry: RunEntry = {
			agent,
			task: task.slice(0, 200),
			ts: Math.floor(Date.now() / 1000),
			status: exitCode === 0 ? "ok" : "error",
			duration: durationMs,
			...(exitCode !== 0 ? { exit: exitCode } : {}),
		};
		fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
		fs.appendFileSync(HISTORY_PATH, `${JSON.stringify(entry)}\n`);
	} catch {
		// Best-effort — never crash the execution flow for history recording
	}
}
