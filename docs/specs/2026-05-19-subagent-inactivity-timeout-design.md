# Subagent Inactivity Timeout

**Date:** 2026-05-19
**Status:** Draft
**Scope:** pi-subagents extension

## Problem

Child pi processes can hang internally — alive but producing zero events (API stall, network hang, etc.). The existing control system detects and notifies (`needs_attention` after 120s idle, `active_long_running` after 240s) but never automatically terminates the hanging subagent. The orchestrator must manually call `subagent({ action: "interrupt" })`.

For completely silent children, the activity tracker correctly identifies the problem but has no enforcement mechanism. The subagent sits idle indefinitely, burning resources and blocking progress.

## Design

### Approach

Extend the existing `ControlConfig` with timeout thresholds and kill actions. The infrastructure (1s activity timer, per-step `lastActivityAt` tracking, control event pipeline) is already in place — we add enforcement as a new phase after the existing notification checks.

### New Config Fields

```typescript
interface ControlConfig {
  // ... existing fields ...
  stepInactivityTimeoutMs?: number;    // per-step: no child event for N ms → timeout
  runWallClockTimeoutMs?: number;      // overall: total elapsed > N ms → timeout
  timeoutAction?: "notify" | "escalate_then_kill" | "auto_kill";
  escalationGraceMs?: number;          // for escalate_then_kill: wait N ms after nudge before kill
}

interface ResolvedControlConfig {
  // ... existing fields ...
  stepInactivityTimeoutMs: number;     // default: 300_000 (5 min)
  runWallClockTimeoutMs: number;       // default: 1_800_000 (30 min)
  timeoutAction: "notify" | "escalate_then_kill" | "auto_kill"; // default: "escalate_then_kill"
  escalationGraceMs: number;           // default: 30_000 (30s)
}
```

**Key design decision:** Default `timeoutAction` is `"escalate_then_kill"`, not `"notify"`. The whole point of this feature is to auto-fix hangs. Users who prefer the current observation-only behavior can set `timeoutAction: "notify"`.

The existing `needsAttentionAfterMs` (120s) and `activeNoticeAfterMs` (240s) remain unchanged — they handle *early warning*. The new fields handle *enforcement*.

### Timeout Enforcement Flow

#### `timeoutAction: "escalate_then_kill"`

```
Step running, emitting events normally
  │
  ▼ (no child event for stepInactivityTimeoutMs)
Step activityState → "timed_out_escalating"
  │ Send nudge via intercom: "You've been idle for Xs. Are you stuck?
  │ Respond or you'll be terminated in escalationGraceMs."
  │ Emit control event: { type: "needs_attention", reason: "step_inactivity_timeout" }
  ▼ (escalationGraceMs passes with no response)
Step activityState → "timed_out"
  │ SIGTERM child process
  │ Wait 5s, SIGKILL if still alive
  │ Mark step as "failed" with error "Timed out: no activity for Xs (step inactivity timeout)"
  │ Emit control event: { type: "timeout_killed" }
  ▼
Continue to next step (chain) or aggregate results (parallel)
```

#### `timeoutAction: "auto_kill"`

Same as above but skip the escalation phase — go straight to SIGTERM on timeout.

#### `timeoutAction: "notify"`

Current behavior — just emit the control event, don't kill.

#### Run wall-clock timeout

Checks `Date.now() - overallStartTime >= runWallClockTimeoutMs`. When it fires, it kills *all* running steps and marks the entire run failed. This fires regardless of per-step activity — it's a hard ceiling on total run time.

#### Kill mechanism

The kill signal goes through the existing `activeChildInterrupt` callback (already used by `interruptRunner`). This is the same path as manual `subagent({ action: "interrupt" })`. The child process receives SIGTERM, then SIGKILL after 5s if still alive.

### New ActivityState Values

Current: `"active_long_running" | "needs_attention"`

Add: `"timed_out_escalating" | "timed_out"`

Full union: `"active_long_running" | "needs_attention" | "timed_out_escalating" | "timed_out"`

### New ControlEvent.reason Values

Add: `"step_inactivity_timeout" | "run_wall_clock_timeout" | "timeout_killed"`

These are distinct from existing `"idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold"`.

### Config Hierarchy (highest priority wins)

1. **Per-invocation** — `subagent` tool `control` parameter:
   ```typescript
   subagent({
     agent: "worker",
     task: "...",
     control: {
       stepInactivityTimeoutMs: 180_000,  // 3 min for this run
       runWallClockTimeoutMs: 600_000,     // 10 min overall
       timeoutAction: "escalate_then_kill",
     }
   })
   ```

2. **Project/user settings** — `settings.json` `subagents.control`:
   ```json
   {
     "subagents": {
       "control": {
         "stepInactivityTimeoutMs": 300000,
         "timeoutAction": "escalate_then_kill"
       }
     }
   }
   ```

3. **Defaults** — `DEFAULT_CONTROL_CONFIG`:
   ```typescript
   stepInactivityTimeoutMs: 300_000,
   runWallClockTimeoutMs: 1_800_000,
   timeoutAction: "escalate_then_kill",
   escalationGraceMs: 30_000,
   ```

The `resolveControlConfig()` function already merges global → override. Extend it with the new fields.

### Foreground vs Async Parity

The timeout logic lives in `runSubagent()`, the shared runner for both foreground and async modes. The `activityTimer` already runs in both. No special casing needed.

- **Foreground sync runs:** When a step times out and is killed, the child process exits. `runSingleStep()` returns with `exitCode: null` and `interrupted: true`. The chain/parallel flow continues to the next step naturally.

- **Async/background runs:** Same kill path. `status.json` and `events.jsonl` are updated before the kill. If the orchestrator process is alive, it sees the `timeout_killed` event. If not, the stale-run reconciler still handles the dead-PID case.

### Step Result on Timeout

Killed steps are marked:
- `status: "failed"`
- `activityState: "timed_out"`
- `error: "Timed out: no activity for ${elapsedSeconds}s (step inactivity timeout)"`
- `exitCode: 1`

Run-level timeouts mark all running steps the same way with `error: "Timed out: run exceeded ${runWallClockSeconds}s wall-clock limit"`.

### Implementation Points

Files to modify:

1. **`src/shared/types.ts`** — Add new fields to `ControlConfig`, `ResolvedControlConfig`, `ActivityState`, `ControlEvent.reason`
2. **`src/runs/shared/subagent-control.ts`** — Extend `DEFAULT_CONTROL_CONFIG`, `resolveControlConfig()`, `deriveActivityState()`, add timeout enforcement logic, add `formatControlNoticeMessage` branches for timeout events
3. **`src/runs/shared/long-running-guard.ts`** — Add `nextStepTimeoutTrigger()` and `nextRunTimeoutTrigger()` functions
4. **`src/runs/background/subagent-runner.ts`** — Extend `activityTimer` callback to check timeout thresholds and execute kill via `activeChildInterrupt`; add per-step escalation tracking state
5. **`src/extension/index.ts`** — Extend `subagent` tool schema with new `control` fields

### Test Strategy

- **Unit tests** for `resolveControlConfig` with new fields
- **Unit tests** for `deriveActivityState` with timeout states
- **Unit tests** for the timeout enforcement logic (mock `activeChildInterrupt`, verify SIGTERM/SIGKILL sequence)
- **Unit tests** for step state transitions: `running` → `timed_out_escalating` → `timed_out` → `failed`
- **Unit tests** for run wall-clock timeout
- **Integration tests**: verify that a killed step's result is properly recorded in `status.json` and `events.jsonl`

### Backwards Compatibility

The default `timeoutAction: "escalate_then_kill"` is a **behavior change** — subagents that were truly idle for 5min will now get killed instead of sitting indefinitely. This is the intended effect. Users who prefer the old behavior can set `timeoutAction: "notify"`.

The new `ActivityState` values and `ControlEvent.reason` values are additive — existing consumers that don't handle them will simply ignore them (they're string unions).

### Risks

| Risk | Mitigation |
|------|------------|
| False positives: active subagent with slow tool calls killed prematurely | `stepInactivityTimeoutMs` (5min) is generous. Output file mtime also counts as activity. |
| SIGTERM not caught by pi child | 5s grace then SIGKILL. Pi's signal handlers forward SIGTERM to child processes. |
| Escalation nudge not delivered (no intercom target) | If no intercom target, skip nudge and go straight to kill after grace period. |
| Run wall-clock timeout kills a step that's about to complete | Configurable. Users can set high values or disable per-invocation. |
| Nested subagents: parent kills child, child's own subagents orphaned | Pi's SIGTERM handler propagates to child processes. Orphan risk is the same as manual interrupt. |
