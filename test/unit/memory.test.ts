import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMemoryDir, readMemoryIndex, buildMemoryBlock, isUnsafeName } from "../../src/shared/memory.ts";

describe("memory", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("isUnsafeName", () => {
		it("rejects path traversal", () => {
			assert.ok(isUnsafeName("../../etc", tmpDir));
			assert.ok(isUnsafeName("agent/../../../etc", tmpDir));
		});
		it("accepts normal names", () => {
			assert.ok(!isUnsafeName("scout", tmpDir));
			assert.ok(!isUnsafeName("my-agent", tmpDir));
		});
	});

	describe("resolveMemoryDir", () => {
		it("resolves project scope under .pi/agent-memory/", () => {
			const dir = resolveMemoryDir("scout", "project", tmpDir);
			assert.ok(dir.includes(".pi"), "project scope should use .pi");
			assert.ok(dir.includes("agent-memory"), "should contain agent-memory");
			assert.ok(dir.endsWith("scout"), "should end with agent name");
		});
		it("throws on unsafe agent name", () => {
			assert.throws(() => resolveMemoryDir("../../../etc", "project", tmpDir));
		});
	});

	describe("readMemoryIndex", () => {
		it("returns undefined when no MEMORY.md exists", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			assert.equal(readMemoryIndex(memoryDir), undefined);
		});
		it("returns content when MEMORY.md exists", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Memory\n- Found auth in src/auth/");
			const content = readMemoryIndex(memoryDir);
			assert.ok(content);
			assert.ok(content.includes("Found auth"));
		});
		it("truncates at 200 lines", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			fs.mkdirSync(memoryDir, { recursive: true });
			const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`);
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), lines.join("\n"));
			const content = readMemoryIndex(memoryDir);
			const contentLines = content!.split("\n");
			assert.equal(contentLines.length, 202, "expected 200 content lines + 2 truncation notice lines");
		});
		it("rejects symlinked directories", () => {
			const memoryDir = path.join(tmpDir, "agent-memory", "test-agent");
			const targetDir = path.join(tmpDir, "real-agent-memory");
			fs.mkdirSync(targetDir, { recursive: true });
			fs.mkdirSync(path.dirname(memoryDir), { recursive: true });
			fs.symlinkSync(targetDir, memoryDir);
			assert.equal(readMemoryIndex(memoryDir), undefined);
		});
	});

	describe("buildMemoryBlock", () => {
		it("returns undefined when memory is not configured", () => {
			assert.equal(buildMemoryBlock(undefined, "scout", tmpDir), undefined);
		});
		it("returns instructions when memory dir is empty", () => {
			const block = buildMemoryBlock("project", "scout", tmpDir);
			assert.ok(block);
			assert.ok(block.includes("MEMORY.md"), "should mention MEMORY.md");
		});
		it("returns existing memory content", () => {
			const memoryDir = resolveMemoryDir("scout", "project", tmpDir);
			fs.mkdirSync(memoryDir, { recursive: true });
			fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Memory\n- Found auth in src/auth/");
			const block = buildMemoryBlock("project", "scout", tmpDir);
			assert.ok(block);
			assert.ok(block.includes("Found auth"));
		});
		it("marks read-only when readOnly is true", () => {
			const block = buildMemoryBlock("project", "scout", tmpDir, true);
		assert.ok(block!.includes("READ-ONLY"), "should indicate read-only");
		});
	});
});
