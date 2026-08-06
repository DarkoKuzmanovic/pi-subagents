import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createParallelDirs, resolveParallelBehaviors, resolveParallelItemOutputPath } from "../../src/shared/settings.ts";

describe("resolveParallelItemOutputPath", () => {
	it("namespaces relative outputs under the parallel task directory", () => {
		const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-output-namespace-"));
		try {
			assert.equal(
				resolveParallelItemOutputPath("reports/context.md", chainDir, 3, 2, "reviewer"),
				path.join(chainDir, "parallel-3", "2-reviewer", "reports", "context.md"),
			);
		} finally {
			fs.rmSync(chainDir, { recursive: true, force: true });
		}
	});

	it("passes absolute outputs through unchanged", () => {
		assert.equal(
			resolveParallelItemOutputPath("/tmp/external/report.md", "/tmp/run", 3, 2, "reviewer"),
			"/tmp/external/report.md",
		);
	});

	it("returns undefined for disabled or missing outputs", () => {
		assert.equal(resolveParallelItemOutputPath(false, "/tmp/run", 3, 2, "reviewer"), undefined);
		assert.equal(resolveParallelItemOutputPath(undefined, "/tmp/run", 3, 2, "reviewer"), undefined);
	});

	it("rejects relative outputs that escape the parallel task namespace", () => {
		assert.throws(
			() => resolveParallelItemOutputPath("../../../../outside.md", "/tmp/run", 3, 2, "reviewer"),
			/Relative output path escapes its base directory/,
		);
	});

	it("rejects parallel outputs through a symlink outside the chain directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-output-symlink-"));
		try {
			const chainDir = path.join(root, "chain");
			const taskDir = path.join(chainDir, "parallel-0", "0-reviewer");
			const outside = path.join(root, "outside");
			fs.mkdirSync(taskDir, { recursive: true });
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(taskDir, "linked"));
			assert.throws(
				() => resolveParallelItemOutputPath("linked/report.md", chainDir, 0, 0, "reviewer"),
				/Relative output path escapes its base directory through a symlink/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a missing task directory beneath a chain symlink to outside", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-output-parent-symlink-"));
		try {
			const chainDir = path.join(root, "chain");
			const outside = path.join(root, "outside");
			fs.mkdirSync(chainDir);
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(chainDir, "parallel-0"));

			assert.throws(
				() => resolveParallelItemOutputPath("report.md", chainDir, 0, 0, "reviewer"),
				/Relative output path escapes its base directory through a symlink/,
			);
			assert.equal(fs.existsSync(path.join(outside, "0-reviewer")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a static parallel namespace symlink before creating an item directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-static-parallel-namespace-symlink-"));
		try {
			const chainDir = path.join(root, "chain");
			const outside = path.join(root, "outside");
			fs.mkdirSync(chainDir);
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(chainDir, "parallel-0"));

			assert.throws(
				() => createParallelDirs(chainDir, 0, 1, ["reviewer"]),
				/Relative output path escapes its base directory through a symlink/,
			);
			assert.equal(fs.existsSync(path.join(outside, "0-reviewer")), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects static parallel output overrides that escape their namespace", () => {
		assert.throws(
			() => resolveParallelBehaviors(
				[{ agent: "reviewer", output: "../../outside.md" }],
				[{
					name: "reviewer",
					description: "Reviewer",
					systemPromptMode: "append",
					inheritProjectContext: false,
					inheritSkills: false,
					systemPrompt: "Review",
					source: "builtin",
					filePath: "reviewer.md",
				}],
				0,
			),
			/Relative output path escapes its base directory/,
		);
	});
});
