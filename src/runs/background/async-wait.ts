/**
 * Parent-side blocking wait for detached async subagent runs (upstream 0.33.0 `wait` parity).
 *
 * Without this, a parent that launched async children has only two options: poll `action: "status"`
 * in a loop, or end its turn and hope a completion notification arrives. Neither works in
 * non-interactive `pi -p` runs or in a skill that launches work and needs the results in the same
 * turn — the process can exit with children still running.
 *
 * The wait reads each run's `status.json` directly rather than trusting the extension's in-memory
 * projection, so it stays correct even if the poller is behind. It is deliberately dependency
 * injected: the whole loop is testable on a fake clock with no timers, files, or child processes.
 */
import type { AsyncJobState, AsyncStatus } from "../../shared/types.ts";

/** Run states that mean the run is over and will not change again on its own. */
export const ASYNC_WAIT_TERMINAL_STATES: readonly string[] = ["complete", "failed", "paused"];

export const DEFAULT_ASYNC_WAIT_TIMEOUT_MS = 600_000;
export const DEFAULT_ASYNC_WAIT_POLL_MS = 500;
/** Upper bound on a single wait, so a wedged child cannot block a parent turn indefinitely. */
export const MAX_ASYNC_WAIT_TIMEOUT_MS = 1_800_000;

export type AsyncWaitReason = "settled" | "needs-attention" | "timeout" | "aborted" | "nothing-to-wait-for";

export interface AsyncWaitObservation {
	asyncId: string;
	state: string;
	agents?: string[];
	/** True when the run is asking for the parent rather than simply working. */
	needsAttention: boolean;
	settled: boolean;
	error?: string;
}

export interface AsyncWaitResult {
	reason: AsyncWaitReason;
	waitedMs: number;
	/** Runs that reached a terminal state or raised needs_attention during the wait. */
	settled: AsyncWaitObservation[];
	/** Runs still working when the wait returned. */
	pending: AsyncWaitObservation[];
}

export interface AsyncWaitInput {
	/** Wait for this run only. Omit to wait on every tracked async run. */
	id?: string;
	/** Wait until every watched run settles instead of returning on the first one. */
	all?: boolean;
	timeoutMs?: number;
	pollMs?: number;
}

export interface AsyncWaitDeps {
	listJobs(): AsyncJobState[];
	readStatus(asyncDir: string): AsyncStatus | null;
	now(): number;
	sleep(ms: number): Promise<void>;
	signal?: { aborted: boolean };
}

function observe(job: AsyncJobState, deps: AsyncWaitDeps): AsyncWaitObservation {
	// status.json is the run's own record; the in-memory job is only this session's projection of it.
	const status = job.asyncDir ? deps.readStatus(job.asyncDir) : null;
	const state = status?.state ?? job.status;
	const needsAttention = (status?.activityState ?? job.activityState) === "needs_attention";
	const agents = status?.steps?.map((step) => step.agent) ?? job.agents;
	// AsyncStatus carries no run-level error; the first failing step is the closest honest summary.
	const error = status?.steps?.find((step) => step.error)?.error;
	return {
		asyncId: job.asyncId,
		state,
		...(agents?.length ? { agents } : {}),
		needsAttention,
		settled: ASYNC_WAIT_TERMINAL_STATES.includes(state) || needsAttention,
		...(error ? { error } : {}),
	};
}

function clampTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_ASYNC_WAIT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_ASYNC_WAIT_TIMEOUT_MS;
	return Math.min(timeoutMs, MAX_ASYNC_WAIT_TIMEOUT_MS);
}

export async function waitForAsyncRuns(input: AsyncWaitInput, deps: AsyncWaitDeps): Promise<AsyncWaitResult> {
	const startedAt = deps.now();
	const timeoutMs = clampTimeout(input.timeoutMs);
	const pollMs = input.pollMs !== undefined && Number.isFinite(input.pollMs) && input.pollMs > 0 ? input.pollMs : DEFAULT_ASYNC_WAIT_POLL_MS;
	const deadline = startedAt + timeoutMs;

	const watched = deps.listJobs().filter((job) => (input.id ? job.asyncId === input.id : true));
	if (watched.length === 0) {
		return { reason: "nothing-to-wait-for", waitedMs: 0, settled: [], pending: [] };
	}
	const watchedIds = new Set(watched.map((job) => job.asyncId));

	for (;;) {
		if (deps.signal?.aborted) {
			const observations = deps.listJobs().filter((job) => watchedIds.has(job.asyncId)).map((job) => observe(job, deps));
			return {
				reason: "aborted",
				waitedMs: deps.now() - startedAt,
				settled: observations.filter((observation) => observation.settled),
				pending: observations.filter((observation) => !observation.settled),
			};
		}

		const observations = deps.listJobs().filter((job) => watchedIds.has(job.asyncId)).map((job) => observe(job, deps));
		const settled = observations.filter((observation) => observation.settled);
		const pending = observations.filter((observation) => !observation.settled);
		// A run that has vanished from tracking (cleaned up mid-wait) must not keep the wait alive.
		const done = input.all === true ? pending.length === 0 : settled.length > 0;
		if (done) {
			return {
				reason: settled.some((observation) => observation.needsAttention) ? "needs-attention" : "settled",
				waitedMs: deps.now() - startedAt,
				settled,
				pending,
			};
		}

		if (deps.now() >= deadline) {
			return { reason: "timeout", waitedMs: deps.now() - startedAt, settled, pending };
		}
		await deps.sleep(Math.min(pollMs, Math.max(1, deadline - deps.now())));
	}
}

function describe(observation: AsyncWaitObservation): string {
	const parts = [`${observation.asyncId}: ${observation.state}`];
	if (observation.agents?.length) parts.push(`agents: ${observation.agents.join(", ")}`);
	if (observation.needsAttention) parts.push("needs attention");
	if (observation.error) parts.push(`error: ${observation.error}`);
	return parts.join(" | ");
}

export function formatAsyncWaitResult(result: AsyncWaitResult): string {
	const seconds = Math.round(result.waitedMs / 100) / 10;
	if (result.reason === "nothing-to-wait-for") {
		return "No async subagent runs are being tracked in this session, so there was nothing to wait for.";
	}
	const lines: string[] = [];
	if (result.reason === "needs-attention") lines.push(`A run needs attention after ${seconds}s. Answer it before waiting again.`);
	else if (result.reason === "settled") lines.push(`Finished waiting after ${seconds}s.`);
	else if (result.reason === "timeout") lines.push(`Wait timed out after ${seconds}s; the runs below are still going and were not interrupted.`);
	else lines.push(`Wait was aborted after ${seconds}s; the runs below were not interrupted.`);

	if (result.settled.length > 0) {
		lines.push("", "Settled:", ...result.settled.map((observation) => `  ${describe(observation)}`));
	}
	if (result.pending.length > 0) {
		lines.push("", "Still running:", ...result.pending.map((observation) => `  ${describe(observation)}`));
	}
	lines.push("", "Read a settled run's output with subagent({ action: \"status\" }); this tool only waits, it never returns child output.");
	return lines.join("\n");
}
