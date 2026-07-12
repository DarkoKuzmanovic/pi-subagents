import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createStepTokenLedger } from "../../src/shared/session-tokens.ts";

const usage = (output: number) => ({ input: 0, output, total: output });

describe("StepTokenLedger", () => {
	it("computes per-step deltas for a pure sequential chain", () => {
		const ledger = createStepTokenLedger();
		// Root session file grows cumulatively across sequential steps.
		assert.deepEqual(ledger.advanceRootCumulative(usage(50)), usage(50));
		assert.deepEqual(ledger.advanceRootCumulative(usage(120)), usage(70));
		assert.equal(ledger.total.output, 120);
	});

	it("does not let parallel tasks corrupt the sequential baseline (H2 regression)", () => {
		const ledger = createStepTokenLedger();
		// Sequential step 1: root cumulative 50.
		assert.equal(ledger.advanceRootCumulative(usage(50)).output, 50);
		// Parallel group (own parallel-N session dirs): 50 + 50, must NOT advance the baseline.
		ledger.addParallel(usage(50));
		ledger.addParallel(usage(50));
		assert.equal(ledger.total.output, 150);
		// Sequential step 2: root cumulative is 100 (root holds only sequential steps 1+2).
		// Pre-fix this diffed against the parallel-polluted baseline (150) -> -50, silently dropped.
		const step2 = ledger.advanceRootCumulative(usage(100));
		assert.equal(step2.output, 50);
		assert.equal(ledger.total.output, 200);
	});

	it("keeps the baseline stable across standalone (own session file) steps (H3 regression)", () => {
		const ledger = createStepTokenLedger();
		assert.equal(ledger.advanceRootCumulative(usage(50)).output, 50);
		// Step with its own dedicated session file: reported directly, baseline untouched.
		ledger.addStandaloneStep(usage(50));
		assert.equal(ledger.total.output, 100);
		// Next root-session step: root cumulative is 100 (standalone step never wrote root).
		assert.equal(ledger.advanceRootCumulative(usage(100)).output, 50);
		assert.equal(ledger.total.output, 150);
	});

	it("returns a defensive copy of the running total", () => {
		const ledger = createStepTokenLedger();
		ledger.addParallel(usage(10));
		const snapshot = ledger.total;
		snapshot.output = 9999;
		assert.equal(ledger.total.output, 10);
	});
});
