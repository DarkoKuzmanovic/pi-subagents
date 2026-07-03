/**
 * Integration tests for the runaway-stream watchdog (stream-budget wiring).
 *
 * Uses the local createMockPi() helper to simulate a child that floods
 * `--mode json` stdout with thinking-only events and never produces text or
 * tool activity — the runaway-loop signature observed in production. The
 * watchdog must abort the child past 30 MB and surface a clear step error.
 *
 * The trip thresholds themselves (30 MB no-progress, 200 MB hard cap,
 * progress detection) are covered exhaustively by test/unit/stream-budget.test.ts;
 * this file asserts the end-to-end wiring at the real 30 MB threshold.
 *
 * Requires pi packages for execution tests. Skips gracefully if unavailable.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	tryImport,
} from "../support/helpers.ts";

interface RunSyncResult {
	exitCode: number;
	error?: string;
	interrupted?: boolean;
	modelAttempts?: Array<{ success?: boolean; error?: string }>;
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const runSync = execution?.runSync;

/** One thinking-only child event (~64 KB serialized) with no progress marker. */
function thinkingFloodEvent(): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "loop ".repeat(13_000) }],
		},
	};
}

describe("runaway stream watchdog (foreground)", { skip: !runSync ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("aborts a child that floods >30 MB of thinking events with no text or tool activity", { timeout: 120_000 }, async () => {
		// ~500 events x ~65 KB ≈ 32 MB > the 30 MB no-progress trip.
		const flood = Array.from({ length: 500 }, () => thinkingFloodEvent());
		// A long keepalive means the test only finishes quickly because the
		// watchdog killed the child; a missed kill would hang here, not pass.
		mockPi.onCall({ jsonl: flood, keepAliveAfterFinalMessageMs: 60_000, exitCode: 0 });
		const agents = makeAgentConfigs(["flooder"]);

		const result = await runSync!(tempDir, agents, "flooder", "Summarize the repo", {});

		assert.equal(result.exitCode, 1, "runaway run must fail");
		assert.notEqual(result.interrupted, true);
		assert.match(result.error ?? "", /runaway output aborted: \d+ MB of model events with no text or tool activity \(likely a thinking loop\)/);
		// The failure must flow through the existing attempt/error reporting.
		assert.match(result.modelAttempts?.at(-1)?.error ?? "", /runaway output aborted/);
	});

	it("leaves a healthy small run untouched", async () => {
		mockPi.onCall({ output: "All done" });
		const agents = makeAgentConfigs(["healthy"]);

		const result = await runSync!(tempDir, agents, "healthy", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
	});
});
