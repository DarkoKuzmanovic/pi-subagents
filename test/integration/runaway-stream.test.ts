/**
 * Integration tests for the runaway-stream watchdog (stream-budget wiring).
 *
 * Uses the local createMockPi() helper to simulate a child that floods
 * `--mode json` stdout with thinking-only events and never produces text or
 * tool activity — the runaway-loop signature observed in production. The
 * watchdog must abort the child, surfacing a clear step error.
 *
 * The trip thresholds themselves (8 MB delta-aware no-progress, 32 MB non-JSON backstop,
 * 200 MB / 1 GB hard caps, progress detection) are covered exhaustively by
 * test/unit/stream-budget.test.ts; this file asserts the end-to-end wiring: a
 * no-progress thinking flood crosses the accounted no-progress trip and aborts.
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
	makeAgent,
	makeAgentConfigs,
	tryImport,
} from "../support/helpers.ts";

interface RunSyncResult {
	exitCode: number;
	error?: string;
	interrupted?: boolean;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: Array<{ success?: boolean; error?: string }>;
	finalOutput?: string;
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

/**
 * One thinking-only assistant message (~65 KB) with no text or tool activity. A
 * non-delta event is accounted at its full serialized size, so ~130 of them cross the
 * 8 MB accounted no-progress trip.
 */
function thinkingFloodEvent(): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "thinking", thinking: "loop ".repeat(13_000) }],
		},
	};
}

function textProgressEvent(): Record<string, unknown> {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Initial progress" }],
			stopReason: "toolUse",
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

	it("aborts a child that floods thinking events with no text or tool activity", { timeout: 120_000 }, async () => {
		// ~200 thinking-only events x ~65 KB; accounted crosses the 8 MB no-progress trip after ~130.
		const flood = Array.from({ length: 200 }, () => thinkingFloodEvent());
		// A long keepalive means the test only finishes quickly because the
		// watchdog killed the child; a missed kill would hang here, not pass.
		mockPi.onCall({ jsonl: flood, keepAliveAfterFinalMessageMs: 60_000, exitCode: 0 });
		const agents = makeAgentConfigs(["flooder"]);

		const result = await runSync!(tempDir, agents, "flooder", "Summarize the repo", {});

		assert.equal(result.exitCode, 1, "runaway run must fail");
		assert.notEqual(result.interrupted, true);
		assert.match(result.error ?? "", /runaway output aborted: \d+ MB of model output since last text or tool activity .*likely a thinking loop/);
		// The failure must flow through the existing attempt/error reporting.
		assert.match(result.modelAttempts?.at(-1)?.error ?? "", /runaway output aborted/);
	});

	it("retries a runaway MiniMax attempt on the configured fallback", { timeout: 120_000 }, async () => {
		const flood = Array.from({ length: 200 }, () => thinkingFloodEvent());
		mockPi.onCall({ jsonl: flood, keepAliveAfterFinalMessageMs: 60_000, exitCode: 0 });
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("flooder", {
			model: "minimax/MiniMax-M3",
			thinking: "high",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync!(tempDir, agents, "flooder", "Summarize the repo", {
			runId: "runaway-fallback",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4:high");
		assert.deepEqual(result.attemptedModels, ["minimax/MiniMax-M3", "anthropic/claude-sonnet-4"]);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
		assert.match(result.modelAttempts?.[0]?.error ?? "", /runaway output aborted/);
		assert.equal(result.finalOutput, "Recovered on fallback");
		assert.equal(mockPi.callCount(), 2);
	});

	it("aborts a later thinking-only flood after earlier progress", { timeout: 120_000 }, async () => {
		const flood = Array.from({ length: 200 }, () => thinkingFloodEvent());
		mockPi.onCall({ jsonl: [textProgressEvent(), ...flood], keepAliveAfterFinalMessageMs: 2_000, exitCode: 0 });
		const agents = makeAgentConfigs(["late-flooder"]);

		const result = await runSync!(tempDir, agents, "late-flooder", "Continue after the first tool result", {});

		assert.equal(result.exitCode, 1, "later runaway turn must fail even after prior progress");
		assert.match(result.error ?? "", /since last text or tool activity/);
	});

	it("leaves a healthy small run untouched", async () => {
		mockPi.onCall({ output: "All done" });
		const agents = makeAgentConfigs(["healthy"]);

		const result = await runSync!(tempDir, agents, "healthy", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
	});
});
