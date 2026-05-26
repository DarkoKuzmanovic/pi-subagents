import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLineProcessor } from "../../src/runs/shared/stdio-parser.js";

describe("createLineProcessor", () => {
	describe("processLine", () => {
		it("calls onJson for valid JSON lines", () => {
			const received: unknown[] = [];
			const p = createLineProcessor({ onJson: (parsed) => received.push(parsed) });
			p.processLine('{"type":"message_end"}');
			assert.deepEqual(received, [{ type: "message_end" }]);
		});

		it("calls onRaw for non-JSON lines", () => {
			const raw: string[] = [];
			const p = createLineProcessor({ onJson: () => {}, onRaw: (line) => raw.push(line) });
			p.processLine("not json at all");
			assert.deepEqual(raw, ["not json at all"]);
		});

		it("silently ignores non-JSON when onRaw is undefined", () => {
			const json: unknown[] = [];
			const p = createLineProcessor({ onJson: (x) => json.push(x) });
			assert.doesNotThrow(() => p.processLine("not json"));
			assert.deepEqual(json, []);
		});

		it("skips empty lines", () => {
			const json: unknown[] = [];
			const raw: string[] = [];
			const p = createLineProcessor({ onJson: (x) => json.push(x), onRaw: (l) => raw.push(l) });
			p.processLine("");
			p.processLine("   ");
			p.processLine("\t");
			assert.deepEqual(json, []);
			assert.deepEqual(raw, []);
		});

		it("handles JSON null", () => {
			const received: unknown[] = [];
			const p = createLineProcessor({ onJson: (x) => received.push(x) });
			// JSON.parse("null") returns null — but onJson expects Record<string,unknown>
			// In practice, pi events are always objects. This just ensures no crash.
			assert.doesNotThrow(() => p.processLine("null"));
		});

		it("calls onJson for JSON arrays (no crash)", () => {
			const received: unknown[] = [];
			const p = createLineProcessor({ onJson: (x) => received.push(x) });
			assert.doesNotThrow(() => p.processLine("[1,2,3]"));
		});

		it("parses multiple lines independently", () => {
			const received: unknown[] = [];
			const p = createLineProcessor({ onJson: (x) => received.push(x) });
			p.processLine('{"type":"a"}');
			p.processLine('{"type":"b"}');
			assert.deepEqual(received, [{ type: "a" }, { type: "b" }]);
		});
	});

});
