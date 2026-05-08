import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildChainSummary } from "../../src/shared/formatters.ts";
import type { ChainStep } from "../../src/shared/settings.ts";
import type { SingleResult } from "../../src/shared/types.ts";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "worker",
		task: "do work",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		...overrides,
	};
}

const steps: ChainStep[] = [
	{ agent: "scout", task: "scan" },
	{ agent: "worker", task: "implement" },
];

describe("buildChainSummary recovered output", () => {
	let chainDir: string;

	beforeEach(() => {
		chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-test-"));
	});
	afterEach(() => {
		fs.rmSync(chainDir, { recursive: true, force: true });
	});

	it("includes recovered output from a failed sequential step", () => {
		const results = [makeResult({ agent: "scout" })];
		const summary = buildChainSummary(steps, results, chainDir, "failed", {
			index: 1,
			error: "exit code 1",
			recoveredOutput: "Partial implementation done.\nCreated foo.ts and bar.ts.",
		});
		assert.ok(summary.includes("❌ Chain failed at step 2"));
		assert.ok(summary.includes("exit code 1"));
		assert.ok(summary.includes("Recovered output (produced before failure)"));
		assert.ok(summary.includes("Partial implementation done."));
		assert.ok(summary.includes("Created foo.ts and bar.ts."));
	});

	it("omits recovered output section when there is none", () => {
		const results = [makeResult({ agent: "scout" })];
		const summary = buildChainSummary(steps, results, chainDir, "failed", {
			index: 1,
			error: "timeout",
		});
		assert.ok(summary.includes("❌ Chain failed at step 2: timeout"));
		assert.ok(!summary.includes("Recovered output"));
	});

	it("omits recovered output section when recoveredOutput is empty", () => {
		const results = [makeResult({ agent: "scout" })];
		const summary = buildChainSummary(steps, results, chainDir, "failed", {
			index: 0,
			error: "crash",
			recoveredOutput: undefined,
		});
		assert.ok(!summary.includes("Recovered output"));
	});

	it("shows step number and error without failedStep", () => {
		const results = [makeResult({ agent: "scout" })];
		const summary = buildChainSummary(steps, results, chainDir, "failed");
		assert.ok(summary.includes("❌ Chain failed"));
		assert.ok(!summary.includes("at step"));
		assert.ok(!summary.includes("Recovered output"));
	});

	it("shows recovered output for parallel step failures", () => {
		const parallelSteps: ChainStep[] = [
			{ parallel: [{ agent: "a", task: "t1" }, { agent: "b", task: "t2" }] },
		];
		const results = [
			makeResult({ agent: "a", exitCode: 1 }),
			makeResult({ agent: "b", exitCode: 0 }),
		];
		const recoveredOutput = [
			"[Task 1 (a)]:",
			"Started processing but hit an error.",
		].join("\n");
		const summary = buildChainSummary(parallelSteps, results, chainDir, "failed", {
			index: 0,
			error: "Parallel step 1 failed:\n- Task 1 (a): exit code 1",
			recoveredOutput,
		});
		assert.ok(summary.includes("❌ Chain failed at step 1"));
		assert.ok(summary.includes("Recovered output (produced before failure)"));
		assert.ok(summary.includes("[Task 1 (a)]"));
		assert.ok(summary.includes("Started processing but hit an error."));
	});
});
