/**
 * Integration test for async (background) dynamic fanout (expand/collect).
 *
 * v0.40.0 lifted the "foreground only" restriction: a background chain may now contain a
 * dynamic-fanout step. The background runner materializes the per-item tasks at runtime from a
 * prior step's structured output, splices runtime flat-index slots, runs them through the
 * standard parallel executor, and collects the results into {outputs.<as>} for downstream steps.
 *
 * Drives the real detached runner via the mock `pi` child (PATH interception + response queue),
 * so it exercises the full spawn → materialize → collect → downstream path. Skips when jiti is
 * unavailable (same gate as the rest of the async integration suite).
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockPi, createTempDir, makeAgent, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncChain(id: string, params: Record<string, unknown>): { content: Array<{ text?: string }>; isError?: boolean; details: { asyncId?: string; asyncDir?: string } };
}
interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const available = !!(asyncMod && typesMod);
const isAsyncAvailable = asyncMod?.isAsyncAvailable;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;

const FILES_SCHEMA = {
	type: "object",
	properties: { files: { type: "array", items: { type: "string" } } },
	required: ["files"],
	additionalProperties: false,
};

const artifactConfig = { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 };

async function waitForFile(p: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(p)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for ${p}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function findCallWith(dir: string, ...needles: string[]): string | undefined {
	for (const name of fs.readdirSync(dir)) {
		if (!name.startsWith("call-")) continue;
		const args = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")).args as string[];
		const last = args.at(-1) ?? "";
		if (needles.every((n) => last.includes(n))) return last;
	}
	return undefined;
}

describe("async dynamic fanout", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	it(
		"expands a prior step's structured array, collects results, and feeds {outputs} downstream",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			// step 0 produces a structured array; the two fanned items and the consumer follow.
			mockPi!.onCall({ structured: { files: ["alpha.ts", "beta.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "reviewed two" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));

			assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);
			assert.equal(payload.mode, "chain");
			// producer + 2 fanned items + consumer
			assert.equal(payload.results.length, 4);

			// The consumer step received the collected array via {outputs.results}: both item values
			// are present in the JSON that was substituted into its task.
			const consumerTask = findCallWith(mockPi!.dir, "alpha.ts", "beta.ts");
			assert.ok(consumerTask, "consumer task should contain the collected fanout results");
			assert.match(consumerTask, /"agent":"reviewer"/);

			// Runtime slots were spliced: 4 flat steps and a materialized parallel group of 2.
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.equal(status.steps.length, 4);
			assert.ok(
				(status.parallelGroups ?? []).some((g: { count: number }) => g.count === 2),
				"status should record the materialized fanout group",
			);

			const eventsText = fs.readFileSync(path.join(ASYNC_DIR!, id, "events.jsonl"), "utf-8");
			assert.match(eventsText, /"type":"subagent\.fanout\.materialized"/);
		},
	);

	it(
		"namespaces inherited default outputs for materialized fanout items",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["alpha.ts", "beta.ts"] }, output: "listed files" });
			// Keyed to the per-item task text: materialized fanout children run concurrently,
			// so an unkeyed queue swaps these two responses between parallel-1/0 and parallel-1/1.
			mockPi!.onCall({ taskIncludes: "Review file alpha.ts", output: "fallback alpha", writeOutput: "child alpha" });
			mockPi!.onCall({ taskIncludes: "Review file beta.ts", output: "fallback beta", writeOutput: "child beta" });

			const id = `async-fanout-output-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
				],
				agents: [makeAgent("recon"), makeAgent("reviewer", { output: "context.md" })],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);

			const firstOutput = path.join(tempDir, "parallel-1", "0-reviewer", "context.md");
			const secondOutput = path.join(tempDir, "parallel-1", "1-reviewer", "context.md");
			assert.equal(fs.readFileSync(firstOutput, "utf-8"), "child alpha");
			assert.equal(fs.readFileSync(secondOutput, "utf-8"), "child beta");
		},
	);

	it(
		"skips an empty source array (onEmpty: skip) and continues the chain",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: [] }, output: "no files" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-empty-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));

			assert.equal(payload.success, true, `run should succeed: ${JSON.stringify(payload.results)}`);
			// producer + consumer only; no items materialized
			assert.equal(payload.results.length, 2);
			// The consumer saw an empty collected array.
			const consumerTask = findCallWith(mockPi!.dir, "[]");
			assert.ok(consumerTask, "consumer task should contain the empty collected array");

			// The fanout still ran (with zero items), so consumers relying on the event as the
			// fanout marker must still observe it with count 0.
			const events = fs
				.readFileSync(path.join(ASYNC_DIR!, id, "events.jsonl"), "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const materialized = events.find((e) => e.type === "subagent.fanout.materialized");
			assert.ok(materialized, "onEmpty:skip should still emit subagent.fanout.materialized");
			assert.equal(materialized.count, 0, "empty-source fanout should report count 0");
		},
	);


	it(
		"labels a dynamic fanout as the same logical step it replaces",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["a.ts", "b.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "reviewed two" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-logical-label-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true);

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.equal(status.chainStepCount, 3, "chainStepCount should stay the original logical length");
			assert.equal(status.steps.length, 4, "flat steps = producer + 2 materialized + consumer");
			assert.equal(status.parallelGroups.length, 1, "fanout should be recorded as one group");
			assert.equal(status.parallelGroups[0].count, 2);
			assert.equal(status.parallelGroups[0].start, 1);
			assert.equal(status.parallelGroups[0].stepIndex, 1, "fanout should occupy the dynamic step's logical slot, not the following slot");
		},
	);

	it(
		"records a final dynamic fanout as a valid parallel group instead of dropping it",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["a.ts", "b.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "reviewed two" });

			const id = `async-fanout-final-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
				],
				agents: [makeAgent("recon"), makeAgent("reviewer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true);

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.equal(status.chainStepCount, 2, "original logical length is preserved");
			assert.equal(status.steps.length, 3, "flat steps = producer + 2 materialized");
			assert.equal(status.parallelGroups.length, 1, "final fanout group should not be dropped by normalizeParallelGroups");
			assert.equal(status.parallelGroups[0].count, 2);
			assert.equal(status.parallelGroups[0].start, 1);
			assert.equal(status.parallelGroups[0].stepIndex, 1, "final fanout group stepIndex should be the dynamic step's logical slot");
		},
	);

	it(
		"bumps the start of a trailing static parallel group after a dynamic fanout splice",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["a.ts", "b.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "reviewed two" });
			mockPi!.onCall({ output: "static one" });
			mockPi!.onCall({ output: "static two" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-trailing-static-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{
						parallel: [
							{ agent: "worker-a", task: "Static task A" },
							{ agent: "worker-b", task: "Static task B" },
						],
					},
					{ agent: "planner", task: "Summarize" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("worker-a"), makeAgent("worker-b"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true);

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.equal(status.chainStepCount, 4, "original logical length is preserved");
			assert.equal(status.steps.length, 6, "flat steps = producer + 2 fanout + 2 static + consumer");
			assert.equal(status.parallelGroups.length, 2, `fanout and trailing static groups both recorded: ${JSON.stringify(status.parallelGroups)}`);
			const fanoutGroup = status.parallelGroups.find((g: { count: number }) => g.count === 2 && g.start === 1);
			const staticGroup = status.parallelGroups.find((g: { count: number }) => g.count === 2 && g.start === 3);
			assert.ok(fanoutGroup, "fanout group should start at flatIndex 1");
			assert.ok(staticGroup, "trailing static group should be bumped from 1 to 3 to account for 2 materialized slots");
			assert.equal(staticGroup.stepIndex, 2, "trailing static group keeps its original logical step index");
		},
	);

	it(
		"suppresses progress instructions for per-item read-only tasks",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["a.ts", "b.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "reviewed two" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-readonly-progress-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review-only file {file}: do not edit files. Return findings." },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true);

			for (const name of fs.readdirSync(mockPi!.dir)) {
				if (!name.startsWith("call-")) continue;
				const args = JSON.parse(fs.readFileSync(path.join(mockPi!.dir, name), "utf-8")).args as string[];
				const task = args.at(-1) ?? "";
				if (task.includes("Review-only file")) {
					assert.doesNotMatch(task, /progress at:/, "read-only per-item task should not include progress instructions");
				}
			}
		},
	);

	function writeLaneSettings(cwd: string, value: unknown): void {
		const piDir = path.join(cwd, ".pi");
		fs.mkdirSync(piDir, { recursive: true });
		fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify(value), "utf-8");
	}

	it(
		"resolves parallel.lane to concrete model and thinking for dynamic fanout",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			writeLaneSettings(tempDir, {
				subagents: {
					modelLanes: {
						reviewer: {
							fast: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
						},
					},
				},
			});

			mockPi!.onCall({ structured: { files: ["a.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-lane-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}", lane: "fast" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, true);

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			const fanoutStep = status.steps[1];
			assert.equal(fanoutStep.model, "deepseek/deepseek-v4-flash:high", "lane should resolve the model+thinking on the materialized template");
		},
	);

	it(
		"reports a non-empty status error when the source array is empty and onEmpty is fail",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: [] }, output: "no files" });

			const id = `async-fanout-empty-fail-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10, onEmpty: "fail" },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("recon"), makeAgent("reviewer"), makeAgent("planner")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, false, "run should fail with onEmpty: fail");

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.ok(status.error, "status.error should be set for a failed materialization");
			assert.match(status.error, /source array is empty/);
		},
	);

	it(
		"reports a non-empty status error when collect outputSchema validation fails",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: ["a.ts"] }, output: "listed files" });
			mockPi!.onCall({ output: "reviewed one" });

			const id = `async-fanout-schema-fail-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "recon", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: {
							as: "results",
							outputSchema: {
								type: "object",
								properties: { requiredField: { type: "string" } },
								required: ["requiredField"],
								additionalProperties: false,
							},
						},
					},
				],
				agents: [makeAgent("recon"), makeAgent("reviewer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig,
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
			await waitForFile(resultPath);
			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(payload.success, false, "run should fail with schema mismatch");

			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR!, id, "status.json"), "utf-8"));
			assert.ok(status.error, "status.error should be set for a failed collect validation");
			assert.match(status.error, /Collected output validation failed/);
		},
	);
});
