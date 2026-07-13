import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildControlEvent,
	claimControlNotification,
	controlNotificationKey,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldNotifyControlEvent,
} from "../../src/runs/shared/subagent-control.ts";
import { nextLongRunningTrigger, nextStepTimeoutTrigger, nextRunTimeoutTrigger } from "../../src/runs/shared/long-running-guard.ts";

const config = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
	it("marks a run as needing attention only after the idle threshold", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
	});


	it("builds compact needs-attention control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 1_000,
			lastActivityAt: 100,
		});
		assert.deepEqual(event, {
			type: "needs_attention",
			to: "needs_attention",
			ts: 1_000,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker needs attention (no observed activity for 0s)",
			reason: "idle",
			elapsedMs: 900,
		});
	});

	it("supports a specific attention message", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
		});

		assert.equal(event.message, "worker completed without making edits for an implementation task");
	});

	it("builds terminal completion guard control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		assert.equal(event.reason, "completion_guard");
	});

	it("defaults notifications to active-long-running and needs attention", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		const activeEvent = buildControlEvent({ type: "active_long_running", to: "active_long_running", runId: "run-1", agent: "worker" });
		assert.equal(shouldNotifyControlEvent(config, event), true);
		assert.equal(shouldNotifyControlEvent(config, activeEvent), true);
		assert.deepEqual(config.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(config.notifyChannels, ["event", "async", "intercom"]);
	});

	it("defaults active-long-running notices to elapsed time only", () => {
		const defaults = resolveControlConfig();

		assert.equal(defaults.activeNoticeAfterMs, 240_000);
		assert.equal(defaults.activeNoticeAfterTurns, undefined);
		assert.equal(defaults.activeNoticeAfterTokens, undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 77_000,
			turns: 50,
			tokens: 800_000,
		}), undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 240_000,
			turns: 1,
			tokens: 1,
		}), "time_threshold");
	});

	it("supports opt-in turn and token long-running thresholds", () => {
		const tokenBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 500_000 });
		const turnBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 5 });

		assert.equal(nextLongRunningTrigger(tokenBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 1,
			tokens: 500_000,
		}), "token_threshold");
		assert.equal(nextLongRunningTrigger(turnBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 5,
			tokens: 1,
		}), "turn_threshold");
	});

	it("resolves custom notification config", () => {
		const custom = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1234,
			activeNoticeAfterMs: 2345,
			activeNoticeAfterTurns: 7,
			activeNoticeAfterTokens: 8000,
			failedToolAttemptsBeforeAttention: 4,
			notifyOn: ["active_long_running", "needs_attention", "nope" as never],
			notifyChannels: ["event", "intercom", "bad" as never],
		});
		assert.equal(custom.needsAttentionAfterMs, 1234);
		assert.equal(custom.activeNoticeAfterMs, 2345);
		assert.equal(custom.activeNoticeAfterTurns, 7);
		assert.equal(custom.activeNoticeAfterTokens, 8000);
		assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
	});

	it("falls back to defaults for invalid non-empty notification arrays", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: ["bogus" as never],
			notifyChannels: ["bogus" as never],
		});
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "async", "intercom"]);
	});

	it("allows empty notification arrays to disable notifications", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: [],
			notifyChannels: [],
		});
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.deepEqual(custom.notifyOn, []);
		assert.deepEqual(custom.notifyChannels, []);
		assert.equal(shouldNotifyControlEvent(custom, event), false);
	});

	it("formats control notices with a proactive hint and concrete commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /Subagent needs attention: worker/);
		assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
		assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
		assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
		assert.doesNotMatch(message, /Wait:/);
	});

	it("formats active-long-running notices as informational", () => {
		const event = buildControlEvent({
			type: "active_long_running",
			to: "active_long_running",
			runId: "78f659a3",
			agent: "worker",
			turns: 15,
			tokens: 160000,
			toolCount: 42,
			currentTool: "edit",
			currentPath: "src/runs/background/async-status.ts",
			reason: "turn_threshold",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent active but long-running: worker/);
		assert.match(message, /Inspect status/);
		assert.match(message, /15 turns/);
		assert.match(message, /160000 tokens/);
		assert.match(message, /path src\/runs\/background\/async-status\.ts/);
		assert.doesNotMatch(message, /Subagent needs attention/);
	});

	it("formats terminal completion guard notices without live-run commands", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent failed: worker/);
		assert.match(message, /read the output artifact or session/);
		assert.match(message, /Run intercom target \(may be inactive\): subagent-worker-78f659a3-1/);
		assert.doesNotMatch(message, /Status:/);
		assert.doesNotMatch(message, /Interrupt:/);
		assert.doesNotMatch(message, /What are you blocked on/);
	});

	it("formats intercom notifications with the same control commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /worker needs attention in run 78f659a3/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
	});

	it("dedupes notifications once per child target and attention state", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker", index: 0 });
		const seen = new Set<string>();

		assert.equal(controlNotificationKey(event, "subagent-worker-run-1-1"), "subagent-worker-run-1-1:needs_attention:idle");
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), false);

		const terminalEvent = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});
		assert.equal(claimControlNotification(resolveControlConfig(), terminalEvent, seen, "subagent-worker-run-1-1"), true);
	});
});

describe("timeout configuration", () => {
	it("resolveControlConfig includes timeout defaults", () => {
		const defaults = resolveControlConfig();
		assert.equal(defaults.stepInactivityTimeoutMs, 300_000);
		assert.equal(defaults.runWallClockTimeoutMs, 1_800_000);
		assert.equal(defaults.timeoutAction, "escalate_then_kill");
		assert.equal(defaults.escalationGraceMs, 30_000);
	});

	it("resolveControlConfig merges timeout overrides", () => {
		const custom = resolveControlConfig(undefined, {
			stepInactivityTimeoutMs: 60_000,
			timeoutAction: "auto_kill",
		});
		assert.equal(custom.stepInactivityTimeoutMs, 60_000);
		assert.equal(custom.timeoutAction, "auto_kill");
		assert.equal(custom.runWallClockTimeoutMs, 1_800_000);
		assert.equal(custom.escalationGraceMs, 30_000);
	});

	it("deriveActivityState returns timed_out_escalating when step inactivity timeout exceeded", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 300,
			stepInactivityTimeoutMs: 500,
			timeoutAction: "escalate_then_kill",
		});
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 550 }), "timed_out_escalating");
	});

	it("deriveActivityState returns timed_out for auto_kill action", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 300,
			stepInactivityTimeoutMs: 500,
			timeoutAction: "auto_kill",
		});
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 550 }), "timed_out");
	});

	it("deriveActivityState returns needs_attention for notify action even past timeout", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 300,
			stepInactivityTimeoutMs: 500,
			timeoutAction: "notify",
		});
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 550 }), "needs_attention");
	});
});

describe("timeout trigger functions", () => {
	it("nextStepTimeoutTrigger returns step_inactivity_timeout when step inactivity exceeds threshold", () => {
		const config = resolveControlConfig(undefined, { stepInactivityTimeoutMs: 300_000 });
		assert.equal(nextStepTimeoutTrigger(config, { lastActivityAt: 0, now: 350_000 }), "step_inactivity_timeout");
		assert.equal(nextStepTimeoutTrigger(config, { lastActivityAt: 0, now: 200_000 }), undefined);
	});

	it("nextRunTimeoutTrigger returns run_wall_clock_timeout when total elapsed exceeds threshold", () => {
		const config = resolveControlConfig(undefined, { runWallClockTimeoutMs: 600_000 });
		assert.equal(nextRunTimeoutTrigger(config, { startedAt: 0, now: 650_000 }), "run_wall_clock_timeout");
		assert.equal(nextRunTimeoutTrigger(config, { startedAt: 0, now: 400_000 }), undefined);
	});
});

describe("timeout escalation flow", () => {
	it("escalate_then_kill transitions: needs_attention \u2192 timed_out_escalating \u2192 timed_out", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 100,
			stepInactivityTimeoutMs: 300,
			timeoutAction: "escalate_then_kill",
			escalationGraceMs: 50,
		});

		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 200 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "timed_out_escalating");
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 500 }), "timed_out_escalating");
	});

	it("auto_kill returns timed_out directly", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 100,
			stepInactivityTimeoutMs: 300,
			timeoutAction: "auto_kill",
		});

		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "timed_out");
	});

	it("notify never transitions to timeout states", () => {
		const config = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 100,
			stepInactivityTimeoutMs: 300,
			timeoutAction: "notify",
		});

		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
	});

	it("buildControlEvent supports timeout_killed type", () => {
		const event = buildControlEvent({
			type: "timeout_killed",
			to: "timed_out",
			runId: "run-1",
			agent: "worker",
			index: 0,
			ts: 1000,
			message: "Timed out: no activity for 300s",
			reason: "timeout_killed",
		});

		assert.equal(event.type, "timeout_killed");
		assert.equal(event.to, "timed_out");
		assert.equal(event.reason, "timeout_killed");
	});

	it("formatControlNoticeMessage formats timeout_killed events", () => {
		const event = buildControlEvent({
			type: "timeout_killed",
			to: "timed_out",
			runId: "78f659a3",
			agent: "worker",
			message: "Timed out: no activity for 300s (step inactivity timeout)",
			reason: "timeout_killed",
		});

		const message = formatControlNoticeMessage(event);

		assert.match(message, /Subagent killed \(inactivity timeout\): worker/);
		assert.match(message, /Process terminated after inactivity timeout/);
	});

	it("uses the configured grace period and does not invent a nudge route", () => {
		const event = buildControlEvent({
			type: "timed_out_escalating",
			to: "timed_out_escalating",
			runId: "run-1",
			agent: "worker",
			message: "Timed out",
			reason: "step_inactivity_timeout",
		});

		const message = formatControlNoticeMessage(event, undefined, 5_000);
		assert.match(message, /Grace: subagent will be killed if no activity within 5s/);
		assert.match(message, /Action: no child message route registered/);
		assert.doesNotMatch(message, /Nudge sent via intercom/);
	});
});
