import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForkContextResolver, createSubagentContextResolver, resolveSubagentContext } from "../../src/shared/fork-context.ts";

describe("resolveSubagentContext", () => {
	it("defaults to fresh", () => {
		assert.equal(resolveSubagentContext(undefined), "fresh");
		assert.equal(resolveSubagentContext("anything"), "fresh");
	});

	it("accepts fork", () => {
		assert.equal(resolveSubagentContext("fork"), "fork");
	});

	it("accepts lineage", () => {
		assert.equal(resolveSubagentContext("lineage"), "lineage");
	});
});

describe("createForkContextResolver", () => {
	it("fresh mode never calls createBranchedSession", () => {
		let calls = 0;
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-123",
			constructor: {
				open: () => ({
					createBranchedSession: () => {
						calls++;
						return "/tmp/child.jsonl";
					},
				}),
			},
		}, "fresh");

		assert.equal(resolver.sessionFileForIndex(0), undefined);
		assert.equal(calls, 0);
	});

	it("fails fast when parent session file is missing", () => {
		assert.throws(
			() => createForkContextResolver({
				getSessionFile: () => undefined,
				getLeafId: () => "leaf-123",
				constructor: { open: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) },
			}, "fork"),
			/Forked subagent context requires a persisted parent session\./,
		);
	});

	it("lineage fails fast when parent session file is missing", () => {
		assert.throws(
			() => createSubagentContextResolver({
				getSessionFile: () => undefined,
				getLeafId: () => "leaf-123",
				constructor: {
					open: () => ({ createBranchedSession: () => "/tmp/fork.jsonl" }),
					create: () => ({ getSessionFile: () => "/tmp/lineage.jsonl" }),
				},
			}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` }),
			/Lineage subagent context requires a persisted parent session\./,
		);
	});

	it("lineage fails fast when session directory options are missing", () => {
		assert.throws(
			() => createSubagentContextResolver({
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => "leaf-123",
				constructor: {
					open: () => ({ createBranchedSession: () => "/tmp/fork.jsonl" }),
					create: () => ({ getSessionFile: () => "/tmp/lineage.jsonl" }),
				},
			}, "lineage"),
			/Lineage subagent context requires session directory options\./,
		);
	});

	it("fails fast when leaf id is missing", () => {
		assert.throws(
			() => createForkContextResolver({
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => null,
				constructor: { open: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) },
			}, "fork"),
			/Forked subagent context requires a current leaf to fork from\./,
		);
	});

	it("opens a throwaway manager from the persisted parent session file", () => {
		const openedPaths: string[] = [];
		const seenLeafIds: string[] = [];
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-xyz",
			createBranchedSession: () => {
				throw new Error("live manager should not branch");
			},
			constructor: {
				open: (sessionFile: string) => {
					openedPaths.push(sessionFile);
					return {
						createBranchedSession: (leafId: string) => {
							seenLeafIds.push(leafId);
							return `/tmp/child-${seenLeafIds.length}.jsonl`;
						},
					};
				},
			},
		}, "fork");

		resolver.sessionFileForIndex(0);
		resolver.sessionFileForIndex(1);
		resolver.sessionFileForIndex(2);

		assert.deepEqual(openedPaths, ["/tmp/parent.jsonl", "/tmp/parent.jsonl", "/tmp/parent.jsonl"]);
		assert.deepEqual(seenLeafIds, ["leaf-xyz", "leaf-xyz", "leaf-xyz"]);
	});

	it("creates isolated branched sessions per index (parallel and chain compatible)", () => {
		let count = 0;
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: {
				open: () => ({
					createBranchedSession: () => {
						count++;
						return `/tmp/fork-${count}.jsonl`;
					},
				}),
			},
		}, "fork");

		const singleSession = resolver.sessionFileForIndex(0);
		const parallelSessions = [resolver.sessionFileForIndex(1), resolver.sessionFileForIndex(2)];
		const chainSessions = [resolver.sessionFileForIndex(3), resolver.sessionFileForIndex(4)];

		assert.equal(singleSession, "/tmp/fork-1.jsonl");
		assert.deepEqual(parallelSessions, ["/tmp/fork-2.jsonl", "/tmp/fork-3.jsonl"]);
		assert.deepEqual(chainSessions, ["/tmp/fork-4.jsonl", "/tmp/fork-5.jsonl"]);
		assert.equal(count, 5);
	});

	it("memoizes per index to keep behavior deterministic", () => {
		let calls = 0;
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: {
				open: () => ({
					createBranchedSession: () => {
						calls++;
						return `/tmp/fork-${calls}.jsonl`;
					},
				}),
			},
		}, "fork");

		const first = resolver.sessionFileForIndex(7);
		const second = resolver.sessionFileForIndex(7);
		assert.equal(first, second);
		assert.equal(calls, 1);
	});

	it("lineage creates blank child sessions with parentSession without branching", () => {
		const creates: Array<{ cwd: string; sessionDir?: string; parentSession?: string }> = [];
		let branchCalls = 0;
		const resolver = createSubagentContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-123",
			constructor: {
				open: () => ({
					createBranchedSession: () => {
						branchCalls++;
						return "/tmp/fork.jsonl";
					},
				}),
				create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => {
					creates.push({ cwd, sessionDir, parentSession: options?.parentSession });
					return { getSessionFile: () => `${sessionDir}/lineage.jsonl` };
				},
			},
		}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` });

		assert.equal(resolver.sessionFileForIndex(0), "/tmp/run-0/lineage.jsonl");
		assert.equal(resolver.sessionFileForIndex(1), "/tmp/run-1/lineage.jsonl");
		assert.equal(branchCalls, 0);
		assert.deepEqual(creates, [
			{ cwd: "/repo", sessionDir: "/tmp/run-0", parentSession: "/tmp/parent.jsonl" },
			{ cwd: "/repo", sessionDir: "/tmp/run-1", parentSession: "/tmp/parent.jsonl" },
		]);
	});

	it("lineage memoizes per index", () => {
		let creates = 0;
		const resolver = createSubagentContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-123",
			constructor: {
				open: () => ({ createBranchedSession: () => "/tmp/fork.jsonl" }),
				create: (_cwd: string, sessionDir?: string) => {
					creates++;
					return { getSessionFile: () => `${sessionDir}/lineage-${creates}.jsonl` };
				},
			},
		}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` });

		assert.equal(resolver.sessionFileForIndex(7), "/tmp/run-7/lineage-1.jsonl");
		assert.equal(resolver.sessionFileForIndex(7), "/tmp/run-7/lineage-1.jsonl");
		assert.equal(creates, 1);
	});

	it("does not silently fallback to fresh when branch extraction fails", () => {
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-abc",
			constructor: {
				open: () => ({
					createBranchedSession: () => undefined,
				}),
			},
		}, "fork");

		assert.throws(
			() => resolver.sessionFileForIndex(0),
			/Failed to create forked subagent session: Session manager did not return a session file\./,
		);
	});
});
