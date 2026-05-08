/**
 * Unit tests for glob reads and inline read helpers.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
	expandReadGlobs,
	parseReadSpec,
	readInlineRead,
	buildChainInstructions,
	setInlineReadMaxBytes,
} from "../../src/shared/settings.ts";

const scratchDirs: string[] = [];

function makeScratchDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-glob-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratchDirs) {
		try { fs.rmSync(dir, { recursive: true }); } catch { /* ignore */ }
	}
	scratchDirs.length = 0;
	setInlineReadMaxBytes(undefined);
});

describe("parseReadSpec", () => {
	it("parses plain file path without range", () => {
		const result = parseReadSpec("/tmp/foo.ts", "/tmp");
		assert.equal(result.filePath, "/tmp/foo.ts");
		assert.equal(result.range, undefined);
		assert.equal(result.label, "/tmp/foo.ts");
	});

	it("parses path with line range", () => {
		const result = parseReadSpec("/tmp/foo.ts:10-20", "/tmp");
		assert.equal(result.filePath, "/tmp/foo.ts");
		assert.ok(result.range);
		assert.equal(result.range!.start, 10);
		assert.equal(result.range!.end, 20);
	});

	it("Bug D: treats literal file with colon-digits as file when it exists", () => {
		const dir = makeScratchDir();
		const weirdPath = path.join(dir, "weird:5-10.bak");
		fs.writeFileSync(weirdPath, "literal-content");
		const result = parseReadSpec(weirdPath, dir);
		assert.equal(result.filePath, weirdPath);
		assert.equal(result.range, undefined);
	});

	it("Bug D: parses range when literal file does not exist", () => {
		const dir = makeScratchDir();
		const result = parseReadSpec(path.join(dir, "foo.ts:10-20"), dir);
		assert.ok(result.range); // Falls through to range parsing when literal doesn't exist
		assert.equal(result.range!.start, 10);
		assert.equal(result.range!.end, 20);
		// The spec is treated as range parsing but the base file doesn't exist either
	});

	it("treats inverted range (start > end) as full-file read", () => {
		const result = parseReadSpec("/tmp/foo.ts:20-10", "/tmp");
		assert.equal(result.filePath, "/tmp/foo.ts");
		assert.equal(result.range, undefined);
	});

	it("treats range with start < 1 as full-file read", () => {
		const result = parseReadSpec("/tmp/foo.ts:0-5", "/tmp");
		assert.equal(result.filePath, "/tmp/foo.ts");
		assert.equal(result.range, undefined);
	});
});

describe("readInlineRead", () => {
	it("returns ok: true for existing file", () => {
		const dir = makeScratchDir();
		const filePath = path.join(dir, "test.txt");
		fs.writeFileSync(filePath, "hello world");
		const result = readInlineRead(filePath, dir);
		assert.equal(result.ok, true);
		assert.ok(result.body.includes("hello world"));
	});

	it("returns ok: false for missing file", () => {
		const dir = makeScratchDir();
		const result = readInlineRead(path.join(dir, "missing.txt"), dir);
		assert.equal(result.ok, false);
		assert.ok(result.body.includes("[unreadable:"));
	});

	it("Bug C: truncation marker says characters not bytes", () => {
		const dir = makeScratchDir();
		const filePath = path.join(dir, "big.txt");
		// Create a file larger than 4096 bytes
		const content = "x".repeat(5000);
		fs.writeFileSync(filePath, content);
		setInlineReadMaxBytes(4096);
		const result = readInlineRead(filePath, dir);
		assert.equal(result.ok, true);
		assert.ok(result.body.includes("characters"));
		assert.ok(!result.body.includes("bytes]"));
	});
});

describe("expandReadGlobs", () => {
	it("passes through literal specs without glob chars", () => {
		const dir = makeScratchDir();
		const filePath = path.join(dir, "test.txt");
		fs.writeFileSync(filePath, "content");
		const { specs, emptyGlobs } = expandReadGlobs([filePath], dir);
		assert.deepEqual(specs, [filePath]);
		assert.deepEqual(emptyGlobs, []);
	});

	it("expands glob patterns", () => {
		const dir = makeScratchDir();
		fs.writeFileSync(path.join(dir, "a.ts"), "");
		fs.writeFileSync(path.join(dir, "b.ts"), "");
		fs.writeFileSync(path.join(dir, "c.js"), "");
		const { specs, emptyGlobs } = expandReadGlobs([path.join(dir, "*.ts")], dir);
		assert.equal(specs.length, 2);
		assert.ok(specs[0]!.includes("a.ts"));
		assert.ok(specs[1]!.includes("b.ts"));
		assert.deepEqual(emptyGlobs, []);
	});

	it("sorts results alphabetically", () => {
		const dir = makeScratchDir();
		fs.writeFileSync(path.join(dir, "z.ts"), "");
		fs.writeFileSync(path.join(dir, "a.ts"), "");
		fs.writeFileSync(path.join(dir, "m.ts"), "");
		const { specs } = expandReadGlobs([path.join(dir, "*.ts")], dir);
		assert.ok(specs[0]!.endsWith("a.ts"));
		assert.ok(specs[1]!.endsWith("m.ts"));
		assert.ok(specs[2]!.endsWith("z.ts"));
	});

	it("reports zero-match globs as emptyGlobs", () => {
		const dir = makeScratchDir();
		const { specs, emptyGlobs } = expandReadGlobs([path.join(dir, "*.zzz")], dir);
		assert.deepEqual(specs, []);
		assert.equal(emptyGlobs.length, 1);
	});

	it("Bug D defense: treats literal file with glob chars as file", () => {
		const dir = makeScratchDir();
		const weirdPath = path.join(dir, "weird[brackets].ts");
		fs.writeFileSync(weirdPath, "content");
		const { specs, emptyGlobs } = expandReadGlobs([weirdPath], dir);
		assert.deepEqual(specs, [weirdPath]);
		assert.deepEqual(emptyGlobs, []);
	});

	it("caps at 50 matches per pattern", () => {
		const dir = makeScratchDir();
		for (let i = 0; i < 55; i++) {
			fs.writeFileSync(path.join(dir, `file-${String(i).padStart(3, "0")}.ts`), "");
		}
		const { specs } = expandReadGlobs([path.join(dir, "*.ts")], dir);
		assert.equal(specs.length, 50);
	});

	it("Bug F: expands ~/ in glob patterns to the home directory", () => {
		const dir = makeScratchDir();
		const relDir = path.join(".pi-subagents-glob-tilde-test", path.basename(dir));
		const absDir = path.join(os.homedir(), relDir);
		try { fs.mkdirSync(absDir, { recursive: true }); } catch { /* may exist */ }
		fs.writeFileSync(path.join(absDir, "a.tilde.txt"), "a");
		fs.writeFileSync(path.join(absDir, "b.tilde.txt"), "b");
		const { specs } = expandReadGlobs([`~/${relDir}/*.tilde.txt`], dir);
		assert.equal(specs.length, 2);
		assert.ok(path.isAbsolute(specs[0]!));
		try { fs.rmSync(absDir, { recursive: true }); } catch { /* ignore */ }
	});

	it("handles absolute glob patterns", () => {
		const dir = makeScratchDir();
		fs.writeFileSync(path.join(dir, "x.ts"), "");
		fs.writeFileSync(path.join(dir, "y.ts"), "");
		const { specs } = expandReadGlobs([path.join(dir, "*.ts")], "/tmp");
		assert.equal(specs.length, 2);
		assert.ok(path.isAbsolute(specs[0]!));
	});
});

describe("buildChainInstructions with inlineReads", () => {
	it("produces Pre-loaded files block for inline reads", () => {
		const dir = makeScratchDir();
		const filePath = path.join(dir, "test.txt");
		fs.writeFileSync(filePath, "hello world");
		const { prefix } = buildChainInstructions(
			{ output: false, outputMode: "inline" as const, reads: [filePath], progress: false, skills: [], model: undefined },
			dir,
			false,
			undefined,
			true, // inlineReads
		);
		assert.ok(prefix.includes("Pre-loaded files"));
		assert.ok(prefix.includes("hello world"));
		assert.ok(!prefix.includes("[Read from:"));
	});

	it("produces [Read from:] fallback for failed reads", () => {
		const dir = makeScratchDir();
		const { prefix } = buildChainInstructions(
			{ output: false, outputMode: "inline" as const, reads: [path.join(dir, "missing.txt")], progress: false, skills: [], model: undefined },
			dir,
			false,
			undefined,
			true, // inlineReads
		);
		assert.ok(!prefix.includes("Pre-loaded files"));
		assert.ok(prefix.includes("[Read from:"));
	});

	it("produces [Read from:] list in legacy mode", () => {
		const dir = makeScratchDir();
		const { prefix } = buildChainInstructions(
			{ output: false, outputMode: "inline" as const, reads: [path.join(dir, "test.txt")], progress: false, skills: [], model: undefined },
			dir,
			false,
			undefined,
			false, // legacy mode
		);
		assert.ok(prefix.includes("[Read from:"));
		assert.ok(!prefix.includes("Pre-loaded files"));
	});

	it("emits [Read from glob (no matches):] for empty globs", () => {
		const dir = makeScratchDir();
		const { prefix } = buildChainInstructions(
			{ output: false, outputMode: "inline" as const, reads: [path.join(dir, "*.zzz")], progress: false, skills: [], model: undefined },
			dir,
			false,
			undefined,
			true, // inlineReads
		);
		assert.ok(prefix.includes("[Read from glob (no matches):"));
	});
});
