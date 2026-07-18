# Live run handles

**Milestone:** M12
**Status:** strategic candidate; not authorized for implementation

## Goal

Give a parent a stable handle for a running or completed child so it can inspect, attach, steer or queue a follow-up, detach, and abort without replacing the existing async runner or sacrificing process isolation.

## First step: bounded transport spike

Prototype a delta-native duplex child transport before selecting the public API. The spike must prove that parent-to-child messages can arrive during a live turn and that child-to-parent updates do not inherit Pi's full-snapshot stream amplification.

Evaluate the smallest viable transport in this order:

1. reuse the existing intercom/event route when it can deliver a live user message safely;
2. add a bounded sidecar IPC channel owned by the child process;
3. keep a clearly documented fallback where steering is queued for the next turn rather than pretending it was injected live.

Do not replace child `pi` processes with in-process sessions.

## Candidate product surface

- Stable run handles that survive the parent losing its in-memory tracker when durable run state still exists.
- Attach to a running background child and watch compact delta output.
- Send a steering message or request an orderly wrap-up.
- Queue a follow-up when live injection is unavailable or unsafe.
- Detach without interrupting the child.
- Abort through the existing bounded interrupt/escalation path.
- View a completed or running transcript with auto-follow and pause-on-scroll.
- Show compact always-visible status: agent, elapsed time, activity freshness, and attention state.

## Related backlog, not committed scope

- Pending-work-aware parent/chain completion semantics.
- Stable lifecycle events on `pi.events`.
- Versioned cross-extension RPC after lifecycle event envelopes exist.
- Awaiting-input indicators and terminal-title integration.

These may become separate outcomes only after the transport spike proves the ownership boundary.

## Constraints

- Preserve separate-process crash isolation.
- Do not treat full serialized message snapshots as deltas.
- Maintain explicit run ownership and safe run-id resolution.
- Never claim a message was delivered live unless the child acknowledged it.
- Attach/detach must not change completion or cleanup semantics.
- Existing status, interrupt, resume, nested-run, and intercom paths remain backward compatible.

## Open decisions

- Whether live input is delivered through Pi session APIs, intercom, or dedicated IPC.
- Ordering and idempotency for concurrent steering and queued follow-ups.
- How a child receives a new user message while a model turn is active.
- Whether transcript viewing is part of attach or a separate read-only overlay.
- Which pending-work states should block parent completion.

## Evidence required before implementation planning

- A transport spike with measured stream volume and no snapshot amplification.
- A lifecycle diagram covering parent restart, child exit, detach, and abort races.
- A rollback path that leaves the current async/status/control APIs intact.
- A focused spec/grill pass before creating M12 outcomes in root `PLAN.md`.
