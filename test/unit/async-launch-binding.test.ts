import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveAsyncOmLaunchManifest } from "../../src/runs/foreground/subagent-executor.ts";
import type { NestedRouteInfo } from "../../src/shared/types.ts";
import {
	ASYNC_OM_CONSUMER_ID,
	ASYNC_OM_CONTRACT_VERSION,
	ASYNC_OM_DELIVERY_PREFIX,
	ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION,
} from "../../src/shared/types.ts";
import {
	ASYNC_OM_MANIFEST_DIRECTORY,
	ASYNC_OM_MANIFEST_FILENAME,
	buildLaunchManifest,
	generateDeliveryId,
	generateRunNonce,
	persistLaunchManifest,
} from "../../src/runs/background/async-launch-binding.ts";

interface MockCtx {
	cwd: string;
	sessionManager: {
		getSessionFile(): string | undefined;
		getHeader(): { id: string } | null;
		getBranch(fromId?: string): Array<{ id: string; parentId: string | null }>;
		getLeafId(): string | null;
	};
}

function makeMockCtx(overrides: Partial<MockCtx> = {}): MockCtx {
	return {
		cwd: "/repo",
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getHeader: () => ({ id: "header-abc" }),
			getBranch: () => [
				{ id: "leaf-1", parentId: "mid-1" },
				{ id: "mid-1", parentId: "root-1" },
				{ id: "root-1", parentId: null },
			],
			getLeafId: () => "leaf-1",
		},
		...overrides,
	};
}

function buildManifest() {
	const manifest = buildLaunchManifest(
		makeMockCtx(),
		"run-7",
		[
			{ logicalChildKey: "root/0/sequential/0", agentName: "worker" },
			{ logicalChildKey: "root/1/parallel/0", agentName: "worker" },
		],
	);
	assert.ok(manifest);
	return manifest;
}

describe("async-launch-binding", () => {
	describe("generateRunNonce", () => {
		it("returns a valid UUID", () => {
			assert.match(generateRunNonce(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		});
	});

	describe("generateDeliveryId", () => {
		it("uses the exact three-part contract", () => {
			assert.equal(generateDeliveryId("nonce-123", "c000001"), `${ASYNC_OM_DELIVERY_PREFIX}:nonce-123:c000001`);
		});
	});

	describe("buildLaunchManifest", () => {
		it("captures origin binding and unique static slots for repeated agents", () => {
			const manifest = buildManifest();
			assert.equal(manifest.schemaVersion, ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION);
			assert.equal(manifest.consumer.consumerId, ASYNC_OM_CONSUMER_ID);
			assert.equal(manifest.consumer.contractVersion, ASYNC_OM_CONTRACT_VERSION);
			assert.equal(manifest.consumer.originParent.sessionHeaderId, "header-abc");
			assert.equal(manifest.consumer.originParent.rootEntryId, "root-1");
			assert.deepEqual(Object.values(manifest.childSlots).map((slot) => slot.childId), ["c000001", "c000002"]);
			assert.deepEqual(Object.values(manifest.childSlots).map((slot) => slot.agentName), ["worker", "worker"]);
			assert.equal(manifest.nextChildSequence, 3);
		});

		it("declines registration when parent session binding is incomplete", () => {
			const ctx = makeMockCtx({
				sessionManager: { ...makeMockCtx().sessionManager, getSessionFile: () => undefined },
			});
			assert.equal(buildLaunchManifest(ctx, "run-7", []), null);
		});

		it("rejects duplicate structural child-slot keys", () => {
			assert.throws(() => buildLaunchManifest(makeMockCtx(), "run-7", [
				{ logicalChildKey: "root/0/sequential/0", agentName: "worker" },
				{ logicalChildKey: "root/0/sequential/0", agentName: "worker" },
			]), /Duplicate async OM child slot key/);
		});
	});

	describe("resolveAsyncOmLaunchManifest", () => {
		it("honors the injected consumer for a top-level route and declines an inherited route", () => {
			const ctx = { sessionManager: makeMockCtx().sessionManager } as unknown as ExtensionContext;
			const params = { __asyncCompletionConsumers: ["observational-memory"] };
			assert.ok(resolveAsyncOmLaunchManifest(params, undefined, ctx, "/repo", "run-7", []));
			assert.equal(resolveAsyncOmLaunchManifest(params, {} as NestedRouteInfo, ctx, "/repo", "run-7", []), undefined);
		});
	});

	describe("persistLaunchManifest", () => {
		let tmpDir = "";

		afterEach(() => {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("uses a dedicated owner-only child directory beneath a 0755 async directory", () => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-manifest-"));
			const asyncDir = path.join(tmpDir, "async-run");
			fs.mkdirSync(asyncDir, { mode: 0o755 });
			fs.chmodSync(asyncDir, 0o755);

			const manifestPath = persistLaunchManifest(asyncDir, buildManifest());
			assert.ok(manifestPath);
			assert.equal(manifestPath, path.join(asyncDir, ASYNC_OM_MANIFEST_DIRECTORY, ASYNC_OM_MANIFEST_FILENAME));
			assert.equal(fs.statSync(path.dirname(manifestPath)).mode & 0o777, 0o700);
			assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).runId, "run-7");
		});

		it("declines OM persistence when its dedicated directory is not fresh", () => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-manifest-"));
			const asyncDir = path.join(tmpDir, "async-run");
			fs.mkdirSync(path.join(asyncDir, ASYNC_OM_MANIFEST_DIRECTORY), { recursive: true, mode: 0o755 });
			assert.equal(persistLaunchManifest(asyncDir, buildManifest()), undefined);
		});
	});
});
