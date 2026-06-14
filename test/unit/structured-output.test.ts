import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	assertJsonSchemaObject,
	cleanupStructuredOutputRuntime,
	createStructuredOutputRuntime,
	readStructuredOutput,
	validateStructuredOutputValue,
} from "../../src/runs/shared/structured-output.js";

const SCHEMA = {
	type: "object",
	properties: {
		files: { type: "array", items: { type: "string" } },
		count: { type: "number" },
	},
	required: ["files", "count"],
	additionalProperties: false,
} as const;

describe("validateStructuredOutputValue", () => {
	it("accepts a schema-valid value", () => {
		const result = validateStructuredOutputValue(SCHEMA, { files: ["a.ts"], count: 1 });
		assert.strictEqual(result.status, "valid");
	});

	it("rejects a value violating the schema with a path-qualified message", () => {
		const result = validateStructuredOutputValue(SCHEMA, { files: "nope", count: 1 });
		assert.strictEqual(result.status, "invalid");
		if (result.status === "invalid") assert.match(result.message, /files/);
	});

	it("rejects a missing required field", () => {
		const result = validateStructuredOutputValue(SCHEMA, { files: [] });
		assert.strictEqual(result.status, "invalid");
	});
});

describe("assertJsonSchemaObject", () => {
	it("throws on non-object schema", () => {
		assert.throws(() => assertJsonSchemaObject(null));
		assert.throws(() => assertJsonSchemaObject([]));
		assert.throws(() => assertJsonSchemaObject("x"));
	});

	it("passes a plain object", () => {
		assert.doesNotThrow(() => assertJsonSchemaObject({ type: "object" }));
	});
});

describe("structured output runtime lifecycle", () => {
	it("creates schema file, reads back a valid captured value, then cleans up", () => {
		const runtime = createStructuredOutputRuntime(SCHEMA);
		try {
			assert.ok(fs.existsSync(runtime.schemaPath), "schema file written");
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(runtime.schemaPath, "utf-8")), SCHEMA);

			// Simulate the child writing its structured_output capture.
			fs.writeFileSync(runtime.outputPath, JSON.stringify({ files: ["x.ts", "y.ts"], count: 2 }));
			const read = readStructuredOutput(runtime);
			assert.strictEqual(read.error, undefined);
			assert.deepStrictEqual(read.value, { files: ["x.ts", "y.ts"], count: 2 });
		} finally {
			cleanupStructuredOutputRuntime(runtime);
		}
		assert.ok(!fs.existsSync(path.dirname(runtime.schemaPath)), "runtime dir removed");
	});

	it("errors when the child never wrote the capture file (missing structured_output call)", () => {
		const runtime = createStructuredOutputRuntime(SCHEMA);
		try {
			const read = readStructuredOutput(runtime);
			assert.ok(read.error && /Missing structured_output call/.test(read.error));
			assert.strictEqual(read.value, undefined);
		} finally {
			cleanupStructuredOutputRuntime(runtime);
		}
	});

	it("errors when the captured value fails schema validation", () => {
		const runtime = createStructuredOutputRuntime(SCHEMA);
		try {
			fs.writeFileSync(runtime.outputPath, JSON.stringify({ files: ["x.ts"], count: "two" }));
			const read = readStructuredOutput(runtime);
			assert.ok(read.error && /validation failed/i.test(read.error));
		} finally {
			cleanupStructuredOutputRuntime(runtime);
		}
	});

	it("errors when the captured file is not valid JSON", () => {
		const runtime = createStructuredOutputRuntime(SCHEMA);
		try {
			fs.writeFileSync(runtime.outputPath, "{ not json");
			const read = readStructuredOutput(runtime);
			assert.ok(read.error && /Failed to read structured output/.test(read.error));
		} finally {
			cleanupStructuredOutputRuntime(runtime);
		}
	});

	it("cleanupStructuredOutputRuntime tolerates undefined", () => {
		assert.doesNotThrow(() => cleanupStructuredOutputRuntime(undefined));
	});
});
