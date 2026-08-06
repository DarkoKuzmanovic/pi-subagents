import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureSingleOutputSnapshot,
	finalizeSingleOutput,
	formatSavedOutputReference,
	injectSingleOutputInstruction,
	resolveSingleOutput,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
	singleOutputWasProduced,
} from "../../src/runs/shared/single-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveSingleOutputPath", () => {
	it("keeps absolute paths unchanged", () => {
		const absolutePath = path.join(os.tmpdir(), "pi-subagents-abs", "report.md");
		const resolved = resolveSingleOutputPath(absolutePath, "/repo", "/override");
		assert.equal(resolved, absolutePath);
	});

	it("resolves relative paths against requested cwd", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested");
		assert.equal(resolved, path.resolve("/requested", "reviews/report.md"));
	});

	it("resolves relative paths against runtime cwd when requested cwd is absent", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime");
		assert.equal(resolved, path.resolve("/runtime", "reviews/report.md"));
	});

	it("resolves relative requested cwd from runtime cwd before resolving output", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "nested/work");
		assert.equal(resolved, path.resolve("/runtime", "nested/work", "reviews/report.md"));
	});

	it("rejects relative output paths that escape their base directory", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-base-"));
		tempDirs.push(base);
		assert.throws(
			() => resolveSingleOutputPath("../outside.md", base),
			/Relative output path escapes its base directory/,
		);
	});

	it("allows in-base names that merely start with two dots", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-dot-name-"));
		tempDirs.push(base);
		assert.equal(
			resolveSingleOutputPath("..notes/report.md", base),
			path.join(base, "..notes", "report.md"),
		);
	});

	it("rejects relative output paths through a symlink outside their base directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-symlink-"));
		tempDirs.push(root);
		const base = path.join(root, "base");
		const outside = path.join(root, "outside");
		fs.mkdirSync(base);
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, path.join(base, "linked"));
		assert.throws(
			() => resolveSingleOutputPath("linked/report.md", base),
			/Relative output path escapes its base directory through a symlink/,
		);
	});

	it("rejects dangling output symlinks that point outside the base directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-dangling-symlink-"));
		tempDirs.push(root);
		const base = path.join(root, "base");
		fs.mkdirSync(base);
		fs.symlinkSync(path.join(root, "missing-outside.md"), path.join(base, "report.md"));
		assert.throws(
			() => resolveSingleOutputPath("report.md", base),
			/Relative output path escapes its base directory through a symlink/,
		);
	});
});

describe("injectSingleOutputInstruction", () => {
	it("appends output instruction with resolved path", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md");
		assert.match(output, /Write your findings to: \/tmp\/report.md/);
	});
});

describe("resolveSingleOutput", () => {
	it("keeps agent-written file content when the file changed during the run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.writeFileSync(outputPath, "real file content", "utf-8");

		const result = resolveSingleOutput(outputPath, "receipt text", before);
		assert.equal(result.fullOutput, "real file content");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting the assistant output when the file was not changed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");

		fs.writeFileSync(outputPath, "stale content", "utf-8");
		const before = captureSingleOutputSnapshot(outputPath);
		const result = resolveSingleOutput(outputPath, "fresh assistant output", before);

		assert.equal(result.fullOutput, "fresh assistant output");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("preserves read errors from changed output paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.mkdirSync(outputPath);
		const result = resolveSingleOutput(outputPath, "fallback output", before);

		assert.equal(result.fullOutput, "fallback output");
		assert.equal(result.savedPath, undefined);
		assert.match(result.saveError ?? "", /Failed to read changed output file/);
	});
});

describe("formatSavedOutputReference", () => {
	it("includes absolute path, human-readable size, and line count", () => {
		const reportPath = path.join(os.tmpdir(), "report.md");
		const ref = formatSavedOutputReference(reportPath, "line 1\nline 2");
		assert.equal(ref.path, path.resolve(reportPath));
		assert.equal(ref.bytes, Buffer.byteLength("line 1\nline 2", "utf-8"));
		assert.equal(ref.lines, 2);
		assert.equal(ref.message, `Output saved to: ${ref.path} (13 B, 2 lines). Read this file if needed.`);
	});

	it("formats larger byte sizes in KB", () => {
		const ref = formatSavedOutputReference("/tmp/large.md", "a".repeat(49_357));
		assert.match(ref.message, /\(48\.2 KB, 1 line\)/);
	});
});

describe("validateFileOnlyOutputMode", () => {
	it("requires an output path for file-only mode", () => {
		assert.match(validateFileOnlyOutputMode("file-only", undefined, "Single run") ?? "", /Single run sets outputMode: "file-only"/);
		assert.equal(validateFileOnlyOutputMode("file-only", "/tmp/report.md", "Single run"), undefined);
		assert.equal(validateFileOnlyOutputMode("inline", undefined, "Single run"), undefined);
	});
});

describe("finalizeSingleOutput", () => {
	it("formats saved-path messaging around the already-resolved output", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			truncatedOutput: "[TRUNCATED]\nline 1",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 0,
		});

		assert.match(result.displayOutput, /^\[TRUNCATED\]\nline 1/);
		assert.match(result.displayOutput, /Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("returns only the saved-output reference in file-only mode", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			outputMode: "file-only",
			exitCode: 0,
		});

		assert.doesNotMatch(result.displayOutput, /line 1/);
		assert.match(result.displayOutput, /^Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("does not add save messaging on failed runs", () => {
		const result = finalizeSingleOutput({
			fullOutput: "full output",
			truncatedOutput: "truncated output",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 1,
		});

		assert.equal(result.displayOutput, "truncated output");
	});
});

describe("singleOutputWasProduced", () => {
	function tmp(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-produced-"));
		tempDirs.push(dir);
		return dir;
	}

	it("returns false when no output path is declared", () => {
		assert.equal(singleOutputWasProduced(undefined, undefined), false);
	});

	it("returns false when the file does not exist", () => {
		const file = path.join(tmp(), "plan.md");
		assert.equal(singleOutputWasProduced(file, { exists: false }), false);
	});

	it("returns false when the file exists but is empty", () => {
		const file = path.join(tmp(), "plan.md");
		fs.writeFileSync(file, "");
		assert.equal(singleOutputWasProduced(file, { exists: false }), false);
	});

	it("returns true when a non-empty file is newly created during the run", () => {
		const file = path.join(tmp(), "plan.md");
		const before = captureSingleOutputSnapshot(file);
		fs.writeFileSync(file, "# Plan\n\nbody");
		assert.equal(singleOutputWasProduced(file, before), true);
	});

	it("returns false when an existing file is unchanged", () => {
		const file = path.join(tmp(), "plan.md");
		fs.writeFileSync(file, "stable");
		const before = captureSingleOutputSnapshot(file);
		assert.equal(singleOutputWasProduced(file, before), false);
	});
});
