import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	applyUserModelLaneMutations,
	isValidModelLaneName,
	readModelLanesFromSettingsFile,
	resolveModelLane,
	resolveModelLaneOverrides,
} from "../../src/agents/model-lanes.ts";
import type { ModelLanePatch } from "../../src/agents/model-lanes.ts";

let tempHome = "";
let tempProject = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

describe("model lanes", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("parses valid model lane settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
						hard: { thinking: "medium" },
					},
				},
			},
		});

		assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
			worker: {
				easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
				hard: { thinking: "medium" },
			},
		});
	});


	it("accepts max thinking in model lane settings", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						hard: { thinking: "max" },
					},
				},
			},
		});

		assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
			worker: {
				hard: { thinking: "max" },
			},
		});
	});

	it("accepts partial lane entries when resolving a lane", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						hard: { thinking: "medium" },
					},
				},
			},
		});

		const resolved = resolveModelLane(tempProject, "worker", "hard");
		assert.deepEqual(resolved, {
			found: true,
			agentName: "worker",
			laneName: "hard",
			value: { thinking: "medium" },
			scope: "user",
			filePath: settingsPath,
		});
	});

	it("accepts model-only lane entries", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "zai/glm-5.1" },
					},
				},
			},
		});

		const resolved = resolveModelLane(tempProject, "worker", "easy");
		assert.deepEqual(resolved, {
			found: true,
			agentName: "worker",
			laneName: "easy",
			value: { model: "zai/glm-5.1" },
			scope: "user",
			filePath: settingsPath,
		});
	});

	it("treats absent settings files as empty lane config", () => {
		assert.deepEqual(readModelLanesFromSettingsFile(null), {});
		assert.deepEqual(readModelLanesFromSettingsFile(path.join(tempProject, ".pi", "settings.json")), {});
	});

	it("surfaces invalid lane shapes with agent and lane context", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: "deepseek/deepseek-v4-flash",
					},
				},
			},
		});

		assert.throws(
			() => readModelLanesFromSettingsFile(settingsPath),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("worker")
				&& error.message.includes("easy"),
		);
	});

	it("surfaces invalid thinking values with file path and lane context", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { thinking: "ultra" },
					},
				},
			},
		});

		assert.throws(
			() => readModelLanesFromSettingsFile(settingsPath),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("worker")
				&& error.message.includes("easy")
				&& error.message.includes("thinking"),
		);
	});

	it("rejects a blank/whitespace lane model instead of dispatching it as a model name", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "   " },
					},
				},
			},
		});

		assert.throws(
			() => readModelLanesFromSettingsFile(settingsPath),
			(error: unknown) => error instanceof Error
				&& error.message.includes(settingsPath)
				&& error.message.includes("worker")
				&& error.message.includes("easy")
				&& error.message.includes("model"),
		);
	});

	it("surfaces invalid project settings before falling back to user lanes", () => {
		const userSettingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		const projectSettingsPath = path.join(tempProject, ".pi", "settings.json");
		writeJson(userSettingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "zai/glm-5.1" },
					},
				},
			},
		});
		writeJson(projectSettingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { thinking: "ultra" },
					},
				},
			},
		});

		assert.throws(
			() => resolveModelLane(tempProject, "worker", "easy"),
			(error: unknown) => error instanceof Error
				&& error.message.includes(projectSettingsPath)
				&& error.message.includes("worker")
				&& error.message.includes("easy")
				&& error.message.includes("thinking"),
		);
	});

	it("prefers project lane definitions over user definitions for the same agent and lane", () => {
		const userSettingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		const projectSettingsPath = path.join(tempProject, ".pi", "settings.json");
		writeJson(userSettingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
						medium: { model: "zai/glm-5.1" },
					},
				},
			},
		});
		writeJson(projectSettingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { thinking: "low" },
					},
				},
			},
		});

		assert.deepEqual(resolveModelLane(tempProject, "worker", "easy"), {
			found: true,
			agentName: "worker",
			laneName: "easy",
			value: { thinking: "low" },
			scope: "project",
			filePath: projectSettingsPath,
		});
		assert.deepEqual(resolveModelLane(tempProject, "worker", "medium"), {
			found: true,
			agentName: "worker",
			laneName: "medium",
			value: { model: "zai/glm-5.1" },
			scope: "user",
			filePath: userSettingsPath,
		});

	});


	it("falls back to user lanes when project settings are absent", () => {
		const userSettingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(userSettingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "zai/glm-5.1" },
					},
				},
			},
		});

		assert.deepEqual(resolveModelLane(tempProject, "worker", "easy"), {
			found: true,
			agentName: "worker",
			laneName: "easy",
			value: { model: "zai/glm-5.1" },
			scope: "user",
			filePath: userSettingsPath,
		});
	});

	it("returns a safe missing result for unknown lanes", () => {
		const resolved = resolveModelLane(tempProject, "worker", "missing");
		assert.deepEqual(resolved, {
			found: false,
			agentName: "worker",
			laneName: "missing",
			error: "No model lane 'missing' configured for agent 'worker'.",
		});
	});


	it("keeps empty lane entries explicit", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						empty: {},
					},
				},
			},
		});

		assert.deepEqual(resolveModelLane(tempProject, "worker", "empty"), {
			found: true,
			agentName: "worker",
			laneName: "empty",
			value: {},
			scope: "user",
			filePath: settingsPath,
		});
	});

	it("resolves lane-provided model and thinking into dispatch overrides", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
					},
				},
			},
		});

		assert.deepEqual(resolveModelLaneOverrides(tempProject, {
			agentName: "worker",
			laneName: "easy",
		}), {
			model: "deepseek/deepseek-v4-flash",
			thinking: "high",
		});
	});

	it("keeps inline model while inheriting lane thinking when model overrides the lane", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { model: "deepseek/deepseek-v4-flash", thinking: "high" },
					},
				},
			},
		});

		assert.deepEqual(resolveModelLaneOverrides(tempProject, {
			agentName: "worker",
			laneName: "easy",
			model: "override/model",
		}), {
			model: "override/model",
			thinking: "high",
		});
	});

	it("treats inline thinking off as explicit over lane thinking", () => {
		const settingsPath = path.join(tempHome, ".pi", "agent", "settings.json");
		writeJson(settingsPath, {
			subagents: {
				modelLanes: {
					worker: {
						easy: { thinking: "high" },
					},
				},
			},
		});

		assert.deepEqual(resolveModelLaneOverrides(tempProject, {
			agentName: "worker",
			laneName: "easy",
			thinking: "off",
		}), {
			thinking: "off",
		});
	});

	it("throws a clear error for unknown requested lanes", () => {
		assert.throws(
			() => resolveModelLaneOverrides(tempProject, {
				agentName: "worker",
				laneName: "missing",
			}),
			/Unknown model lane 'missing' for agent 'worker'\./,
		);
	});

	describe("user lane mutations", () => {
		function userSettingsPath(): string {
			return path.join(tempHome, ".pi", "agent", "settings.json");
		}

		function readRaw(filePath: string): string {
			return fs.readFileSync(filePath, "utf-8");
		}

		function readSettings(filePath: string): Record<string, unknown> {
			const parsed: unknown = JSON.parse(readRaw(filePath));
			assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
			return parsed as Record<string, unknown>;
		}

		function writeRaw(filePath: string, content: string): void {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, content, "utf-8");
		}

		it("validates managed lane names without applying the rule to reads", () => {
			assert.equal(isValidModelLaneName("normal"), true);
			assert.equal(isValidModelLaneName("gpu-heavy-2"), true);
			assert.equal(isValidModelLaneName("Legacy_Lane"), false);
			assert.equal(isValidModelLaneName("-leading"), false);
			assert.equal(isValidModelLaneName(""), false);
		});

		it("creates a lane in an existing settings file", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" } } } },
			});

			const written = applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "hard", patch: { model: "anthropic/opus", thinking: "high" } },
			]);

			assert.equal(written, settingsPath);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: {
					normal: { model: "zai/glm-5.1" },
					hard: { model: "anthropic/opus", thinking: "high" },
				},
			});
		});

		it("creates the first lane for an agent that has no lane map", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" } } } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "reviewer", laneName: "deep", patch: { model: "anthropic/opus" } },
			]);

			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "zai/glm-5.1" } },
				reviewer: { deep: { model: "anthropic/opus" } },
			});
		});

		it("edits model and thinking in place and clears optional thinking with null", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1", thinking: "low" } } } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "normal", patch: { model: "deepseek/deepseek-v4-flash" } },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "deepseek/deepseek-v4-flash", thinking: "low" } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "normal", patch: { thinking: "max" } },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "deepseek/deepseek-v4-flash", thinking: "max" } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "normal", patch: { thinking: null } },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "deepseek/deepseek-v4-flash" } },
			});
		});

		it("renames a lane atomically while preserving unrelated lane properties", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: {
					modelLanes: {
						worker: {
							normal: { model: "zai/glm-5.1", thinking: "low", note: "keep me" },
							hard: { model: "anthropic/opus" },
						},
					},
				},
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "standard", originalLaneName: "normal", patch: {} },
			]);

			const settings = readSettings(settingsPath);
			assert.deepEqual(settings, {
				subagents: {
					modelLanes: {
						worker: {
							hard: { model: "anthropic/opus" },
							standard: { model: "zai/glm-5.1", thinking: "low", note: "keep me" },
						},
					},
				},
			});
		});

		it("allows removing and recreating the same lane name in one batch", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1", thinking: "low" } } } },
			});

			applyUserModelLaneMutations([
				{ kind: "remove", agentName: "worker", laneName: "normal" },
				{ kind: "upsert", agentName: "worker", laneName: "normal", patch: { model: "anthropic/opus" } },
			]);

			assert.deepEqual(readSettings(settingsPath), {
				subagents: { modelLanes: { worker: { normal: { model: "anthropic/opus" } } } },
			});
		});

		it("rejects two renames that converge on the same target", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { alpha: { model: "zai/glm-5.1" }, charlie: { model: "anthropic/opus" } } } },
			});
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "shared", originalLaneName: "alpha", patch: {} },
					{ kind: "upsert", agentName: "worker", laneName: "shared", originalLaneName: "charlie", patch: {} },
				]),
				/Model lane 'shared'.*already exists/,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("allows creating and removing the same lane in one batch", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" } } } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "temporary", patch: { model: "anthropic/opus" } },
				{ kind: "remove", agentName: "worker", laneName: "temporary" },
			]);

			assert.deepEqual(readSettings(settingsPath), {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" } } } },
			});
		});

		it("rejects renaming onto a target that is removed later in the batch", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { alpha: { model: "zai/glm-5.1" }, beta: { model: "anthropic/opus" } } } },
			});
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "beta", originalLaneName: "alpha", patch: {} },
					{ kind: "remove", agentName: "worker", laneName: "beta" },
				]),
				/Model lane 'beta'.*already exists/,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("rejects an upsert whose original lane was consumed earlier in the batch", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { alpha: { model: "zai/glm-5.1" } } } },
			});
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "beta", originalLaneName: "alpha", patch: {} },
					{ kind: "upsert", agentName: "worker", laneName: "gamma", originalLaneName: "alpha", patch: {} },
				]),
				/Cannot edit lane 'alpha'.*it no longer exists \(possibly renamed earlier in this batch\)\./,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("persists a two-lane rename swap in one batch", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				theme: "dark",
				subagents: {
					modelLanes: {
						reviewer: { deep: { model: "anthropic/opus" } },
						worker: {
							normal: { model: "zai/glm-5.1", thinking: "low", note: "was normal" },
							hard: { model: "anthropic/opus", thinking: "high", note: "was hard" },
						},
					},
				},
			});

			// A true swap: neither upsert can run first without colliding with a live lane.
			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "hard", originalLaneName: "normal", patch: {} },
				{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "hard", patch: {} },
			]);

			assert.deepEqual(readSettings(settingsPath), {
				theme: "dark",
				subagents: {
					modelLanes: {
						reviewer: { deep: { model: "anthropic/opus" } },
						worker: {
							hard: { model: "zai/glm-5.1", thinking: "low", note: "was normal" },
							normal: { model: "anthropic/opus", thinking: "high", note: "was hard" },
						},
					},
				},
			});
		});

		it("persists a three-lane rename cycle with patches applied to the right lanes", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: {
					modelLanes: {
						worker: {
							a: { model: "vendor/a", note: "from-a" },
							b: { model: "vendor/b", thinking: "low", note: "from-b" },
							c: { model: "vendor/c", note: "from-c" },
						},
					},
				},
			});

			// a -> b -> c -> a, with patches riding along on two legs.
			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "b", originalLaneName: "a", patch: { thinking: "max" } },
				{ kind: "upsert", agentName: "worker", laneName: "c", originalLaneName: "b", patch: { thinking: null } },
				{ kind: "upsert", agentName: "worker", laneName: "a", originalLaneName: "c", patch: {} },
			]);

			assert.deepEqual(readSettings(settingsPath), {
				subagents: {
					modelLanes: {
						worker: {
							b: { model: "vendor/a", note: "from-a", thinking: "max" },
							c: { model: "vendor/b", note: "from-b" },
							a: { model: "vendor/c", note: "from-c" },
						},
					},
				},
			});
		});

		it("rejects an in-place edit whose lane vanished from disk instead of resurrecting it", () => {
			const settingsPath = userSettingsPath();
			// The lane disappears between overlay open and save; the staged patch still names it.
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { other: { model: "anthropic/opus" } } } },
			});
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "normal", patch: { thinking: "low" } },
				]),
				/Cannot edit lane 'normal'.*it no longer exists/,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("treats prototype-chain lane names as absent unless they are own keys", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" } } } },
			});

			// `constructor` satisfies the managed name rule and must not read as pre-existing.
			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "constructor", patch: { model: "vendor/ctor" } },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "zai/glm-5.1" }, constructor: { model: "vendor/ctor" } },
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "constructor", originalLaneName: "constructor", patch: { thinking: "high" } },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: {
					normal: { model: "zai/glm-5.1" },
					constructor: { model: "vendor/ctor", thinking: "high" },
				},
			});

			applyUserModelLaneMutations([
				{ kind: "remove", agentName: "worker", laneName: "constructor" },
			]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "zai/glm-5.1" } },
			});

			// An inherited name is still drift, not a silently accepted no-op removal.
			const before = readRaw(settingsPath);
			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "__proto__" }]),
				/no such user lane exists/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "toString" }]),
				/no such user lane exists/,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("removes one lane and retains an intentionally empty modelLanes for the last one", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: {
					modelLanes: {
						worker: { normal: { model: "zai/glm-5.1" }, hard: { model: "anthropic/opus" } },
					},
				},
			});

			applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "hard" }]);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "zai/glm-5.1" } },
			});

			applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "normal" }]);
			assert.deepEqual(readSettings(settingsPath), { subagents: { modelLanes: {} } });
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {});
		});

		it("rejects removing a lane that does not exist", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, { subagents: { modelLanes: { worker: { normal: {} } } } });
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "ghost" }]),
				/no such user lane exists/,
			);
			assert.equal(readRaw(settingsPath), before);
		});

		it("preserves root fields, sibling subagents fields, agentOverrides, and sibling roles", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				theme: "dark",
				mcpServers: { local: { command: "node" } },
				subagents: {
					defaultModel: "zai/glm-5.1",
					agentOverrides: { worker: { thinking: "high" } },
					modelLanes: {
						reviewer: { deep: { model: "anthropic/opus" } },
						worker: { normal: { model: "zai/glm-5.1" } },
					},
				},
			});

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "hard", patch: { model: "anthropic/opus" } },
			]);

			assert.deepEqual(readSettings(settingsPath), {
				theme: "dark",
				mcpServers: { local: { command: "node" } },
				subagents: {
					defaultModel: "zai/glm-5.1",
					agentOverrides: { worker: { thinking: "high" } },
					modelLanes: {
						reviewer: { deep: { model: "anthropic/opus" } },
						worker: { normal: { model: "zai/glm-5.1" }, hard: { model: "anthropic/opus" } },
					},
				},
			});
		});

		it("creates nested parent directories for a missing settings file and ends with a newline", () => {
			const settingsPath = userSettingsPath();
			assert.equal(fs.existsSync(settingsPath), false);

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "normal", patch: { model: "zai/glm-5.1" } },
			]);

			const raw = readRaw(settingsPath);
			assert.equal(raw.endsWith("\n"), true);
			assert.equal(raw.endsWith("\n\n"), false);
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: { normal: { model: "zai/glm-5.1" } },
			});
		});

		it("replaces the settings file once with no leftover temp file", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, { subagents: { modelLanes: { worker: { normal: {} } } } });
			const inodeBefore = fs.statSync(settingsPath).ino;

			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "hard", patch: { model: "anthropic/opus" } },
			]);

			const entries = fs.readdirSync(path.dirname(settingsPath));
			assert.deepEqual(entries.filter((entry) => entry.includes(".tmp.")), []);
			assert.deepEqual(entries, ["settings.json"]);
			if (process.platform !== "win32") {
				assert.notEqual(fs.statSync(settingsPath).ino, inodeBefore);
			}
		});

		it("does not read or write anything when the mutation batch is empty", () => {
			const settingsPath = userSettingsPath();
			writeRaw(settingsPath, "{ definitely not json");

			assert.equal(applyUserModelLaneMutations([]), settingsPath);
			assert.equal(readRaw(settingsPath), "{ definitely not json");
		});

		const malformedCases: Array<{ label: string; content: string; pattern: RegExp }> = [
			{ label: "malformed JSON", content: "{ \"subagents\": ", pattern: /Failed to parse settings file/ },
			{ label: "non-object root", content: "[]", pattern: /must contain a JSON object/ },
			{ label: "malformed subagents", content: JSON.stringify({ subagents: "nope" }), pattern: /Subagent settings in .* must be an object/ },
			{ label: "malformed modelLanes", content: JSON.stringify({ subagents: { modelLanes: [] } }), pattern: /invalid 'modelLanes'/ },
			{ label: "malformed agent map", content: JSON.stringify({ subagents: { modelLanes: { worker: "nope" } } }), pattern: /Model lanes for agent 'worker'/ },
			{
				label: "malformed lane definition",
				content: JSON.stringify({ subagents: { modelLanes: { worker: { normal: "zai/glm-5.1" } } } }),
				pattern: /Model lane 'normal' for agent 'worker'/,
			},
		];

		for (const malformed of malformedCases) {
			it(`rejects ${malformed.label} without replacing the original bytes`, () => {
				const settingsPath = userSettingsPath();
				writeRaw(settingsPath, malformed.content);

				assert.throws(
					() => applyUserModelLaneMutations([
						{ kind: "upsert", agentName: "worker", laneName: "hard", patch: { model: "anthropic/opus" } },
					]),
					malformed.pattern,
				);
				assert.equal(readRaw(settingsPath), malformed.content);
			});
		}

		it("rejects invalid models, thinking levels, names, rename targets, and duplicate targets", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: { modelLanes: { worker: { normal: { model: "zai/glm-5.1" }, hard: { model: "anthropic/opus" } } } },
			});
			const before = readRaw(settingsPath);

			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "upsert", agentName: "worker", laneName: "fast", patch: { model: "   " } }]),
				/invalid 'model'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "fast", patch: { model: 42 } as unknown as ModelLanePatch },
				]),
				/invalid 'model'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "fast", patch: { thinking: "ultra" } as unknown as ModelLanePatch },
				]),
				/invalid 'thinking'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "upsert", agentName: "worker", laneName: "Fast Lane", patch: { model: "zai/glm-5.1" } }]),
				/Invalid model lane name 'Fast Lane'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "-bad", originalLaneName: "normal", patch: {} },
				]),
				/Invalid model lane name '-bad'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "hard", originalLaneName: "normal", patch: {} },
				]),
				/already exists for agent 'worker'/,
			);
			assert.throws(
				() => applyUserModelLaneMutations([
					{ kind: "upsert", agentName: "worker", laneName: "fast", patch: { model: "zai/glm-5.1" } },
					{ kind: "upsert", agentName: "worker", laneName: "fast", patch: { model: "anthropic/opus" } },
				]),
				/Model lane 'fast' already exists for agent 'worker'/,
			);

			assert.equal(readRaw(settingsPath), before);
		});

		it("keeps legacy non-conforming lane names readable, editable, renameable, and removable", () => {
			const settingsPath = userSettingsPath();
			writeJson(settingsPath, {
				subagents: {
					modelLanes: {
						worker: {
							Legacy_Lane: { model: "zai/glm-5.1", note: "legacy" },
							"Other Legacy": { thinking: "low" },
						},
					},
				},
			});

			// Reads never apply the managed name rule.
			assert.deepEqual(readModelLanesFromSettingsFile(settingsPath), {
				worker: {
					Legacy_Lane: { model: "zai/glm-5.1" },
					"Other Legacy": { thinking: "low" },
				},
			});

			// Edit in place under the same invalid key.
			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "Legacy_Lane", originalLaneName: "Legacy_Lane", patch: { thinking: "high" } },
			]);
			assert.deepEqual(readSettings(settingsPath), {
				subagents: {
					modelLanes: {
						worker: {
							Legacy_Lane: { model: "zai/glm-5.1", note: "legacy", thinking: "high" },
							"Other Legacy": { thinking: "low" },
						},
					},
				},
			});

			// Creating a new invalid name is still rejected.
			assert.throws(
				() => applyUserModelLaneMutations([{ kind: "upsert", agentName: "worker", laneName: "New_Legacy", patch: {} }]),
				/Invalid model lane name 'New_Legacy'/,
			);

			// Rename the legacy key to a valid target, preserving unrelated properties.
			applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "legacy-lane", originalLaneName: "Legacy_Lane", patch: {} },
			]);
			// And delete the remaining legacy key by its existing name.
			applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "Other Legacy" }]);

			assert.deepEqual(readSettings(settingsPath), {
				subagents: {
					modelLanes: {
						worker: { "legacy-lane": { model: "zai/glm-5.1", note: "legacy", thinking: "high" } },
					},
				},
			});
		});

		it("writes lanes that resolve through the unchanged resolution path", () => {
			const projectSettingsPath = path.join(tempProject, ".pi", "settings.json");
			writeJson(projectSettingsPath, {
				subagents: { modelLanes: { worker: { hard: { thinking: "low" } } } },
			});

			const settingsPath = applyUserModelLaneMutations([
				{ kind: "upsert", agentName: "worker", laneName: "normal", patch: { model: "zai/glm-5.1", thinking: "medium" } },
				{ kind: "upsert", agentName: "worker", laneName: "hard", patch: { model: "anthropic/opus" } },
			]);
			assert.equal(settingsPath, userSettingsPath());

			assert.deepEqual(resolveModelLane(tempProject, "worker", "normal"), {
				found: true,
				agentName: "worker",
				laneName: "normal",
				value: { model: "zai/glm-5.1", thinking: "medium" },
				scope: "user",
				filePath: settingsPath,
			});
			// Project scope still wins over a freshly written user lane.
			assert.deepEqual(resolveModelLane(tempProject, "worker", "hard"), {
				found: true,
				agentName: "worker",
				laneName: "hard",
				value: { thinking: "low" },
				scope: "project",
				filePath: projectSettingsPath,
			});
			assert.deepEqual(resolveModelLaneOverrides(tempProject, { agentName: "worker", laneName: "normal" }), {
				model: "zai/glm-5.1",
				thinking: "medium",
			});
			assert.throws(
				() => resolveModelLaneOverrides(tempProject, { agentName: "worker", laneName: "missing" }),
				/Unknown model lane 'missing' for agent 'worker'\./,
			);
		});
	});
});
