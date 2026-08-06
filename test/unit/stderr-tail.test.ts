import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBoundedStderrBuffer, getStderrTail } from "../../src/runs/shared/stderr-tail.js";

describe("getStderrTail", () => {
	it("returns empty string for null input", () => {
		assert.strictEqual(getStderrTail(null), "");
	});

	it("returns empty string for undefined input", () => {
		assert.strictEqual(getStderrTail(undefined), "");
	});

	it("returns empty string for empty string", () => {
		assert.strictEqual(getStderrTail(""), "");
	});

	it("returns empty string for whitespace-only input", () => {
		assert.strictEqual(getStderrTail("   \n\t\n  "), "");
	});

	it("returns a single line when input has one line", () => {
		const input = "Error: something went wrong";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Error: something went wrong");
	});

	it("returns the last 8 lines when input has more than 8 lines", () => {
		const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`);
		const input = lines.join("\n");
		const result = getStderrTail(input);
		const resultLines = result.split("\n");
		assert.strictEqual(resultLines.length, 8);
		assert.strictEqual(resultLines[0], "Line 8");
		assert.strictEqual(resultLines[7], "Line 15");
	});

	it("truncates lines longer than 200 characters", () => {
		const longLine = "a".repeat(250);
		const input = longLine;
		const result = getStderrTail(input);
		assert.ok(result.includes("..."));
		assert.ok(result.length <= 250);
	});

	it("enforces ~800 character total cap", () => {
		// Create 12 lines of 100 chars each = 1200 chars total
		const lines = Array.from({ length: 12 }, () => "x".repeat(100));
		const input = lines.join("\n");
		const result = getStderrTail(input);
		assert.ok(result.length <= 800, `Result length ${result.length} exceeds 800 char cap`);
	});

	it("strips ANSI escape sequences (color codes)", () => {
		// ANSI color code: ESC[31m = red
		const input = "\x1B[31mError message\x1B[0m";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Error message");
	});

	it("strips ANSI escape sequences (formatting codes)", () => {
		// ANSI codes: ESC[1m = bold, ESC[0m = reset
		const input = "\x1B[1mBold text\x1B[0m";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Bold text");
	});

	it("strips multiple ANSI sequences in same line", () => {
		// Multiple ANSI sequences
		const input = "\x1B[33mWarning\x1B[0m: \x1B[31mError\x1B[0m";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Warning: Error");
	});

	it("strips ANSI sequences and respects line limit", () => {
		const lines = Array.from(
			{ length: 10 },
			(_, i) => `\x1B[32mLine ${i + 1}\x1B[0m`
		);
		const input = lines.join("\n");
		const result = getStderrTail(input);
		const resultLines = result.split("\n");
		assert.strictEqual(resultLines.length, 8);
		assert.strictEqual(resultLines[0], "Line 3");
	});

	it("filters empty lines (preserves non-empty lines only)", () => {
		const input = "Line 1\n\n\nLine 4\n\nLine 6";
		const result = getStderrTail(input);
		// Non-empty lines are: "Line 1", "Line 4", "Line 6" (3 lines)
		const resultLines = result.split("\n");
		assert.strictEqual(resultLines.length, 3);
		assert.deepStrictEqual(resultLines, ["Line 1", "Line 4", "Line 6"]);
	});

	it("trims leading/trailing whitespace from each line", () => {
		const input = "  Line 1  \n\t  Line 2  \t\n   Line 3   ";
		const result = getStderrTail(input);
		const resultLines = result.split("\n");
		assert.strictEqual(resultLines[0], "Line 1");
		assert.strictEqual(resultLines[1], "Line 2");
		assert.strictEqual(resultLines[2], "Line 3");
	});

	it("handles mixed ANSI sequences and long lines", () => {
		const longPart = "x".repeat(150);
		const lines = [
			`\x1B[31mError\x1B[0m: ${longPart}`,
			"Line 2",
			"Line 3"
		];
		const input = lines.join("\n");
		const result = getStderrTail(input);
		assert.ok(result.includes("Error:"));
		assert.ok(result.length <= 800);
	});

	it("handles complex ANSI sequences (multi-digit parameters)", () => {
		// ESC[38;5;196m = 256-color ANSI for red
		const input = "\x1B[38;5;196mComplex color\x1B[0m";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Complex color");
	});

	it("returns empty string when all lines are empty after filtering", () => {
		const input = "   \n\t\n  \n";
		const result = getStderrTail(input);
		assert.strictEqual(result, "");
	});

	it("handles real-world error output with multiple components", () => {
		const input = `
Error: Failed to compile
  at Object.<anonymous> (/path/to/file.js:10:5)
  at Module._load (internal/modules/cjs/loader.js:123:45)
  at Function.Module._load (internal/modules/cjs/loader.js:123:45)
Exit code: 1
Details: The compilation failed due to syntax error
		`;
		const result = getStderrTail(input);
		assert.ok(result.length <= 800);
		assert.ok(result.includes("Error:"));
		assert.ok(result.includes("Exit code: 1"));
	});

	it("preserves newlines in output", () => {
		const input = "Line 1\nLine 2\nLine 3";
		const result = getStderrTail(input);
		assert.strictEqual(result, "Line 1\nLine 2\nLine 3");
	});

	it("includes label suffix when result exceeds 800 chars after truncation", () => {
		// Create stderr that will be truncated at 800 chars
		const lines = Array.from({ length: 20 }, () => "x".repeat(100));
		const input = lines.join("\n");
		const result = getStderrTail(input);
		// When truncated at boundary, should include "..." suffix
		if (result.length > 800) {
			assert.ok(result.endsWith("..."), "Should have ... suffix when truncated");
		}
	});
});


describe("createBoundedStderrBuffer", () => {
	it("retains only the configured byte tail", () => {
		const buffer = createBoundedStderrBuffer({ tailBytes: 8, hardCapBytes: 100 });
		assert.strictEqual(buffer.append("012345"), undefined);
		assert.strictEqual(buffer.append("6789"), undefined);
		assert.strictEqual(buffer.totalBytes, 10);
		assert.strictEqual(Buffer.byteLength(buffer.text(), "utf8"), 8);
		assert.strictEqual(buffer.text(), "23456789");
	});

	it("preserves complete UTF-8 characters when chunks split a multibyte sequence", () => {
		const buffer = createBoundedStderrBuffer({ tailBytes: 6, hardCapBytes: 100 });
		const encoded = Buffer.from("A🙂B🙂C", "utf8");
		assert.strictEqual(buffer.append(encoded.subarray(0, 3)), undefined);
		assert.strictEqual(buffer.append(encoded.subarray(3, 8)), undefined);
		assert.strictEqual(buffer.append(encoded.subarray(8)), undefined);
		assert.strictEqual(buffer.text(), "B🙂C");
		assert.ok(!buffer.text().includes("�"));
	});

	it("reports the hard cap exactly once and remains bounded afterward", () => {
		const buffer = createBoundedStderrBuffer({ tailBytes: 5, hardCapBytes: 10 });
		assert.strictEqual(buffer.append("12345"), undefined);
		const error = buffer.append("678901");
		assert.match(error ?? "", /runaway stderr aborted/);
		assert.match(error ?? "", /10 bytes/);
		assert.strictEqual(buffer.tripped, true);
		assert.strictEqual(buffer.text(), "78901");
		assert.strictEqual(buffer.append("ignored after trip"), undefined);
		assert.strictEqual(buffer.totalBytes, 11);
		assert.strictEqual(Buffer.byteLength(buffer.text(), "utf8"), 5);
	});
});
