import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	CONFIG_KEYWORDS,
	seedModelLanesIfMissing,
	selectEditorArgv,
	openSettingsInEditor,
} from "../../src/slash/subagents-config.ts";
import { writeSettingsFile } from "../../src/agents/agents.ts";

let tempDir = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

function settingsPath(): string {
	return path.join(tempDir, "settings.json");
}

function writeSettings(value: unknown): void {
	fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
	fs.writeFileSync(settingsPath(), JSON.stringify(value, null, 2), "utf-8");
}

function readSettings(): unknown {
	return JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-cfg-"));
	process.env.HOME = tempDir;
	process.env.USERPROFILE = tempDir;
	delete process.env.VISUAL;
	delete process.env.EDITOR;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalVisual === undefined) delete process.env.VISUAL;
	else process.env.VISUAL = originalVisual;
	if (originalEditor === undefined) delete process.env.EDITOR;
	else process.env.EDITOR = originalEditor;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("CONFIG_KEYWORDS", () => {
	it("matches config, json, and edit", () => {
		assert.ok(CONFIG_KEYWORDS.has("config"));
		assert.ok(CONFIG_KEYWORDS.has("json"));
		assert.ok(CONFIG_KEYWORDS.has("edit"));
	});

	it("does not match empty string or hub trigger", () => {
		assert.ok(!CONFIG_KEYWORDS.has(""));
		assert.ok(!CONFIG_KEYWORDS.has("worker"));
		assert.ok(!CONFIG_KEYWORDS.has("run"));
	});
});

describe("selectEditorArgv", () => {
	it("prefers VISUAL over EDITOR", () => {
		process.env.VISUAL = "/usr/bin/vim";
		process.env.EDITOR = "/usr/bin/nano";
		const [editor] = selectEditorArgv("/some/path.json");
		assert.equal(editor, "/usr/bin/vim");
	});

	it("falls back to EDITOR when VISUAL is absent", () => {
		delete process.env.VISUAL;
		process.env.EDITOR = "/usr/bin/code";
		const [editor] = selectEditorArgv("/some/path.json");
		assert.equal(editor, "/usr/bin/code");
	});

	it("falls back to nano when neither is set", () => {
		delete process.env.VISUAL;
		delete process.env.EDITOR;
		const [editor] = selectEditorArgv("/some/path.json");
		assert.equal(editor, "nano");
	});

	it("passes settings path as second argv element", () => {
		const [, filePath] = selectEditorArgv("/my/settings.json");
		assert.equal(filePath, "/my/settings.json");
	});

	it("keeps editor arguments as argv tokens before the settings path", () => {
		process.env.VISUAL = "code --wait";
		assert.deepEqual(selectEditorArgv("/my/settings.json"), ["code", "--wait", "/my/settings.json"]);
	});
});

describe("seedModelLanesIfMissing", () => {
	it("seeds modelLanes when settings file does not exist", () => {
		const sp = settingsPath();
		const { changed } = seedModelLanesIfMissing(sp);
		assert.ok(changed);
		const result = readSettings() as Record<string, unknown>;
		const sub = result.subagents as Record<string, unknown>;
		assert.ok(sub, "subagents should exist");
		assert.ok(sub.modelLanes, "modelLanes should exist");
	});

	it("seeds modelLanes when settings has no subagents key", () => {
		writeSettings({ other: true });
		const { changed } = seedModelLanesIfMissing(settingsPath());
		assert.ok(changed);
		const result = readSettings() as Record<string, unknown>;
		// other key preserved
		assert.equal((result as { other?: boolean }).other, true);
		const sub = (result as { subagents?: Record<string, unknown> }).subagents;
		assert.ok(sub?.modelLanes, "modelLanes should be seeded");
	});

	it("seeds modelLanes when subagents exists but modelLanes is missing", () => {
		writeSettings({
			subagents: {
				agentOverrides: {
					worker: { model: "existing/model" },
				},
			},
		});
		const { changed } = seedModelLanesIfMissing(settingsPath());
		assert.ok(changed);
		const result = readSettings() as {
			subagents?: { agentOverrides?: unknown; modelLanes?: unknown };
		};
		// agentOverrides preserved
		const overrides = result.subagents?.agentOverrides as Record<string, unknown>;
		assert.deepEqual(overrides.worker, { model: "existing/model" });
		// modelLanes seeded
		assert.ok(result.subagents?.modelLanes, "modelLanes should be seeded");
	});

	it("does not overwrite existing modelLanes", () => {
		const existingLanes = { oracle: { fast: { model: "custom/oracle-fast" } } };
		writeSettings({ subagents: { modelLanes: existingLanes } });
		const { changed } = seedModelLanesIfMissing(settingsPath());
		assert.ok(!changed);
		const result = readSettings() as {
			subagents?: { modelLanes?: unknown };
		};
		assert.deepEqual(result.subagents?.modelLanes, existingLanes);
	});

	it("returns changed=false when modelLanes already present", () => {
		writeSettings({ subagents: { modelLanes: { worker: {} } } });
		const { changed } = seedModelLanesIfMissing(settingsPath());
		assert.ok(!changed);
	});

	it("refuses to replace invalid subagents values", () => {
		writeSettings({ subagents: ["invalid"], other: true });
		assert.throws(
			() => seedModelLanesIfMissing(settingsPath()),
			/subagents must be an object/,
		);
		assert.deepEqual(readSettings(), { subagents: ["invalid"], other: true });
	});

	it("seeds worker normal/hard skeleton", () => {
		const sp = settingsPath();
		seedModelLanesIfMissing(sp);
		const result = readSettings() as {
			subagents?: { modelLanes?: { worker?: { normal?: unknown; hard?: unknown } } };
		};
		assert.ok(result.subagents?.modelLanes?.worker?.normal, "worker.normal should exist");
		assert.ok(result.subagents?.modelLanes?.worker?.hard, "worker.hard should exist");
	});
});

describe("openSettingsInEditor", () => {
	it("returns an error when the editor is not found", () => {
		// Use a clearly nonexistent editor path.
		process.env.VISUAL = "/nonexistent-editor-that-does-not-exist-9999";
		const result = openSettingsInEditor(settingsPath());
		assert.ok(result.error !== null, "should return an error for missing editor");
		assert.ok(
			result.error.includes("nonexistent-editor"),
			"error should mention the editor name",
		);
	});

	it("returns settingsPath regardless of editor success or failure", () => {
		process.env.VISUAL = "/nonexistent-editor-that-does-not-exist-9999";
		const result = openSettingsInEditor(settingsPath());
		assert.equal(result.settingsPath, settingsPath());
	});

	it("returns error=null when editor exits cleanly", () => {
		process.env.VISUAL = `${process.execPath} -e process.exit(0)`;
		const sp = settingsPath();
		fs.writeFileSync(sp, "{}\n", "utf-8");
		const result = openSettingsInEditor(sp);
		assert.equal(result.error, null);
	});
});

describe("writeSettingsFile", () => {
	const modeOf = (p: string): number => fs.statSync(p).mode & 0o7777;

	it("preserves restrictive permissions of an existing settings file", { skip: process.platform === "win32" }, () => {
		const sp = settingsPath();
		writeSettings({ keep: true });
		fs.chmodSync(sp, 0o600);
		writeSettingsFile(sp, { keep: true, added: 1 });
		assert.equal(modeOf(sp), 0o600, "atomic replace must not widen a 0600 settings file");
		assert.deepEqual(readSettings(), { keep: true, added: 1 });
	});

	it("creates a new file with default permissions and parent directory", () => {
		const sp = path.join(tempDir, "nested", "dir", "settings.json");
		writeSettingsFile(sp, { fresh: true });
		assert.deepEqual(JSON.parse(fs.readFileSync(sp, "utf-8")), { fresh: true });
		assert.ok(fs.readFileSync(sp, "utf-8").endsWith("\n"), "file must end with trailing newline");
	});

	it("leaves no temp file behind after a successful write", () => {
		const sp = settingsPath();
		writeSettings({ a: 1 });
		writeSettingsFile(sp, { a: 2 });
		const leftovers = fs.readdirSync(tempDir).filter((n) => n.includes(".tmp."));
		assert.deepEqual(leftovers, []);
	});
});