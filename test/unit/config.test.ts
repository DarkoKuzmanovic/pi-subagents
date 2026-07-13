import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeConfig } from "../../src/extension/config.ts";

describe("sanitizeConfig", () => {
	it("drops malformed optional fields while retaining valid configuration", () => {
		const config = sanitizeConfig({
			asyncByDefault: true,
			defaultSessionDir: 42,
			maxSubagentDepth: "2",
			control: { enabled: "yes", escalationGraceMs: "fast", timeoutAction: "bad" },
			parallel: { maxTasks: 3, concurrency: "two" },
			intercomBridge: { mode: "always", instructionFile: 7 },
		});

		assert.deepEqual(config, {
			asyncByDefault: true,
			control: {},
			parallel: { maxTasks: 3 },
			intercomBridge: { mode: "always" },
		});
	});

	it("preserves a fully populated valid configuration", () => {
		const config = sanitizeConfig({
			asyncByDefault: true,
			forceTopLevelAsync: false,
			defaultSessionDir: "~/subagent-sessions",
			maxSubagentDepth: 2,
			sessionTokenBudget: 3_000,
			worktreeSetupHook: "./scripts/setup-worktree.mjs",
			worktreeSetupHookTimeoutMs: 15_000,
			inlineReadMaxBytes: 4_096,
			dynamicFanoutMaxItems: 8,
			control: {
				enabled: true,
				needsAttentionAfterMs: 1_000,
				activeNoticeAfterMs: 2_000,
				activeNoticeAfterTurns: 3,
				activeNoticeAfterTokens: 4_000,
				failedToolAttemptsBeforeAttention: 2,
				stepInactivityTimeoutMs: 5_000,
				runWallClockTimeoutMs: 6_000,
				escalationGraceMs: 7_000,
				timeoutAction: "escalate_then_kill",
				notifyOn: ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"],
				notifyChannels: ["event", "async", "intercom"],
			},
			parallel: { maxTasks: 4, concurrency: 2 },
			intercomBridge: { mode: "always", instructionFile: "~/bridge.md" },
		});

		assert.deepEqual(config, {
			asyncByDefault: true,
			forceTopLevelAsync: false,
			defaultSessionDir: "~/subagent-sessions",
			maxSubagentDepth: 2,
			sessionTokenBudget: 3_000,
			worktreeSetupHook: "./scripts/setup-worktree.mjs",
			worktreeSetupHookTimeoutMs: 15_000,
			inlineReadMaxBytes: 4_096,
			dynamicFanoutMaxItems: 8,
			control: {
				enabled: true,
				needsAttentionAfterMs: 1_000,
				activeNoticeAfterMs: 2_000,
				activeNoticeAfterTurns: 3,
				activeNoticeAfterTokens: 4_000,
				failedToolAttemptsBeforeAttention: 2,
				stepInactivityTimeoutMs: 5_000,
				runWallClockTimeoutMs: 6_000,
				escalationGraceMs: 7_000,
				timeoutAction: "escalate_then_kill",
				notifyOn: ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"],
				notifyChannels: ["event", "async", "intercom"],
			},
			parallel: { maxTasks: 4, concurrency: 2 },
			intercomBridge: { mode: "always", instructionFile: "~/bridge.md" },
		});
	});

	it("returns an empty configuration for non-object values", () => {
		for (const value of [null, [], "config", 1, false]) {
			assert.deepEqual(sanitizeConfig(value), {});
		}
	});

	it("keeps valid control-list members while dropping invalid values", () => {
		const config = sanitizeConfig({
			control: {
				notifyOn: ["needs_attention", "invalid", 1],
				notifyChannels: ["event", "invalid", null],
			},
		});

		assert.deepEqual(config, {
			control: {
				notifyOn: ["needs_attention"],
				notifyChannels: ["event"],
			},
		});
	});
});
