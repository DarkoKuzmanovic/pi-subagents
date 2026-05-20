# Subagent Inactivity Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic timeout enforcement to subagent runs — kill hanging child pi processes after configurable inactivity thresholds.

**Architecture:** Extend the existing `ControlConfig` with timeout thresholds and kill actions. The 1s activity timer in `runSubagent()` already tracks per-step `lastActivityAt`; we add kill logic that fires after `stepInactivityTimeoutMs` (per-step) or `runWallClockTimeoutMs` (overall). Three actions: `notify` (current behavior), `escalate_then_kill` (nudge then SIGTERM), `auto_kill` (immediate SIGTERM).

**Tech Stack:** TypeScript, Node.js built-in test runner, TypeBox schemas

**Spec:** `docs/specs/2026-05-19-subagent-inactivity-timeout-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/shared/types.ts` | Type definitions: `ActivityState`, `ControlConfig`, `ResolvedControlConfig`, `ControlEvent` | Modify |
| `src/runs/shared/subagent-control.ts` | Config resolution, activity state derivation, event formatting | Modify |
| `src/runs/shared/long-running-guard.ts` | Timeout trigger functions | Modify |
| `src/runs/background/subagent-runner.ts` | Activity timer enforcement, kill logic, escalation state | Modify |
| `src/extension/schemas.ts` | TypeBox schema for `ControlOverrides` | Modify |
| `src/extension/control-notices.ts` | Control notice handling for new event types | Modify |
| `test/unit/subagent-control.test.ts` | Unit tests for config resolution, state derivation, event formatting | Modify |

---

### Task 1: Extend Types

**Files:**
- Modify: `src/shared/types.ts:52-96`

- [ ] **Step 1: Write the failing test**

Add tests to `test/unit/subagent-control.test.ts` for the new type values:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Add inside existing describe("subagent control attention state", ...) block:

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
	// Non-overridden fields keep defaults
	assert.equal(custom.runWallClockTimeoutMs, 1_800_000);
	assert.equal(custom.escalationGraceMs, 30_000);
});

it("deriveActivityState returns timed_out_escalating when step inactivity timeout exceeded", () => {
	const config = resolveControlConfig(undefined, {
		needsAttentionAfterMs: 300,
		stepInactivityTimeoutMs: 500,
		timeoutAction: "escalate_then_kill",
	});
	// Below step timeout
	assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
	// At step timeout
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: FAIL — `resolveControlConfig` doesn't return `stepInactivityTimeoutMs`, `deriveActivityState` doesn't return `"timed_out_escalating"` or `"timed_out"`.

- [ ] **Step 3: Extend ActivityState type**

In `src/shared/types.ts`, change line 52:

```typescript
// Before:
export type ActivityState = "active_long_running" | "needs_attention";

// After:
export type ActivityState = "active_long_running" | "needs_attention" | "timed_out_escalating" | "timed_out";
```

- [ ] **Step 4: Extend ControlEventType**

In `src/shared/types.ts`, change line 53:

```typescript
// Before:
export type ControlEventType = ActivityState;

// After:
export type ControlEventType = ActivityState | "timeout_killed";
```

- [ ] **Step 5: Extend ControlConfig**

In `src/shared/types.ts`, add fields to `ControlConfig` (after line 64, before the closing `}`):

```typescript
export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
	// --- NEW FIELDS ---
	stepInactivityTimeoutMs?: number;
	runWallClockTimeoutMs?: number;
	timeoutAction?: "notify" | "escalate_then_kill" | "auto_kill";
	escalationGraceMs?: number;
}
```

- [ ] **Step 6: Extend ResolvedControlConfig**

In `src/shared/types.ts`, add fields to `ResolvedControlConfig` (after line 75, before the closing `}`):

```typescript
export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
	// --- NEW FIELDS ---
	stepInactivityTimeoutMs: number;
	runWallClockTimeoutMs: number;
	timeoutAction: "notify" | "escalate_then_kill" | "auto_kill";
	escalationGraceMs: number;
}
```

- [ ] **Step 7: Extend ControlEvent.reason**

In `src/shared/types.ts`, change the `reason` union on line 87:

```typescript
// Before:
reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold";

// After:
reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold" | "step_inactivity_timeout" | "run_wall_clock_timeout" | "timeout_killed";
```

- [ ] **Step 8: Run test to verify it still fails (types added, logic not yet)**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: FAIL — `resolveControlConfig` doesn't return the new fields, `deriveActivityState` doesn't return new states.

- [ ] **Step 9: Commit types**

```bash
git add src/shared/types.ts test/unit/subagent-control.test.ts
git commit -m "feat(timeout): add ActivityState, ControlConfig, and ControlEvent type extensions for inactivity timeout"
```

---

### Task 2: Extend Config Resolution and Activity State Derivation

**Files:**
- Modify: `src/runs/shared/subagent-control.ts`

- [ ] **Step 1: Update DEFAULT_CONTROL_CONFIG**

In `src/runs/shared/subagent-control.ts`, extend `DEFAULT_CONTROL_CONFIG` (lines 14-21):

```typescript
export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	needsAttentionAfterMs: 120_000,
	activeNoticeAfterMs: 240_000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
	// --- NEW FIELDS ---
	stepInactivityTimeoutMs: 300_000,
	runWallClockTimeoutMs: 1_800_000,
	timeoutAction: "escalate_then_kill",
	escalationGraceMs: 30_000,
};
```

- [ ] **Step 2: Extend resolveControlConfig**

In `src/runs/shared/subagent-control.ts`, add parsing for the new fields inside `resolveControlConfig()` (after line 60, before the return):

```typescript
export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	// ... existing field resolution (lines 41-60) ...

	// --- NEW FIELDS ---
	const stepInactivityTimeoutMs = parsePositiveInt(override?.stepInactivityTimeoutMs)
		?? parsePositiveInt(globalConfig?.stepInactivityTimeoutMs)
		?? DEFAULT_CONTROL_CONFIG.stepInactivityTimeoutMs;
	const runWallClockTimeoutMs = parsePositiveInt(override?.runWallClockTimeoutMs)
		?? parsePositiveInt(globalConfig?.runWallClockTimeoutMs)
		?? DEFAULT_CONTROL_CONFIG.runWallClockTimeoutMs;
	const timeoutAction = override?.timeoutAction ?? globalConfig?.timeoutAction ?? DEFAULT_CONTROL_CONFIG.timeoutAction;
	const escalationGraceMs = parsePositiveInt(override?.escalationGraceMs)
		?? parsePositiveInt(globalConfig?.escalationGraceMs)
		?? DEFAULT_CONTROL_CONFIG.escalationGraceMs;

	return {
		enabled,
		needsAttentionAfterMs,
		activeNoticeAfterMs,
		activeNoticeAfterTurns,
		activeNoticeAfterTokens,
		failedToolAttemptsBeforeAttention,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
		// --- NEW FIELDS ---
		stepInactivityTimeoutMs,
		runWallClockTimeoutMs,
		timeoutAction,
		escalationGraceMs,
	};
}
```

- [ ] **Step 3: Extend deriveActivityState**

In `src/runs/shared/subagent-control.ts`, replace `deriveActivityState()` (lines 73-84):

```typescript
export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);

	// Check timeout thresholds first (higher priority than needs_attention)
	if (ageMs > input.config.stepInactivityTimeoutMs) {
		if (input.config.timeoutAction === "auto_kill") return "timed_out";
		if (input.config.timeoutAction === "escalate_then_kill") return "timed_out_escalating";
		// notify action falls through to needs_attention
	}

	if (ageMs > input.config.needsAttentionAfterMs) return "needs_attention";
	return undefined;
}
```

- [ ] **Step 4: Update CONTROL_EVENT_TYPES and DEFAULT_NOTIFY_ON**

In `src/runs/shared/subagent-control.ts`, update lines 10-12:

```typescript
const CONTROL_EVENT_TYPES: ControlEventType[] = ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["active_long_running", "needs_attention"];
```

Note: `timed_out_escalating`, `timed_out`, and `timeout_killed` are NOT in `DEFAULT_NOTIFY_ON` because they're handled by the enforcement logic directly, not as notifications to the parent. The escalation nudge and kill are actions, not notifications.

- [ ] **Step 5: Extend formatControlNoticeMessage for timeout events**

In `src/runs/shared/subagent-control.ts`, add timeout-specific branches to `formatControlNoticeMessage()` (before the default return at line 195):

```typescript
export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const runTarget = event.runId;

	if (event.reason === "completion_guard") {
		// ... existing completion_guard branch (unchanged) ...
	}

	// --- NEW: timeout escalation notice ---
	if (event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout") {
		const elapsedSeconds = event.elapsedMs !== undefined ? Math.floor(Math.max(0, event.elapsedMs) / 1000) : undefined;
		return [
			`Subagent idle timeout: ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			elapsedSeconds !== undefined ? `Idle for: ${elapsedSeconds}s` : undefined,
			"Action: Nudge sent via intercom. Will terminate if no response within grace period.",
			`Grace: subagent will be killed if no activity within ${Math.floor(deriveGraceMs(event) / 1000)}s`,
			`Interrupt now: subagent({ action: "interrupt", id: "${runTarget}" })`,
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	// --- NEW: timeout killed notice ---
	if (event.type === "timeout_killed" || event.reason === "timeout_killed") {
		return [
			`Subagent killed (inactivity timeout): ${event.agent}`,
			`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
			`Signal: ${event.message}`,
			"Action: Process terminated after inactivity timeout.",
			"The run will continue with remaining steps (if any).",
		].filter((line): line is string => Boolean(line)).join("\n");
	}

	// ... existing active_long_running and needs_attention branches (unchanged) ...
}

/** Helper to extract grace period from event context (fallback to default 30s) */
function deriveGraceMs(event: ControlEvent): number {
	// Grace period isn't on the event itself; use a reasonable default for display
	return 30_000;
}
```

- [ ] **Step 6: Extend formatControlIntercomMessage for timeout events**

In `src/runs/shared/subagent-control.ts`, add timeout branches to `formatControlIntercomMessage()` (inside the function, before the default return):

```typescript
export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const statusLabel = event.reason === "completion_guard"
		? "subagent failed"
		: event.type === "active_long_running"
			? "subagent active but long-running"
			: event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout"
				? "subagent idle timeout — escalating"
				: event.type === "timeout_killed" || event.reason === "timeout_killed"
					? "subagent killed (inactivity timeout)"
					: "subagent needs attention";

	return [
		statusLabel,
		"",
		event.reason === "completion_guard"
			? `${event.agent} failed in run ${event.runId}.`
			: event.type === "active_long_running"
				? `${event.agent} is still active but long-running in run ${event.runId}.`
				: event.type === "timed_out_escalating" || event.reason === "step_inactivity_timeout"
					? `${event.agent} idle timeout in run ${event.runId}. Nudge sent; will kill if no response.`
					: event.type === "timeout_killed" || event.reason === "timeout_killed"
						? `${event.agent} killed (inactivity timeout) in run ${event.runId}.`
						: `${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: PASS — all existing and new tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/runs/shared/subagent-control.ts src/shared/types.ts test/unit/subagent-control.test.ts
git commit -m "feat(timeout): extend resolveControlConfig and deriveActivityState with timeout fields and enforcement states"
```

---

### Task 3: Add Timeout Trigger Functions

**Files:**
- Modify: `src/runs/shared/long-running-guard.ts`
- Test: `test/unit/subagent-control.test.ts` (existing, add tests here since it already imports from long-running-guard)

- [ ] **Step 1: Write the failing test**

Add to `test/unit/subagent-control.test.ts`:

```typescript
import { nextLongRunningTrigger, nextStepTimeoutTrigger, nextRunTimeoutTrigger } from "../../src/runs/shared/long-running-guard.ts";

// Add inside existing describe block:

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: FAIL — `nextStepTimeoutTrigger` and `nextRunTimeoutTrigger` not exported.

- [ ] **Step 3: Implement nextStepTimeoutTrigger and nextRunTimeoutTrigger**

In `src/runs/shared/long-running-guard.ts`, add after `nextLongRunningTrigger` (after line 125):

```typescript
export interface StepTimeoutMetrics {
	lastActivityAt: number;
	now: number;
}

export function nextStepTimeoutTrigger(
	config: ResolvedControlConfig,
	metrics: StepTimeoutMetrics,
): "step_inactivity_timeout" | undefined {
	if (metrics.now - metrics.lastActivityAt > config.stepInactivityTimeoutMs) {
		return "step_inactivity_timeout";
	}
	return undefined;
}

export interface RunTimeoutMetrics {
	startedAt: number;
	now: number;
}

export function nextRunTimeoutTrigger(
	config: ResolvedControlConfig,
	metrics: RunTimeoutMetrics,
): "run_wall_clock_timeout" | undefined {
	if (metrics.now - metrics.startedAt > config.runWallClockTimeoutMs) {
		return "run_wall_clock_timeout";
	}
	return undefined;
}
```

Also add the import at the top of the file:

```typescript
import type { ResolvedControlConfig } from "../../shared/types.ts";
```

This import already exists at line 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runs/shared/long-running-guard.ts test/unit/subagent-control.test.ts
git commit -m "feat(timeout): add nextStepTimeoutTrigger and nextRunTimeoutTrigger functions"
```

---

### Task 4: Extend TypeBox Schema for ControlOverrides

**Files:**
- Modify: `src/extension/schemas.ts:86-99`

- [ ] **Step 1: Add timeout fields to ControlOverrides**

In `src/extension/schemas.ts`, extend the `ControlOverrides` TypeBox object (after line 98, before the closing `})`:

```typescript
const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
	// --- NEW FIELDS ---
	stepInactivityTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-step inactivity timeout in ms. Kill step if no child event for this duration (default: 300000 = 5min)" })),
	runWallClockTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Overall run wall-clock timeout in ms. Kill entire run if total elapsed exceeds this (default: 1800000 = 30min)" })),
	timeoutAction: Type.Optional(Type.String({ enum: ["notify", "escalate_then_kill", "auto_kill"], description: "Action on timeout: 'notify' (current behavior), 'escalate_then_kill' (nudge then kill), 'auto_kill' (immediate kill). Default: escalate_then_kill" })),
	escalationGraceMs: Type.Optional(Type.Integer({ minimum: 1, description: "Grace period in ms after escalation nudge before killing (default: 30000 = 30s). Only used with escalate_then_kill." })),
});
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension/schemas.ts
git commit -m "feat(timeout): add timeout fields to ControlOverrides TypeBox schema"
```

---

### Task 5: Implement Timeout Enforcement in Activity Timer

**Files:**
- Modify: `src/runs/background/subagent-runner.ts`

This is the core change. The existing `activityTimer` (1s interval) already checks per-step activity and emits control events. We add timeout enforcement after those checks.

- [ ] **Step 1: Add imports**

In `src/runs/background/subagent-runner.ts`, add to the import from `long-running-guard.ts`:

```typescript
import {
	isMutatingTool,
	nextLongRunningTrigger,
	nextStepTimeoutTrigger,
	nextRunTimeoutTrigger,
} from "../shared/long-running-guard.ts";
```

- [ ] **Step 2: Add per-step escalation state tracking**

In `runSubagent()`, add tracking state near the other state variables (around line 880, after `let latestSessionFile`):

```typescript
	// Per-step escalation tracking for timed_out_escalating → timed_out transitions
	const stepEscalationStartedAt: Array<number | undefined> = flatSteps.map(() => undefined);
```

- [ ] **Step 3: Add killStep helper function**

Inside `runSubagent()`, after `appendControlEvent` definition (around line 940), add:

```typescript
	const killStep = (flatIndex: number, reason: "step_inactivity_timeout" | "run_wall_clock_timeout"): void => {
		const step = statusPayload.steps[flatIndex];
		if (!step || step.status !== "running") return;
		const now = Date.now();
		const previous = step.activityState;
		step.activityState = "timed_out";
		step.status = "failed";
		step.endedAt = now;
		step.durationMs = step.startedAt ? now - step.startedAt : undefined;
		step.exitCode = 1;
		const elapsedSeconds = step.lastActivityAt
			? Math.floor(Math.max(0, now - step.lastActivityAt) / 1000)
			: undefined;
		step.error = reason === "step_inactivity_timeout"
			? `Timed out: no activity for ${elapsedSeconds}s (step inactivity timeout)`
			: `Timed out: run exceeded ${Math.floor(Math.max(0, now - overallStartTime) / 1000)}s wall-clock limit`;

		appendControlEvent(buildControlEvent({
			type: "timeout_killed",
			from: previous,
			to: "timed_out",
			runId: id,
			agent: step.agent,
			index: flatIndex,
			ts: now,
			message: step.error,
			reason: "timeout_killed",
			turns: step.turnCount,
			tokens: step.tokens?.total,
			toolCount: step.toolCount,
			currentTool: step.currentTool,
			currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
			currentPath: step.currentPath,
			elapsedMs: step.lastActivityAt ? Math.max(0, now - step.lastActivityAt) : undefined,
		}));
		statusPayload.lastUpdate = now;
		writeAtomicJson(statusPath, statusPayload);
		// Kill the child process
		activeChildInterrupt?.();
	};
```

- [ ] **Step 4: Add timeout checks to updateRunnerActivityState**

In `runSubagent()`, inside the `updateRunnerActivityState` function (which runs on the 1s activityTimer), add timeout checks after the existing `deriveActivityState` logic. Find the section where `deriveActivityState` is called per step and extend it:

Replace the existing idle state check block (approximately lines where `deriveActivityState` is called per step inside `updateRunnerActivityState`) with:

```typescript
	const updateRunnerActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		let changed = false;
		let runLastActivityAt = statusPayload.lastActivityAt ?? overallStartTime;

		// Check run wall-clock timeout first (kills ALL running steps)
		const runTimeoutReason = nextRunTimeoutTrigger(controlConfig, { startedAt: overallStartTime, now });
		if (runTimeoutReason) {
			for (let index = 0; index < statusPayload.steps.length; index++) {
				if (statusPayload.steps[index]?.status === "running") {
					killStep(index, runTimeoutReason);
					changed = true;
				}
			}
			statusPayload.state = "failed";
			statusPayload.endedAt = now;
			statusPayload.lastUpdate = now;
			writeAtomicJson(statusPath, statusPayload);
			return changed;
		}

		for (let index = 0; index < statusPayload.steps.length; index++) {
			const step = statusPayload.steps[index]!;
			if (step.status !== "running") continue;
			const lastActivityAt = stepOutputActivityAt(index);
			runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
			if (step.lastActivityAt !== lastActivityAt) {
				step.lastActivityAt = lastActivityAt;
				changed = true;
			}

			// Check step inactivity timeout
			const stepTimeoutReason = nextStepTimeoutTrigger(controlConfig, {
				lastActivityAt,
				now,
			});

			if (stepTimeoutReason && controlConfig.timeoutAction !== "notify") {
				if (step.activityState !== "timed_out") {
					if (controlConfig.timeoutAction === "auto_kill") {
						// Auto-kill: immediate
						killStep(index, stepTimeoutReason);
						changed = true;
						continue;
					}
					if (controlConfig.timeoutAction === "escalate_then_kill") {
						if (step.activityState !== "timed_out_escalating") {
							// First detection: escalate
							const previous = step.activityState;
							step.activityState = "timed_out_escalating";
							stepEscalationStartedAt[index] = now;
							appendControlEvent(buildControlEvent({
								type: "timed_out_escalating",
								from: previous,
								to: "timed_out_escalating",
								runId: id,
								agent: step.agent,
								index,
								ts: now,
								lastActivityAt,
								message: `${step.agent} idle for ${Math.floor(Math.max(0, now - lastActivityAt) / 1000)}s — escalation nudge sent`,
								reason: "step_inactivity_timeout",
								turns: step.turnCount,
								tokens: step.tokens?.total,
								toolCount: step.toolCount,
								currentTool: step.currentTool,
								currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
								currentPath: step.currentPath,
								elapsedMs: Math.max(0, now - lastActivityAt),
							}));
							changed = true;
						} else if (stepEscalationStartedAt[index] !== undefined
							&& now - stepEscalationStartedAt[index]! >= controlConfig.escalationGraceMs) {
							// Grace period expired: kill
							killStep(index, stepTimeoutReason);
							changed = true;
							continue;
						}
						// Otherwise: still in grace period, waiting
					}
				}
			} else {
				// No timeout (or notify action): fall through to existing logic
				const idleState = deriveActivityState({
					config: controlConfig,
					startedAt: step.startedAt ?? overallStartTime,
					lastActivityAt,
					now,
				});
				if (idleState === "needs_attention" && step.activityState !== "timed_out_escalating" && step.activityState !== "timed_out") {
					const previous = step.activityState;
					step.activityState = "needs_attention";
					if (previous !== "needs_attention") {
						appendControlEvent(buildControlEvent({
							from: previous,
							to: "needs_attention",
							runId: id,
							agent: step.agent,
							index,
							ts: now,
							lastActivityAt,
						}));
						changed = true;
					}
				}
				maybeEmitActiveLongRunning(index, now);
			}
		}

		if (statusPayload.lastActivityAt !== runLastActivityAt) {
			statusPayload.lastActivityAt = runLastActivityAt;
			changed = true;
		}
		const nextRunState = statusPayload.steps.some((step) => step.activityState === "needs_attention" || step.activityState === "timed_out" || step.activityState === "timed_out_escalating")
			? (statusPayload.steps.some((step) => step.activityState === "timed_out")
				? "timed_out"
				: statusPayload.steps.some((step) => step.activityState === "timed_out_escalating")
					? "timed_out_escalating"
					: "needs_attention")
			: statusPayload.steps.some((step) => step.activityState === "active_long_running")
				? "active_long_running"
				: undefined;
		if (nextRunState !== currentActivityState) {
			currentActivityState = nextRunState;
			statusPayload.activityState = nextRunState;
			changed = true;
		}
		statusPayload.lastUpdate = now;
		if (changed) writeAtomicJson(statusPath, statusPayload);
		return changed;
	};
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run all unit tests**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/runs/background/subagent-runner.ts
git commit -m "feat(timeout): implement timeout enforcement in activity timer with kill logic"
```

---

### Task 6: Update Control Notice Handler for New Event Types

**Files:**
- Modify: `src/extension/control-notices.ts`

- [ ] **Step 1: Read the current file**

Read `src/extension/control-notices.ts` to understand the current `handleSubagentControlNotice` logic.

- [ ] **Step 2: Add handling for timed_out_escalating and timeout_killed events**

In `handleSubagentControlNotice`, add branches for the new event types. The key behavior:

- `timed_out_escalating`: Display a notice that the subagent will be killed if it doesn't respond. Don't add to actionable notices (it's auto-handled).
- `timeout_killed`: Display a notice that the subagent was killed. Not actionable (already dead).

The exact code depends on the current structure. At minimum, ensure the new event types don't crash the handler — they should fall through to display logic.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/extension/control-notices.ts
git commit -m "feat(timeout): handle timed_out_escalating and timeout_killed control notices"
```

---

### Task 7: Integration Testing — Verify Full Flow

**Files:**
- Modify: `test/unit/subagent-control.test.ts` (add more thorough tests)

- [ ] **Step 1: Write tests for full escalation flow**

```typescript
it("escalate_then_kill transitions: needs_attention → timed_out_escalating → timed_out", () => {
	const config = resolveControlConfig(undefined, {
		needsAttentionAfterMs: 100,
		stepInactivityTimeoutMs: 300,
		timeoutAction: "escalate_then_kill",
		escalationGraceMs: 50,
	});

	// Below needsAttention threshold
	assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);

	// Above needsAttention, below timeout
	assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 200 }), "needs_attention");

	// Above timeout threshold
	assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "timed_out_escalating");

	// After escalation grace (this would be handled by the runner, not deriveActivityState)
	// deriveActivityState always returns timed_out_escalating for escalate_then_kill
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
```

- [ ] **Step 2: Run all unit tests**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add test/unit/subagent-control.test.ts
git commit -m "test(timeout): add integration tests for full escalation flow and timeout event formatting"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm run test:all`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Verify no regressions in existing control flow**

Run: `npx tsx --test test/unit/subagent-control.test.ts`
Expected: All existing tests still pass (needs_attention, active_long_running, completion_guard flows unchanged for `timeoutAction: "notify"`)

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat(timeout): subagent inactivity timeout with configurable kill actions — complete"
```
