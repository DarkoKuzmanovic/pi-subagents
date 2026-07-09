import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { resolveParallelItemOutputPath } from "../../src/shared/settings.ts";

describe("resolveParallelItemOutputPath", () => {
	it("namespaces relative outputs under the parallel task directory", () => {
		assert.equal(
			resolveParallelItemOutputPath("reports/context.md", "/tmp/run", 3, 2, "reviewer"),
			path.join("/tmp/run", "parallel-3", "2-reviewer", "reports", "context.md"),
		);
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
});
