import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { recordRun, resolveHistoryPath } from "../../src/runs/shared/run-history.ts";

const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;

let tempDir = "";
let tempHome = "";
const originalHistoryPath = process.env.PI_SUBAGENTS_HISTORY_PATH;
const originalNodeEnv = process.env.NODE_ENV;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function readLines(filePath: string): string[] {
	return fs
		.readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0);
}

function seedHistory(filePath: string, count: number): void {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		lines.push(JSON.stringify({ agent: "seed", task: `seed-${i}`, ts: 0, status: "ok", duration: 0 }));
	}
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
}

describe("run-history recordRun", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-history-"));
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-history-home-"));
	});

	afterEach(() => {
		if (originalHistoryPath === undefined) delete process.env.PI_SUBAGENTS_HISTORY_PATH;
		else process.env.PI_SUBAGENTS_HISTORY_PATH = originalHistoryPath;
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("appends entries to the injected history path", () => {
		const historyPath = path.join(tempDir, "run-history.jsonl");
		process.env.PI_SUBAGENTS_HISTORY_PATH = historyPath;

		recordRun("alpha", "do a thing", 0, 42);
		recordRun("beta", "do another thing", 1, 7);

		const lines = readLines(historyPath);
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]!);
		assert.equal(first.agent, "alpha");
		assert.equal(first.status, "ok");
		assert.equal(first.duration, 42);
		assert.equal(first.exit, undefined);
		const second = JSON.parse(lines[1]!);
		assert.equal(second.agent, "beta");
		assert.equal(second.status, "error");
		assert.equal(second.exit, 1);
	});

	it("does not rotate while at or below the threshold", () => {
		const historyPath = path.join(tempDir, "run-history.jsonl");
		process.env.PI_SUBAGENTS_HISTORY_PATH = historyPath;
		// Seed one line short of the threshold, then append once to hit it exactly.
		seedHistory(historyPath, ROTATE_READ_THRESHOLD - 1);

		recordRun("edge", "at threshold", 0, 1);

		const lines = readLines(historyPath);
		assert.equal(lines.length, ROTATE_READ_THRESHOLD);
	});

	it("rotates to the last ROTATE_KEEP entries once past the threshold", () => {
		const historyPath = path.join(tempDir, "run-history.jsonl");
		process.env.PI_SUBAGENTS_HISTORY_PATH = historyPath;
		// Seed exactly at threshold; the next append pushes to threshold+1 and triggers rotation.
		seedHistory(historyPath, ROTATE_READ_THRESHOLD);

		recordRun("rotator", "the newest run", 0, 5);

		const lines = readLines(historyPath);
		assert.equal(lines.length, ROTATE_KEEP);
		// The newest entry must survive as the last line.
		const last = JSON.parse(lines.at(-1)!);
		assert.equal(last.agent, "rotator");
		assert.equal(last.task, "the newest run");
		// Oldest kept line: total before trim is threshold+1, keep last ROTATE_KEEP,
		// so the first surviving seed is index (threshold + 1 - ROTATE_KEEP).
		const firstKept = JSON.parse(lines[0]!);
		assert.equal(firstKept.task, `seed-${ROTATE_READ_THRESHOLD + 1 - ROTATE_KEEP}`);
		// No temp artifact left behind.
		assert.equal(fs.existsSync(`${historyPath}.tmp-${process.pid}`), false);
	});

	it("skips writes under NODE_ENV=test when no path override is set", () => {
		delete process.env.PI_SUBAGENTS_HISTORY_PATH;
		process.env.NODE_ENV = "test";
		// Redirect the home-dir fallback into a temp dir so a skip-failure can never
		// touch the real production history file.
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;

		const fallbackPath = resolveHistoryPath();
		assert.ok(fallbackPath.startsWith(tempHome));

		recordRun("ghost", "should be dropped", 0, 1);

		assert.equal(fs.existsSync(fallbackPath), false);
	});

	it("still writes under NODE_ENV=test when a path override is set", () => {
		const historyPath = path.join(tempDir, "run-history.jsonl");
		process.env.PI_SUBAGENTS_HISTORY_PATH = historyPath;
		process.env.NODE_ENV = "test";

		recordRun("explicit", "override wins", 0, 1);

		const lines = readLines(historyPath);
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]!).agent, "explicit");
	});
});
