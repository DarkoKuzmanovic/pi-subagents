import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FINAL_STOP_GRACE_MS, HARD_KILL_MS } from "../../src/runs/shared/exit-drain.js";

describe("constants", () => {
	it("FINAL_STOP_GRACE_MS is 1000", () => {
		assert.strictEqual(FINAL_STOP_GRACE_MS, 1000);
	});

	it("HARD_KILL_MS is 3000", () => {
		assert.strictEqual(HARD_KILL_MS, 3000);
	});
});
