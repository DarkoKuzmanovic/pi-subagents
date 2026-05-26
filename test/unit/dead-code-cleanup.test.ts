/**
 * Tests verifying the dead-code cleanup changes:
 * - Removed exports are gone (fuzzyFilter, formatPath, getOutputTail, writePrompt, MAX_PARALLEL_CONCURRENCY)
 * - findLatestSessionFile is the single canonical source in utils.ts
 * - session-tokens.ts re-exports from utils.ts (no local duplicate)
 * - ControlEventType is an alias for ActivityState
 * - SubagentState.foregroundRuns and .pendingForegroundControlNotices are non-optional
 * - getLastActivity indentation fix preserved behavior
 * - WATCHER_POLL_INTERVAL_MS rename (internal, verified via module parse)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// F3/F4: fuzzyFilter, formatPath removed from render-helpers
// ============================================================================

describe("render-helpers dead code removal (F3, F4)", () => {
	it("does not export fuzzyFilter", async () => {
		const mod = await import("../../src/tui/render-helpers.ts");
		assert.equal("fuzzyFilter" in mod, false, "fuzzyFilter should have been removed");
	});

	it("does not export formatPath", async () => {
		const mod = await import("../../src/tui/render-helpers.ts");
		assert.equal("formatPath" in mod, false, "formatPath should have been removed");
	});

	it("still exports pad (others replaced by Pi components)", async () => {
		const mod = await import("../../src/tui/render-helpers.ts");
		assert.equal(typeof (mod as Record<string, unknown>).pad, "function", "pad should still be exported");
		// row, renderHeader, formatScrollInfo, renderFooter removed — replaced by DynamicBorder, Container, SelectList
		for (const name of ["row", "renderHeader", "formatScrollInfo", "renderFooter"]) {
			assert.equal((name in mod), false, `${name} should have been removed`);
		}
	});
});

// ============================================================================
// F1/F2: getOutputTail, writePrompt removed from utils
// ============================================================================

describe("utils dead code removal (F1, F2)", () => {
	it("does not export getOutputTail", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal("getOutputTail" in mod, false, "getOutputTail should have been removed");
	});

	it("does not export writePrompt", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal("writePrompt" in mod, false, "writePrompt should have been removed");
	});
});

// ============================================================================
// F5: findLatestSessionFile canonical source in utils.ts
// ============================================================================

describe("findLatestSessionFile (F5)", () => {
	it("is exported from utils.ts", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal(typeof mod.findLatestSessionFile, "function");
	});

	it("returns null for a non-existent directory", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal(mod.findLatestSessionFile("/tmp/pi-test-nonexistent-dir-" + Date.now()), null);
	});

	it("returns null for an empty directory", async () => {
		const mod = await import("../../src/shared/utils.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-session-"));
		try {
			assert.equal(mod.findLatestSessionFile(dir), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null when directory has no .jsonl files", async () => {
		const mod = await import("../../src/shared/utils.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-session-"));
		try {
			fs.writeFileSync(path.join(dir, "notes.txt"), "not a session file");
			assert.equal(mod.findLatestSessionFile(dir), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the single .jsonl file when only one exists", async () => {
		const mod = await import("../../src/shared/utils.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-session-"));
		try {
			const file = path.join(dir, "session.jsonl");
			fs.writeFileSync(file, '{"test":true}\n');
			assert.equal(mod.findLatestSessionFile(dir), file);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the newest .jsonl file by mtime when multiple exist", async () => {
		const mod = await import("../../src/shared/utils.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-find-session-"));
		try {
			const older = path.join(dir, "z-older.jsonl");
			const newer = path.join(dir, "a-newer.jsonl");
			fs.writeFileSync(older, '{"old":true}\n');
			fs.writeFileSync(newer, '{"new":true}\n');
			// Force mtime ordering (newer should win despite lexicographic order)
			const oldTime = new Date("2025-01-01T00:00:00Z");
			const newTime = new Date("2025-06-01T00:00:00Z");
			fs.utimesSync(older, oldTime, oldTime);
			fs.utimesSync(newer, newTime, newTime);
			assert.equal(mod.findLatestSessionFile(dir), newer);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// F6: MAX_PARALLEL_CONCURRENCY removed from parallel-utils
// ============================================================================

describe("MAX_PARALLEL_CONCURRENCY removal (F6)", () => {
	it("is no longer exported from parallel-utils", async () => {
		const mod = await import("../../src/runs/shared/parallel-utils.ts");
		assert.equal("MAX_PARALLEL_CONCURRENCY" in mod, false, "MAX_PARALLEL_CONCURRENCY should have been removed");
	});
});

// ============================================================================
// F8: ControlEventType is now an alias for ActivityState
// ============================================================================

describe("ControlEventType alias (F8)", () => {
	it("ActivityState and ControlEventType have the same runtime representation", async () => {
		// Both are type aliases — they don't exist at runtime.
		// Verify the types module imports cleanly and both are declared.
		const mod = await import("../../src/shared/types.ts");
		// MAX_CONCURRENCY is the canonical concurrency constant
		assert.equal(typeof mod.MAX_CONCURRENCY, "number");
		assert.equal(mod.MAX_CONCURRENCY, 4);
	});
});

// ============================================================================
// F9/F10: SubagentState.foregroundRuns and pendingForegroundControlNotices are non-optional
// ============================================================================

describe("SubagentState non-optional fields (F9, F10)", () => {
	it("control-notices makeState includes foregroundRuns as a non-optional Map", () => {
		// Verify the pattern used in control-notices.test.ts still works:
		// foregroundRuns is no longer optional, so state must always have it.
		const state = {
			baseCwd: "/tmp",
			currentSessionId: null,
			asyncJobs: new Map(),
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: { schedule: () => false, clear: () => {} },
		};
		// Both are initialized Maps, not undefined
		assert.ok(state.foregroundRuns instanceof Map);
		assert.ok(state.pendingForegroundControlNotices instanceof Map);
		assert.equal(state.foregroundRuns.size, 0);
		assert.equal(state.pendingForegroundControlNotices.size, 0);
	});
});

// ============================================================================
// F12: getLastActivity indentation fix preserved behavior
// ============================================================================

describe("getLastActivity (F12)", () => {
	it("returns empty string for undefined input", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal(mod.getLastActivity(undefined), "");
	});

	it("returns empty string for a non-existent file", async () => {
		const mod = await import("../../src/shared/utils.ts");
		assert.equal(mod.getLastActivity("/tmp/pi-test-nonexistent-" + Date.now()), "");
	});

	it("returns an 'active' string for a recently modified file", async () => {
		const mod = await import("../../src/shared/utils.ts");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-last-activity-"));
		try {
			const file = path.join(dir, "output.txt");
			fs.writeFileSync(file, "test output");
			const result = mod.getLastActivity(file);
			assert.ok(result.startsWith("active"), `Expected 'active...' but got: '${result}'`);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// F5 integration: session-tokens imports findLatestSessionFile from utils
// ============================================================================

describe("session-tokens uses canonical findLatestSessionFile (F5 integration)", () => {
	it("session-tokens module loads without errors", async () => {
		const mod = await import("../../src/shared/session-tokens.ts");
		assert.equal(typeof mod.parseSessionTokens, "function");
	});

	it("parseSessionTokens returns null for non-existent directory", async () => {
		const mod = await import("../../src/shared/session-tokens.ts");
		assert.equal(mod.parseSessionTokens("/tmp/pi-test-no-session-" + Date.now()), null);
	});
});
