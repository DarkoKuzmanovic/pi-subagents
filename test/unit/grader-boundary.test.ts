import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerGraderReadBoundary, {
	GRADER_ALLOWED_ROOT_ENV,
	checkGraderPath,
} from "../../src/runs/shared/grader-boundary.ts";

const originalAllowedRoot = process.env[GRADER_ALLOWED_ROOT_ENV];
const tempRoots: string[] = [];

afterEach(() => {
	if (originalAllowedRoot === undefined)
		delete process.env[GRADER_ALLOWED_ROOT_ENV];
	else process.env[GRADER_ALLOWED_ROOT_ENV] = originalAllowedRoot;
	for (const root of tempRoots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("grader read boundary", () => {
	it("rejects traversal and absolute paths outside the worktree", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "grader-boundary-"));
		tempRoots.push(root);
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "grader-boundary-outside-"),
		);
		tempRoots.push(outside);
		fs.writeFileSync(path.join(root, "inside.txt"), "inside\n", "utf8");
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n", "utf8");

		assert.equal(checkGraderPath(root, root, "inside.txt").status, "allowed");
		const traversal = checkGraderPath(
			root,
			root,
			"../grader-boundary-outside/secret.txt",
		);
		assert.equal(traversal.status, "blocked");
		if (traversal.status === "blocked")
			assert.match(traversal.message, /traversal/i);
		const absolute = checkGraderPath(
			root,
			root,
			path.join(outside, "secret.txt"),
		);
		assert.equal(absolute.status, "blocked");
		if (absolute.status === "blocked")
			assert.match(absolute.message, /outside/i);
	});

	it("resolves a nested not-yet-existing path in its configured order", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "grader-boundary-nested-"));
		tempRoots.push(root);

		const result = checkGraderPath(root, root, "reports/nested/result.md");
		assert.equal(result.status, "allowed");
		if (result.status === "allowed") {
			assert.equal(
				result.resolvedPath,
				path.join(fs.realpathSync(root), "reports", "nested", "result.md"),
				"multi-segment missing paths must keep root-to-leaf order",
			);
		}
	});

	it("rejects symlinks that escape the worktree", {
		skip:
			process.platform === "win32"
				? "Symlink behavior differs on Windows CI."
				: undefined,
	}, () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "grader-boundary-link-"),
		);
		tempRoots.push(root);
		const outside = fs.mkdtempSync(
			path.join(os.tmpdir(), "grader-boundary-link-outside-"),
		);
		tempRoots.push(outside);
		fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n", "utf8");
		fs.symlinkSync(outside, path.join(root, "outside-link"), "dir");

		const result = checkGraderPath(root, root, "outside-link/secret.txt");
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.match(result.message, /symlink/i);
	});

	it("blocks every read/search/list tool through the child tool_call hook", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "grader-boundary-hook-"),
		);
		tempRoots.push(root);
		process.env[GRADER_ALLOWED_ROOT_ENV] = root;
		let toolCall:
			| ((
					event: { toolName: string; input: unknown },
					ctx: { cwd: string },
			  ) => unknown)
			| undefined;
		registerGraderReadBoundary({
			on(
				event: string,
				handler: (
					event: { toolName: string; input: unknown },
					ctx: { cwd: string },
				) => unknown,
			) {
				if (event === "tool_call") toolCall = handler;
			},
		} as never);
		assert.ok(toolCall);

		for (const toolName of ["read", "grep", "find", "ls"]) {
			const result = toolCall?.(
				{ toolName, input: { path: "/tmp/not-the-worktree" } },
				{ cwd: root },
			) as { block?: boolean; reason?: string } | undefined;
			assert.equal(result?.block, true, `${toolName} should be blocked`);
			assert.match(result?.reason ?? "", /grader read boundary blocked/i);
		}
	});
});
