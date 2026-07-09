import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeDurableJson } from "../../shared/durable-json.ts";
import {
	ASYNC_OM_CONSUMER_ID,
	ASYNC_OM_CONTRACT_VERSION,
	ASYNC_OM_DELIVERY_PREFIX,
	ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION,
} from "../../shared/types.ts";
import type {
	AsyncChildSlotV1,
	AsyncOmConsumerRegistrationV1,
	AsyncOmLaunchManifestV1,
	OriginParentBindingV1,
} from "../../shared/types.ts";

export const ASYNC_OM_MANIFEST_DIRECTORY = "om-launch-manifest";
export const ASYNC_OM_MANIFEST_FILENAME = "async-om-launch.json";

/** Minimal session-manager subset needed for launch binding capture. */
export interface LaunchBindingSessionManager {
	getSessionFile(): string | undefined;
	getHeader(): { id: string } | null;
	getBranch(fromId?: string): Array<{ id: string; parentId: string | null }>;
	getLeafId(): string | null;
}

/** Context needed to build the origin-parent binding. */
export interface LaunchBindingContext {
	cwd: string;
	sessionManager: LaunchBindingSessionManager;
}

/** A statically known child execution, identified by its structural plan location. */
export interface StaticAsyncChildDescriptor {
	logicalChildKey: string;
	agentName: string;
}

/** Generate a cryptographically random UUID as the run nonce. */
export function generateRunNonce(): string {
	return randomUUID();
}

/** Generate a stable per-child delivery id from a persisted child slot. */
export function generateDeliveryId(runNonce: string, childId: string): string {
	return `${ASYNC_OM_DELIVERY_PREFIX}:${runNonce}:${childId}`;
}

/**
 * Build the immutable pre-detach manifest. A `null` result means the caller
 * must skip OM registration and proceed with ordinary async dispatch.
 */
export function buildLaunchManifest(
	ctx: LaunchBindingContext,
	runId: string,
	staticChildren: StaticAsyncChildDescriptor[],
): AsyncOmLaunchManifestV1 | null {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return null;

	const header = ctx.sessionManager.getHeader();
	if (!header?.id) return null;

	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) return null;

	const rootEntry = ctx.sessionManager.getBranch().find((entry) => entry.parentId === null);
	if (!rootEntry) return null;

	const originParent: OriginParentBindingV1 = {
		sessionFile,
		sessionHeaderId: header.id,
		rootEntryId: rootEntry.id,
		launchLeafId: leafId,
		launchCwd: ctx.cwd,
	};
	const consumer: AsyncOmConsumerRegistrationV1 = {
		consumerId: ASYNC_OM_CONSUMER_ID,
		contractVersion: ASYNC_OM_CONTRACT_VERSION,
		originParent,
	};
	const runNonce = generateRunNonce();
	const childSlots: Record<string, AsyncChildSlotV1> = {};

	for (const [index, child] of staticChildren.entries()) {
		if (childSlots[child.logicalChildKey]) {
			throw new Error(`Duplicate async OM child slot key: ${child.logicalChildKey}`);
		}
		childSlots[child.logicalChildKey] = {
			logicalChildKey: child.logicalChildKey,
			childId: formatChildId(index + 1),
			agentName: child.agentName,
			allocation: "static",
		};
	}

	return {
		schemaVersion: ASYNC_OM_LAUNCH_MANIFEST_SCHEMA_VERSION,
		runId,
		runNonce,
		consumer,
		nextChildSequence: staticChildren.length + 1,
		childSlots,
	};
}

/**
 * Persist the launch manifest before the runner is detached. It deliberately
 * uses an owner-only child directory because ASYNC_DIR and each async run
 * directory may have broader permissions. A failure or degraded directory
 * sync returns `undefined`; callers must continue normal async dispatch
 * without registering the OM consumer.
 */
export function persistLaunchManifest(
	asyncDir: string,
	manifest: AsyncOmLaunchManifestV1,
): string | undefined {
	try {
		const manifestDir = path.join(asyncDir, ASYNC_OM_MANIFEST_DIRECTORY);
		fs.mkdirSync(manifestDir, { mode: 0o700 });
		const manifestPath = path.join(manifestDir, ASYNC_OM_MANIFEST_FILENAME);
		const result = writeDurableJson(manifestPath, manifest);
		if (result.status === "committed") return manifestPath;
		return undefined;
	} catch {
		return undefined;
	}
}

function formatChildId(sequence: number): string {
	return `c${String(sequence).padStart(6, "0")}`;
}
