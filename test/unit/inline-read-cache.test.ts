/**
 * Unit tests for inline read cache LRU behavior and clearing.
 */
import * as assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { clearInlineReadCache, readInlineRead } from "../../src/shared/settings.ts";

describe("inline read cache", () => {
	let tmpDir: string;

	afterEach(() => {
		clearInlineReadCache();
		if (tmpDir) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
		}
	});

	it("clearInlineReadCache does not throw", () => {
		assert.doesNotThrow(() => clearInlineReadCache());
	});

	it("returns same content on cache hit", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
		const file = path.join(tmpDir, "test.txt");
		fs.writeFileSync(file, "hello world");

		const result1 = readInlineRead(file, tmpDir);
		const result2 = readInlineRead(file, tmpDir);
		assert.equal(result1.body, result2.body);
		assert.equal(result1.ok, true);
		assert.equal(result2.ok, true);
	});

	it("invalidates cache when file changes", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
		const file = path.join(tmpDir, "test.txt");
		fs.writeFileSync(file, "version 1");

		const result1 = readInlineRead(file, tmpDir);
		assert.ok(result1.body.includes("version 1"));

		// Ensure mtime changes (some filesystems have 1s resolution)
		const stat = fs.statSync(file);
		const newMtime = new Date(stat.mtimeMs + 1000);
		fs.writeFileSync(file, "version 2");
		fs.utimesSync(file, newMtime, newMtime);

		const result2 = readInlineRead(file, tmpDir);
		assert.ok(result2.body.includes("version 2"));
	});

	it("clearing cache forces re-read", () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
		const file = path.join(tmpDir, "test.txt");
		fs.writeFileSync(file, "original");

		readInlineRead(file, tmpDir);
		clearInlineReadCache();

		// After clearing, next read should succeed (no stale state)
		const result = readInlineRead(file, tmpDir);
		assert.equal(result.ok, true);
		assert.ok(result.body.includes("original"));
	});
});
