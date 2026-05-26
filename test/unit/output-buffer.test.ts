import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRecentOutputBuffer } from "../../src/runs/shared/output-buffer.js";

describe("createRecentOutputBuffer", () => {
	it("starts empty", () => {
		const buf = createRecentOutputBuffer();
		assert.deepEqual(buf.snapshot(), []);
	});

	it("appends non-empty lines", () => {
		const buf = createRecentOutputBuffer();
		buf.append(["line 1", "line 2"]);
		assert.deepEqual(buf.snapshot(), ["line 1", "line 2"]);
	});

	it("filters empty and whitespace-only lines", () => {
		const buf = createRecentOutputBuffer();
		buf.append(["  ", "", "hello", "\t", "world"]);
		assert.deepEqual(buf.snapshot(), ["hello", "world"]);
	});

	it("is a no-op when all lines are empty", () => {
		const buf = createRecentOutputBuffer();
		buf.append(["", "   ", "\n"]);
		assert.deepEqual(buf.snapshot(), []);
	});

	it("trims to maxLines", () => {
		const buf = createRecentOutputBuffer(3);
		buf.append(["a", "b", "c", "d", "e"]);
		assert.deepEqual(buf.snapshot(), ["c", "d", "e"]);
	});

	it("keeps most recent lines when cap is exceeded across multiple appends", () => {
		const buf = createRecentOutputBuffer(3);
		buf.append(["a", "b"]);
		buf.append(["c", "d"]);
		assert.deepEqual(buf.snapshot(), ["b", "c", "d"]);
	});

	it("default maxLines is 50", () => {
		const buf = createRecentOutputBuffer();
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		buf.append(lines);
		const snap = buf.snapshot();
		assert.strictEqual(snap.length, 50);
		assert.strictEqual(snap[0], "line 10");
		assert.strictEqual(snap[49], "line 59");
	});

	it("snapshot returns a shallow copy (not a live reference)", () => {
		const buf = createRecentOutputBuffer();
		buf.append(["a", "b"]);
		const snap1 = buf.snapshot();
		snap1.push("mutated");
		const snap2 = buf.snapshot();
		assert.deepEqual(snap2, ["a", "b"]);
	});

	it("snapshot returns new array each call", () => {
		const buf = createRecentOutputBuffer();
		buf.append(["a"]);
		const s1 = buf.snapshot();
		const s2 = buf.snapshot();
		assert.notStrictEqual(s1, s2);
	});

	it("accumulates across multiple append calls", () => {
		const buf = createRecentOutputBuffer(10);
		buf.append(["a", "b"]);
		buf.append(["c"]);
		buf.append(["d", "e"]);
		assert.deepEqual(buf.snapshot(), ["a", "b", "c", "d", "e"]);
	});
});
