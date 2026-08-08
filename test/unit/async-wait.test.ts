import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_ASYNC_WAIT_TIMEOUT_MS,
	MAX_ASYNC_WAIT_TIMEOUT_MS,
	formatAsyncWaitResult,
	waitForAsyncRuns,
	type AsyncWaitDeps,
} from "../../src/runs/background/async-wait.ts";
import type { AsyncJobState, AsyncStatus } from "../../src/shared/types.ts";

function job(asyncId: string, status: AsyncJobState["status"] = "running"): AsyncJobState {
	return { asyncId, asyncDir: `/tmp/${asyncId}`, status };
}

function status(state: AsyncStatus["state"], extra: Partial<AsyncStatus> = {}): AsyncStatus {
	return { runId: "run", mode: "single", state, startedAt: 0, ...extra };
}

/**
 * Fake clock and fake status files. `onTick` runs on every simulated sleep, which is how a test
 * flips a run to a terminal state "while" the wait is blocked — no timers, no files, no children.
 */
function makeDeps(options: {
	jobs: AsyncJobState[];
	statuses?: Record<string, AsyncStatus | null>;
	onTick?: (elapsed: number, statuses: Record<string, AsyncStatus | null>) => void;
	signal?: { aborted: boolean };
}): AsyncWaitDeps & { elapsed: () => number; sleeps: () => number } {
	const statuses = options.statuses ?? {};
	let now = 1_000;
	let sleeps = 0;
	const started = now;
	return {
		listJobs: () => options.jobs,
		readStatus: (asyncDir: string) => statuses[asyncDir] ?? null,
		now: () => now,
		sleep: async (ms: number) => {
			sleeps += 1;
			now += ms;
			options.onTick?.(now - started, statuses);
		},
		...(options.signal ? { signal: options.signal } : {}),
		elapsed: () => now - started,
		sleeps: () => sleeps,
	};
}

describe("waitForAsyncRuns", () => {
	it("reports nothing to wait for when no run is tracked", async () => {
		const result = await waitForAsyncRuns({}, makeDeps({ jobs: [] }));
		assert.equal(result.reason, "nothing-to-wait-for");
		assert.deepEqual(result.settled, []);
		assert.deepEqual(result.pending, []);
	});

	it("reports nothing to wait for when the requested id is not tracked", async () => {
		const result = await waitForAsyncRuns({ id: "missing" }, makeDeps({ jobs: [job("run-a")] }));
		assert.equal(result.reason, "nothing-to-wait-for");
	});

	it("returns immediately when a run has already finished", async () => {
		const deps = makeDeps({ jobs: [job("run-a")], statuses: { "/tmp/run-a": status("complete") } });
		const result = await waitForAsyncRuns({}, deps);

		assert.equal(result.reason, "settled");
		assert.equal(result.settled.length, 1);
		assert.equal(result.settled[0]?.asyncId, "run-a");
		assert.equal(deps.sleeps(), 0);
	});

	it("prefers status.json over the in-memory job projection", async () => {
		// The session still believes the run is going; its own status file says otherwise.
		const deps = makeDeps({ jobs: [job("run-a", "running")], statuses: { "/tmp/run-a": status("failed") } });
		const result = await waitForAsyncRuns({}, deps);

		assert.equal(result.reason, "settled");
		assert.equal(result.settled[0]?.state, "failed");
	});

	it("returns as soon as the first of several runs settles", async () => {
		const deps = makeDeps({
			jobs: [job("run-a"), job("run-b")],
			statuses: { "/tmp/run-a": status("running"), "/tmp/run-b": status("running") },
			onTick: (elapsed, statuses) => {
				if (elapsed >= 1_000) statuses["/tmp/run-b"] = status("complete");
			},
		});

		const result = await waitForAsyncRuns({ pollMs: 500 }, deps);

		assert.equal(result.reason, "settled");
		assert.deepEqual(result.settled.map((observation) => observation.asyncId), ["run-b"]);
		assert.deepEqual(result.pending.map((observation) => observation.asyncId), ["run-a"]);
	});

	it("drains every run when all is set", async () => {
		const deps = makeDeps({
			jobs: [job("run-a"), job("run-b")],
			statuses: { "/tmp/run-a": status("running"), "/tmp/run-b": status("running") },
			onTick: (elapsed, statuses) => {
				if (elapsed >= 500) statuses["/tmp/run-b"] = status("complete");
				if (elapsed >= 1_500) statuses["/tmp/run-a"] = status("complete");
			},
		});

		const result = await waitForAsyncRuns({ all: true, pollMs: 500 }, deps);

		assert.equal(result.reason, "settled");
		assert.equal(result.pending.length, 0);
		assert.deepEqual(result.settled.map((observation) => observation.asyncId).sort(), ["run-a", "run-b"]);
	});

	it("treats needs_attention as settled and says so", async () => {
		const deps = makeDeps({
			jobs: [job("run-a")],
			statuses: { "/tmp/run-a": status("running", { activityState: "needs_attention" }) },
		});

		const result = await waitForAsyncRuns({}, deps);

		assert.equal(result.reason, "needs-attention");
		assert.equal(result.settled[0]?.needsAttention, true);
		assert.equal(result.settled[0]?.state, "running");
	});

	it("times out honestly without interrupting the run", async () => {
		const deps = makeDeps({ jobs: [job("run-a")], statuses: { "/tmp/run-a": status("running") } });

		const result = await waitForAsyncRuns({ timeoutMs: 2_000, pollMs: 500 }, deps);

		assert.equal(result.reason, "timeout");
		assert.equal(result.settled.length, 0);
		assert.equal(result.pending[0]?.asyncId, "run-a");
		assert.ok(deps.elapsed() >= 2_000);
		// The run is untouched: still exactly as the fake status file left it.
		assert.equal(deps.readStatus("/tmp/run-a")?.state, "running");
	});

	it("returns aborted as soon as the signal is set", async () => {
		const signal = { aborted: false };
		const deps = makeDeps({
			jobs: [job("run-a")],
			statuses: { "/tmp/run-a": status("running") },
			signal,
			onTick: () => {
				signal.aborted = true;
			},
		});

		const result = await waitForAsyncRuns({ timeoutMs: 60_000, pollMs: 500 }, deps);

		assert.equal(result.reason, "aborted");
		assert.equal(result.pending[0]?.asyncId, "run-a");
	});

	it("clamps an absent, zero, or oversized timeout", async () => {
		const overLimit = makeDeps({ jobs: [job("run-a")], statuses: { "/tmp/run-a": status("running") } });
		const clamped = await waitForAsyncRuns({ timeoutMs: MAX_ASYNC_WAIT_TIMEOUT_MS * 10, pollMs: 100_000 }, overLimit);
		assert.equal(clamped.reason, "timeout");
		assert.ok(overLimit.elapsed() >= MAX_ASYNC_WAIT_TIMEOUT_MS);
		assert.ok(overLimit.elapsed() < MAX_ASYNC_WAIT_TIMEOUT_MS * 2);

		const zero = makeDeps({ jobs: [job("run-a")], statuses: { "/tmp/run-a": status("running") } });
		await waitForAsyncRuns({ timeoutMs: 0, pollMs: 100_000 }, zero);
		assert.ok(zero.elapsed() >= DEFAULT_ASYNC_WAIT_TIMEOUT_MS);
	});
});

describe("formatAsyncWaitResult", () => {
	it("never claims to carry child output", () => {
		const text = formatAsyncWaitResult({
			reason: "settled",
			waitedMs: 2_500,
			settled: [{ asyncId: "run-a", state: "complete", agents: ["worker"], needsAttention: false, settled: true }],
			pending: [],
		});

		assert.match(text, /Finished waiting after 2\.5s/);
		assert.match(text, /run-a: complete \| agents: worker/);
		assert.match(text, /this tool only waits, it never returns child output/);
	});

	it("says a timeout left the runs alone", () => {
		const text = formatAsyncWaitResult({
			reason: "timeout",
			waitedMs: 1_000,
			settled: [],
			pending: [{ asyncId: "run-a", state: "running", needsAttention: false, settled: false }],
		});

		assert.match(text, /still going and were not interrupted/);
		assert.match(text, /Still running:/);
	});

	it("explains the empty case instead of returning a bare list", () => {
		const text = formatAsyncWaitResult({ reason: "nothing-to-wait-for", waitedMs: 0, settled: [], pending: [] });
		assert.match(text, /No async subagent runs are being tracked/);
	});
});
