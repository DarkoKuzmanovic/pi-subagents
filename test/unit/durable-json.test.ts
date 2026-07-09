import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	resolveDurableRootPath,
	validateDurableRoot,
	writeDurableJson,
} from "../../src/shared/durable-json.ts";

describe("durable json", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-durable-json-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes canonical JSON with fsync, validation, and same-directory temp files", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "nested", "record.json");

		const result = writeDurableJson(filePath, {
			zebra: 1,
			alpha: { delta: 4, bravo: 2 },
			items: [3, { beta: true, alpha: false }],
		});

		assert.equal(result.status, "committed");
		assert.equal(path.dirname(result.tempPath), path.dirname(filePath));
		assert.equal(
			fs.readFileSync(filePath, "utf-8"),
			'{"alpha":{"bravo":2,"delta":4},"items":[3,{"alpha":false,"beta":true}],"zebra":1}',
		);
		assert.equal(result.byteLength, Buffer.byteLength(fs.readFileSync(filePath, "utf-8"), "utf-8"));
		assert.match(result.sha256, /^[a-f0-9]{64}$/);
	});

	it("uses locale-independent code-unit ordering for canonical object keys", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");

		writeDurableJson(filePath, { z: 1, ä: 2, a: 3, Z: 4 });

		assert.equal(fs.readFileSync(filePath, "utf-8"), '{"Z":4,"a":3,"z":1,"ä":2}');
	});

	it("returns a degraded outcome when directory fsync is unsupported", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");
		let fsyncCalls = 0;

		const result = writeDurableJson(filePath, { ok: true }, {
			fsOps: {
				fsyncSync(fd) {
					fsyncCalls += 1;
					if (fsyncCalls === 2) {
						const error = new Error("directory fsync unsupported") as Error & { code?: string };
						error.code = "ENOTSUP";
						throw error;
					}
					return fs.fsyncSync(fd);
				},
			},
		});

		assert.equal(result.status, "degraded");
		assert.equal(result.reason, "directory_fsync_unsupported");
		assert.equal(fs.existsSync(filePath), true);
		assert.match(result.sha256, /^[a-f0-9]{64}$/);
	});

	it("fails when rename cannot commit the temp file", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");

		assert.throws(() => writeDurableJson(filePath, { ok: true }, {
			exclusive: false,
			fsOps: {
				renameSync() {
					throw new Error("rename blocked");
				},
			},
		}), /rename blocked/);
	});

	it("fails when the reopened file hash does not match the canonical payload", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");

		assert.throws(() => writeDurableJson(filePath, { ok: true }, {
			fsOps: {
				readFileSync(targetPath, encoding) {
					if (targetPath === filePath && encoding === "utf-8") return "{\"ok\":false}";
					return fs.readFileSync(targetPath, encoding);
				},
			},
		}), /hash mismatch/i);
	});

	it("does not replace an existing exclusive target", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");
		fs.writeFileSync(filePath, "{\"existing\":true}", "utf-8");

		assert.throws(
			() => writeDurableJson(filePath, { replacement: true }),
			(error: unknown) =>
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				(error as { code?: unknown }).code === "EEXIST",
		);
		assert.equal(fs.readFileSync(filePath, "utf-8"), "{\"existing\":true}");
	});

	it("propagates exclusive publish failures and removes the temporary file", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");
		let tempPath = "";

		assert.throws(() => writeDurableJson(filePath, { ok: true }, {
			fsOps: {
				linkSync(existingPath) {
					tempPath = existingPath;
					throw new Error("exclusive publish blocked");
				},
			},
		}), /exclusive publish blocked/);

		assert.notEqual(tempPath, "");
		assert.equal(fs.existsSync(tempPath), false);
		assert.equal(fs.existsSync(filePath), false);
	});

	it("returns a degraded outcome when opening the directory for fsync is unsupported", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		const filePath = resolveDurableRootPath(root, "record.json");
		let openCalls = 0;

		const result = writeDurableJson(filePath, { ok: true }, {
			fsOps: {
				openSync(targetPath, flags, mode) {
					openCalls += 1;
					if (openCalls === 2) {
						const error = new Error("directory open unsupported") as Error & { code?: string };
						error.code = "ENOTSUP";
						throw error;
					}
					return fs.openSync(targetPath, flags, mode);
				},
			},
		});

		assert.equal(result.status, "degraded");
		assert.equal(result.reason, "directory_fsync_unsupported");
		assert.equal(fs.existsSync(filePath), true);
	});

	it("rejects non-owner-only roots", () => {
		const rootDir = path.join(tempDir, "public-root");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o755 });
		fs.chmodSync(rootDir, 0o755);
		assert.throws(() => validateDurableRoot(rootDir), /owner-only/i);
	});

	it("rejects path traversal outside the canonical root", () => {
		const rootDir = path.join(tempDir, "outbox");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		const root = validateDurableRoot(rootDir);
		assert.throws(() => resolveDurableRootPath(root, "..", "escape.json"), /outside/i);
	});

	it("rejects symlinked descendants", () => {
		const rootDir = path.join(tempDir, "outbox");
		const elsewhere = path.join(tempDir, "elsewhere");
		const linkPath = path.join(rootDir, "linked");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
		fs.symlinkSync(elsewhere, linkPath);
		const root = validateDurableRoot(rootDir);

		assert.throws(() => resolveDurableRootPath(root, "linked", "record.json"), /symlink/i);
	});

	it("rejects a durable root reached through a symlinked ancestor", () => {
		const actualParent = path.join(tempDir, "actual-parent");
		const actualRoot = path.join(actualParent, "root");
		const linkedParent = path.join(tempDir, "linked-parent");
		fs.mkdirSync(actualRoot, { recursive: true, mode: 0o700 });
		fs.symlinkSync(actualParent, linkedParent);

		assert.throws(() => validateDurableRoot(path.join(linkedParent, "root")), /symlink/i);
	});

	it("rejects a durable write path with a symlinked directory ancestor", () => {
		const rootDir = path.join(tempDir, "outbox");
		const elsewhere = path.join(tempDir, "elsewhere");
		const linkedDirectory = path.join(rootDir, "linked");
		fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
		fs.symlinkSync(elsewhere, linkedDirectory);

		assert.throws(
			() => writeDurableJson(path.join(linkedDirectory, "nested", "record.json"), { ok: true }),
			/symlink/i,
		);
	});
});
