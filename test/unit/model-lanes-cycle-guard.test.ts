import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyUserModelLaneMutations, readModelLanesFromSettingsFile } from "../../src/agents/model-lanes.ts";
import type { UserModelLaneMutation } from "../../src/agents/model-lanes.ts";

/**
 * Independent adversarial probe for the cycle-aware lane batch writer.
 *
 * Written by the orchestrator, NOT by the worker that implemented the fix, and
 * deliberately kept in a separate file. A worker that widened the "target is
 * free" relaxation too far would plausibly have relaxed its own tests to match,
 * so these cases exist to be un-negotiated with that implementation.
 *
 * The contract under test:
 *   - a rename target counts as free ONLY when the lane holding it is itself
 *     renamed away by an upsert in the SAME batch;
 *   - a lane freed by a `remove` mutation does NOT qualify;
 *   - every pre-existing rejection still fires;
 *   - every rejection leaves the settings file byte-identical and leaves no
 *     temp file behind.
 */

let tempHome = "";
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function settingsPath(): string {
	return path.join(tempHome, ".pi", "agent", "settings.json");
}

function writeSettings(lanes: Record<string, Record<string, unknown>>): string {
	const filePath = settingsPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(
		filePath,
		JSON.stringify({ theme: "keep-me", subagents: { modelLanes: lanes } }, null, 2),
		"utf-8",
	);
	return fs.readFileSync(filePath, "utf-8");
}

/**
 * Write settings from RAW JSON text.
 *
 * Required for `__proto__` fixtures: an object literal `{ __proto__: {...} }` is
 * prototype-setting syntax, not an own property, so `JSON.stringify` would drop
 * it and the regression would be vacuous. `JSON.parse` of raw text, by contrast,
 * produces `__proto__` as a genuine own property — which is exactly how a legacy
 * or hand-edited settings file reaches the reader.
 */
function writeRawSettings(lanesJson: string): string {
	const filePath = settingsPath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `{\n"theme": "keep-me",\n"subagents": { "modelLanes": ${lanesJson} }\n}`, "utf-8");
	return fs.readFileSync(filePath, "utf-8");
}

function laneMap(): Record<string, Record<string, unknown>> {
	const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
	if (typeof parsed !== "object" || parsed === null) throw new Error("settings not an object");
	const subagents = (parsed as { subagents?: unknown }).subagents;
	if (typeof subagents !== "object" || subagents === null) throw new Error("no subagents");
	const modelLanes = (subagents as { modelLanes?: unknown }).modelLanes;
	if (typeof modelLanes !== "object" || modelLanes === null) throw new Error("no modelLanes");
	const worker = (modelLanes as { worker?: unknown }).worker;
	if (typeof worker !== "object" || worker === null) throw new Error("no worker lanes");
	return worker as Record<string, Record<string, unknown>>;
}

/**
 * Assert the batch throws THE EXPECTED rejection AND the file is byte-identical
 * AND no temp file survives. The expected-message check matters: a bare
 * `assert.throws(fn, /./)` would pass when the batch failed for an unrelated
 * reason, which would make every rejection case below vacuous.
 */
function assertRejected(
	before: string,
	mutations: UserModelLaneMutation[],
	expected: RegExp,
	label: string,
): void {
	assert.throws(() => applyUserModelLaneMutations(mutations), expected, `${label}: expected rejection`);
	assert.equal(fs.readFileSync(settingsPath(), "utf-8"), before, `${label}: file must be byte-identical`);
	const dir = path.dirname(settingsPath());
	const strays = fs.readdirSync(dir).filter((entry) => entry !== "settings.json");
	assert.deepEqual(strays, [], `${label}: no temp file may survive a rejection`);
}

describe("model lane batch — cycle relaxation must not widen rejections", () => {
	beforeEach(() => {
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lane-probe-home-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		fs.rmSync(tempHome, { recursive: true, force: true });
	});

	it("permits a genuine two-lane swap and carries each lane's payload to the right name", () => {
		writeSettings({
			worker: {
				normal: { model: "vendor/cheap", thinking: "low", note: "keep-normal" },
				hard: { model: "vendor/expensive", thinking: "high", note: "keep-hard" },
			},
		});

		applyUserModelLaneMutations([
			{ kind: "upsert", agentName: "worker", laneName: "hard", originalLaneName: "normal", patch: {} },
			{ kind: "upsert", agentName: "worker", laneName: "normal", originalLaneName: "hard", patch: {} },
		]);

		const lanes = laneMap();
		assert.equal(lanes.hard?.model, "vendor/cheap", "old normal payload must land on hard");
		assert.equal(lanes.normal?.model, "vendor/expensive", "old hard payload must land on normal");
		assert.equal(lanes.hard?.note, "keep-normal", "unrelated properties must ride along the rename");
		assert.equal(lanes.normal?.note, "keep-hard");
	});

	it("permits a three-lane cycle", () => {
		writeSettings({ worker: { a: { model: "m/a" }, b: { model: "m/b" }, c: { model: "m/c" } } });

		applyUserModelLaneMutations([
			{ kind: "upsert", agentName: "worker", laneName: "b", originalLaneName: "a", patch: {} },
			{ kind: "upsert", agentName: "worker", laneName: "c", originalLaneName: "b", patch: {} },
			{ kind: "upsert", agentName: "worker", laneName: "a", originalLaneName: "c", patch: {} },
		]);

		const lanes = laneMap();
		assert.equal(lanes.b?.model, "m/a");
		assert.equal(lanes.c?.model, "m/b");
		assert.equal(lanes.a?.model, "m/c");
	});

	it("still rejects two renames converging on one target", () => {
		const before = writeSettings({ worker: { a: { model: "m/a" }, b: { model: "m/b" } } });
		assertRejected(
			before,
			[
				{ kind: "upsert", agentName: "worker", laneName: "x", originalLaneName: "a", patch: {} },
				{ kind: "upsert", agentName: "worker", laneName: "x", originalLaneName: "b", patch: {} },
			],
			/already exists/,
			"converging renames",
		);
	});

	it("still rejects a create colliding with a lane that is NOT renamed away", () => {
		const before = writeSettings({ worker: { keep: { model: "m/keep" }, a: { model: "m/a" } } });
		assertRejected(
			before,
			[{ kind: "upsert", agentName: "worker", laneName: "keep", patch: { model: "m/new" } }],
			/already exists/,
			"create onto non-renamed lane",
		);
	});

	it("still rejects a rename onto a name freed only by a LATER remove", () => {
		const before = writeSettings({ worker: { a: { model: "m/a" }, b: { model: "m/b" } } });
		assertRejected(
			before,
			[
				{ kind: "upsert", agentName: "worker", laneName: "b", originalLaneName: "a", patch: {} },
				{ kind: "remove", agentName: "worker", laneName: "b" },
			],
			/already exists/,
			"rename onto later-removed name",
		);
	});

	it("still rejects an in-place edit whose lane vanished (blocker 2)", () => {
		const before = writeSettings({ worker: { present: { model: "m/present" } } });
		assertRejected(
			before,
			[
				{
					kind: "upsert",
					agentName: "worker",
					laneName: "vanished",
					originalLaneName: "vanished",
					patch: { thinking: "low" },
				},
			],
			/no longer exists/,
			"in-place edit of absent lane",
		);
	});

	it("still rejects a stale remove, including prototype-chain names", () => {
		const before = writeSettings({ worker: { a: { model: "m/a" } } });
		const noSuch = /no such user lane exists/;
		assertRejected(before, [{ kind: "remove", agentName: "worker", laneName: "gone" }], noSuch, "stale remove");
		assertRejected(before, [{ kind: "remove", agentName: "worker", laneName: "__proto__" }], noSuch, "__proto__ remove");
		assertRejected(
			before,
			[{ kind: "remove", agentName: "worker", laneName: "constructor" }],
			noSuch,
			"constructor remove",
		);
	});

	it("allows a lane named 'constructor' to be created and removed", () => {
		writeSettings({ worker: { a: { model: "m/a" } } });
		applyUserModelLaneMutations([
			{ kind: "upsert", agentName: "worker", laneName: "constructor", patch: { model: "m/ctor" } },
		]);
		assert.equal(laneMap().constructor?.model, "m/ctor", "regex-valid name must be creatable");

		applyUserModelLaneMutations([{ kind: "remove", agentName: "worker", laneName: "constructor" }]);
		assert.equal(Object.hasOwn(laneMap(), "constructor"), false, "must be removable again");
	});

	it("round-trips a legacy '__proto__' lane as data on both read and write", () => {
		// JSON.parse yields `__proto__` as an OWN property, so a hand-edited or
		// legacy settings file can genuinely contain this lane. Plain assignment
		// would hit the prototype setter and lose it (or corrupt the map).
		writeRawSettings('{ "worker": { "__proto__": { "model": "m/legacy" }, "keep": { "model": "m/keep" } } }');

		const read = readModelLanesFromSettingsFile(settingsPath());
		const workerLanes = read.worker;
		assert.ok(workerLanes, "worker lanes must parse");
		assert.equal(Object.hasOwn(workerLanes, "__proto__"), true, "reader must keep __proto__ as an own key");
		assert.equal(Object.getPrototypeOf(workerLanes), Object.prototype, "reader must not mutate the prototype");

		// In-place edit of that legacy lane: the create path's regex rejects the
		// name, so this is the only route to it.
		applyUserModelLaneMutations([
			{
				kind: "upsert",
				agentName: "worker",
				laneName: "__proto__",
				originalLaneName: "__proto__",
				patch: { thinking: "low" },
			},
		]);

		const lanes = laneMap();
		assert.equal(Object.hasOwn(lanes, "__proto__"), true, "write must keep __proto__ as an own key");
		assert.equal(Object.getPrototypeOf(lanes), Object.prototype, "write must not mutate the prototype");
		const legacy = Object.getOwnPropertyDescriptor(lanes, "__proto__")?.value as Record<string, unknown>;
		assert.equal(legacy.model, "m/legacy", "unrelated fields survive the in-place edit");
		assert.equal(legacy.thinking, "low", "the patch applied");
		assert.equal(lanes.keep?.model, "m/keep", "sibling lane untouched");
	});

	it("round-trips a legacy '__proto__' AGENT key as data", () => {
		writeRawSettings(
			'{ "__proto__": { "fast": { "model": "m/proto-agent" } }, "worker": { "keep": { "model": "m/keep" } } }',
		);

		const read = readModelLanesFromSettingsFile(settingsPath());
		assert.equal(Object.hasOwn(read, "__proto__"), true, "reader must keep a __proto__ agent as an own key");
		assert.equal(Object.getPrototypeOf(read), Object.prototype, "reader must not mutate the prototype");

		// A write to an unrelated agent must preserve the odd agent key verbatim.
		applyUserModelLaneMutations([
			{ kind: "upsert", agentName: "worker", laneName: "added", patch: { model: "m/added" } },
		]);

		const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
		const subagents = (parsed as { subagents?: { modelLanes?: Record<string, unknown> } }).subagents;
		const modelLanes = subagents?.modelLanes;
		assert.ok(modelLanes, "modelLanes must survive");
		assert.equal(Object.hasOwn(modelLanes, "__proto__"), true, "the __proto__ agent key must survive the write");
		assert.equal(laneMap().added?.model, "m/added", "the intended edit still applied");
	});

	it("rejects a whole cycle batch when one member is invalid, leaving bytes untouched", () => {
		const before = writeSettings({ worker: { a: { model: "m/a" }, b: { model: "m/b" } } });
		assertRejected(
			before,
			[
				{ kind: "upsert", agentName: "worker", laneName: "b", originalLaneName: "a", patch: {} },
				{ kind: "upsert", agentName: "worker", laneName: "a", originalLaneName: "b", patch: { model: "   " } },
			],
			/invalid 'model'/,
			"cycle containing an invalid mutation",
		);
	});
});
