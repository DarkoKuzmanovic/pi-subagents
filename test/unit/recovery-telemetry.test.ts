/**
 * Unit tests for recovery telemetry.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emitRecoveryEvent } from "../../src/shared/recovery-telemetry.ts";
import type { RecoveryDetails } from "../../src/shared/recovery-telemetry.ts";

const makeDetails = (overrides: Partial<RecoveryDetails> = {}): RecoveryDetails => ({
	agent: "test-agent",
	exitCode: 1,
	errorString: "Failed",
	recoveredChars: 42,
	mode: "single",
	...overrides,
});

describe("emitRecoveryEvent", () => {
	it("calls sendMessage with structured event", () => {
		const sent: { msg: unknown; opts: unknown }[] = [];
		const pi = {
			sendMessage: (msg: unknown, opts: unknown) => {
				sent.push({ msg, opts });
			},
		};
		emitRecoveryEvent(pi, makeDetails());
		assert.equal(sent.length, 1);
		const msg = sent[0]!.msg as Record<string, unknown>;
		assert.equal(msg.customType, "subagent_recovery");
		assert.equal(msg.display, false);
		assert.ok((msg.content as string).includes("single/test-agent"));
		assert.ok((msg.content as string).includes("exit 1"));
		assert.ok((msg.content as string).includes("42 chars recovered"));
	});

	it("does nothing when pi is undefined", () => {
		// Should not throw
		emitRecoveryEvent(undefined, makeDetails());
	});

	it("does nothing when pi.sendMessage is undefined", () => {
		emitRecoveryEvent({}, makeDetails());
	});

	it("swallows sendMessage errors", () => {
		const pi = {
			sendMessage: () => {
				throw new Error("sendMessage broken");
			},
		};
		// Should not throw
		emitRecoveryEvent(pi, makeDetails());
	});

	it("includes stepIndex in chain mode", () => {
		const sent: { msg: unknown }[] = [];
		const pi = {
			sendMessage: (msg: unknown) => {
				sent.push({ msg });
			},
		};
		emitRecoveryEvent(pi, makeDetails({ mode: "chain", stepIndex: 2 }));
		const msg = sent[0]!.msg as Record<string, unknown>;
		assert.ok((msg.content as string).includes("chain/test-agent/step2"));
	});
});
