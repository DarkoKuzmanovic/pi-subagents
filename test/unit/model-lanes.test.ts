import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readModelLanesFromSettingsFile, resolveModelLane, resolveModelLaneOverrides } from "../../src/agents/model-lanes.ts";

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
						easy: { thinking: "max" },
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
						easy: { thinking: "max" },
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
});
