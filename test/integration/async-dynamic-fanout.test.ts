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
					{ agent: "context-builder", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10 },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("context-builder"), makeAgent("reviewer"), makeAgent("planner")],
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
		"skips an empty source array (onEmpty: skip) and continues the chain",
		{ skip: !isAsyncAvailable?.() ? "jiti not available" : undefined },
		async () => {
			mockPi!.onCall({ structured: { files: [] }, output: "no files" });
			mockPi!.onCall({ output: "final summary" });

			const id = `async-fanout-empty-${Date.now().toString(36)}`;
			executeAsyncChain!(id, {
				chain: [
					{ agent: "context-builder", task: "List the files", as: "plan", outputSchema: FILES_SCHEMA },
					{
						expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 10, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review file {file}" },
						collect: { as: "results" },
					},
					{ agent: "planner", task: "Summarize {outputs.results}" },
				],
				agents: [makeAgent("context-builder"), makeAgent("reviewer"), makeAgent("planner")],
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
		},
	);
});
