/**
 * Parent-side client for the M12.1 live-control transport (src/runs/shared/nested-events.ts).
 * Submits one bounded steer/follow-up/wrap-up request against a (route, childKey) live-control
 * owner slot and waits (bounded, deterministic-clock-friendly) for a durable acknowledgement,
 * mapping the transport's honest states/dispositions to a human-facing result. Never claims model
 * delivery or compliance — only what the owning Pi session accepted or queued.
 */
import { randomUUID } from "node:crypto";
import {
	deriveLiveControlOutcome,
	readLiveControlOwnerEpoch,
	readLiveControlRequestState,
	submitLiveControlRequest,
	type NestedRoute,
} from "./nested-events.ts";
import type { LiveControlDisposition, LiveControlRequestState } from "../../shared/types.ts";

export type LiveControlToolAction = "steer" | "follow-up" | "wrap-up";

/** Orchestrator-locked (PLAN.md M12.2): wrap-up rides the steer path with a fixed directive, not a dedicated wire-protocol kind. */
export const WRAP_UP_DIRECTIVE =
	"Wrap up now: stop starting new work, finish or safely checkpoint what is currently in progress, and return your final result.";

export interface LiveControlActionResult {
	ok: boolean;
	state: LiveControlRequestState;
	disposition?: LiveControlDisposition;
	message: string;
}

export interface PerformLiveControlActionInput {
	route: NestedRoute;
	childKey: string;
	action: LiveControlToolAction;
	/** Required for 'steer'/'follow-up'; ignored for 'wrap-up' (which always sends WRAP_UP_DIRECTIVE). */
	text?: string;
	requestId?: string;
	/** Bounded wait for a terminal/durable acknowledgement before returning the current (possibly non-terminal) state honestly. */
	waitMs?: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_MS = 3_000;
const DEFAULT_POLL_MS = 100;

function actionLabel(action: LiveControlToolAction): string {
	if (action === "steer") return "Steer";
	if (action === "follow-up") return "Follow-up";
	return "Wrap-up";
}

function dispositionText(disposition: LiveControlDisposition | undefined): string {
	if (disposition === "started-turn") return "the run was idle and started a fresh turn on it";
	if (disposition === "queued-steer") return "queued as a steer after the run's current tool calls";
	if (disposition === "queued-follow-up") return "queued as a follow-up after the run finishes its current turn";
	return "accepted";
}

function messageFor(action: LiveControlToolAction, state: LiveControlRequestState, disposition: LiveControlDisposition | undefined, reason: string | undefined): string {
	const label = actionLabel(action);
	if (state === "accepted-by-pi") {
		return `${label} accepted by the run's Pi session: ${dispositionText(disposition)}. This confirms Pi accepted or queued delivery, not that the model has acted on it.`;
	}
	if (state === "rejected") {
		return reason ? `${label} was rejected by the run's owner: ${reason}` : `${label} was rejected by the run's owner.`;
	}
	if (state === "outcome-unknown") {
		return `${label} delivery was attempted but never acknowledged (the child may have crashed or exited mid-delivery). Outcome is unknown; it was not retried automatically.`;
	}
	return `${label} was submitted but not yet acknowledged within the wait window. It remains queued for the run's owner to pick up.`;
}

export async function performLiveControlAction(input: PerformLiveControlActionInput): Promise<LiveControlActionResult> {
	const mode = input.action === "follow-up" ? "followUp" : "steer";
	const text = input.action === "wrap-up" ? WRAP_UP_DIRECTIVE : input.text;
	if (!text || !text.trim()) {
		return { ok: false, state: "rejected", message: `${actionLabel(input.action)} requires a non-empty message.` };
	}

	const owner = readLiveControlOwnerEpoch(input.route, input.childKey);
	if (!owner || owner.closedAt !== undefined) {
		return {
			ok: false,
			state: "rejected",
			message: "No live control owner is registered for this run; it may not have started its control listener yet, or it has already exited.",
		};
	}

	const requestId = input.requestId ?? randomUUID();
	const record = submitLiveControlRequest(input.route, { childKey: input.childKey, epoch: owner.epoch, mode, text, requestId });

	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
	const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
	const deadline = now() + waitMs;

	let state: LiveControlRequestState = "submitted";
	let disposition: LiveControlDisposition | undefined;
	let reason: string | undefined;
	while (now() < deadline) {
		const result = readLiveControlRequestState(input.route, input.childKey, record.sequence, record.requestId);
		state = deriveLiveControlOutcome(result);
		disposition = result?.disposition;
		reason = result?.message;
		if (state === "accepted-by-pi" || state === "rejected") break;
		if (result?.state === "delivery-attempted") {
			const currentOwner = readLiveControlOwnerEpoch(input.route, input.childKey);
			if (!currentOwner || currentOwner.closedAt !== undefined || currentOwner.epoch !== owner.epoch) break;
		}
		await sleep(pollMs);
	}

	return { ok: state === "accepted-by-pi", state, disposition, message: messageFor(input.action, state, disposition, reason) };
}
