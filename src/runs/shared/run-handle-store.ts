/**
 * Durable run-handle store (M12.3).
 *
 * Records run identity at launch so the parent can recover handles after an
 * extension reload or parent crash, when in-memory state (foregroundControls,
 * asyncJobs) is empty. Each handle is a small JSON file under
 * TEMP_ROOT_DIR/run-handles/, written atomically with owner-only permissions.
 *
 * Recovery validates liveness: foreground handles check PID, async handles
 * check the async directory, nested handles check the route directory. Stale
 * handles return undefined and are not silently treated as live.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRouteInfo } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { isSafeNestedPathId } from "./nested-path.ts";

export const RUN_HANDLES_DIR = path.join(TEMP_ROOT_DIR, "run-handles");

export type RunHandleKind = "foreground" | "async" | "nested";

export interface RunHandleRecord {
	/** Schema version for forward compatibility. */
	schemaVersion: 2;
	/** Record type discriminator. */
	type: "subagent.run-handle";
	/** The run id — same as the key used to look it up. */
	id: string;
	/** What kind of run this is. */
	kind: RunHandleKind;
	/** OS process id, for liveness checking. */
	pid?: number;
	/** Async run directory (async kind only). */
	asyncDir?: string;
	/** Nested route info (nested kind only). */
	route?: NestedRouteInfo;
	/** When the handle was recorded. */
	startedAt: number;
	/** When the handle was last updated (optional, for future use). */
	updatedAt?: number;
}

/** The recovered handle — same shape as ResolvedSubagentRunId fields, plus metadata. */
export interface RecoveredRunHandle {
	id: string;
	kind: RunHandleKind;
	pid?: number;
	asyncDir?: string;
	route?: NestedRouteInfo;
	startedAt: number;
}

function assertSafeHandleId(label: string, value: string): void {
	if (!isSafeNestedPathId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

function handleFilePath(id: string): string {
	return path.join(RUN_HANDLES_DIR, `${id}.json`);
}

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

function isProcessAlive(pid: number, kill: KillFn = process.kill): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseHandleRecord(raw: string, expectedId: string): RunHandleRecord | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<RunHandleRecord>;
		if (parsed.schemaVersion !== 2 || parsed.type !== "subagent.run-handle") return undefined;
		if (typeof parsed.id !== "string" || parsed.id !== expectedId) return undefined;
		if (typeof parsed.kind !== "string") return undefined;
		if (typeof parsed.startedAt !== "number") return undefined;
		const kind = parsed.kind as RunHandleKind;
		if (kind !== "foreground" && kind !== "async" && kind !== "nested") return undefined;

		const record: RunHandleRecord = {
			schemaVersion: 2,
			type: "subagent.run-handle",
			id: parsed.id,
			kind,
			startedAt: parsed.startedAt,
		};
		if (typeof parsed.pid === "number") record.pid = parsed.pid;
		if (typeof parsed.asyncDir === "string") record.asyncDir = parsed.asyncDir;
		if (parsed.route && typeof parsed.route === "object") {
			const route = parsed.route as Partial<NestedRouteInfo>;
			if (
				typeof route.rootRunId === "string" &&
				typeof route.eventSink === "string" &&
				typeof route.controlInbox === "string" &&
				typeof route.capabilityToken === "string"
			) {
				record.route = {
					rootRunId: route.rootRunId,
					eventSink: route.eventSink,
					controlInbox: route.controlInbox,
					capabilityToken: route.capabilityToken,
				};
			}
		}
		if (typeof parsed.updatedAt === "number") record.updatedAt = parsed.updatedAt;
		return record;
	} catch {
		return undefined;
	}
}

function validateLiveness(record: RunHandleRecord): boolean {
	switch (record.kind) {
		case "foreground":
			// Foreground runs are in-process; if the PID is dead, the run is gone.
			if (typeof record.pid === "number" && record.pid > 0) {
				return isProcessAlive(record.pid);
			}
			// No PID recorded — can't verify liveness, treat as stale.
			return false;

		case "async":
			// Async runs have a directory on disk. If the directory exists, the
			// run may still be live (or completed but not yet cleaned up).
			if (record.asyncDir && fs.existsSync(record.asyncDir)) return true;
			// Directory gone — check if there's a result file.
			// If neither exists, the run is stale.
			return false;

		case "nested":
			// Nested runs have a route directory. If the route root exists,
			// the run's registry is still accessible.
			if (record.route) {
				const routeRoot = path.dirname(record.route.eventSink);
				return fs.existsSync(routeRoot);
			}
			return false;
	}
}

/**
 * Record a run handle at launch time. Writes atomically with owner-only
 * permissions so the handle survives extension reload or parent crash.
 */
export function recordRunHandle(input: {
	id: string;
	kind: RunHandleKind;
	pid?: number;
	asyncDir?: string;
	route?: NestedRouteInfo;
	startedAt: number;
	updatedAt?: number;
}): void {
	assertSafeHandleId("id", input.id);

	const record: RunHandleRecord = {
		schemaVersion: 2,
		type: "subagent.run-handle",
		id: input.id,
		kind: input.kind,
		startedAt: input.startedAt,
	};
	if (typeof input.pid === "number") record.pid = input.pid;
	if (typeof input.asyncDir === "string") record.asyncDir = input.asyncDir;
	if (input.route) record.route = input.route;
	if (typeof input.updatedAt === "number") record.updatedAt = input.updatedAt;

	const filePath = handleFilePath(input.id);
	fs.mkdirSync(RUN_HANDLES_DIR, { recursive: true, mode: 0o700 });
	writeAtomicJson(filePath, record);
	// Ensure owner-only permissions on the file (writeAtomicJson doesn't set mode)
	try {
		(fs as unknown as { chmodSync(path: string, mode: number): void }).chmodSync(filePath, 0o600);
	} catch {
		// Best-effort; the directory is already 0700
	}
}

/**
 * Recover a run handle by id. Reads the durable store and validates liveness.
 * Returns undefined if the handle is missing, stale (dead PID, gone directory),
 * or corrupted.
 */
export function recoverRunHandle(id: string): RecoveredRunHandle | undefined {
	assertSafeHandleId("id", id);

	const filePath = handleFilePath(id);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}

	const record = parseHandleRecord(raw, id);
	if (!record) return undefined;

	if (!validateLiveness(record)) return undefined;

	return {
		id: record.id,
		kind: record.kind,
		...(typeof record.pid === "number" ? { pid: record.pid } : {}),
		...(typeof record.asyncDir === "string" ? { asyncDir: record.asyncDir } : {}),
		...(record.route ? { route: record.route } : {}),
		startedAt: record.startedAt,
	};
}

/**
 * Delete a run handle from the durable store. Called on completion or cleanup.
 * Idempotent — does not throw if the handle doesn't exist.
 */
export function deleteRunHandle(id: string): void {
	assertSafeHandleId("id", id);
	try {
		fs.rmSync(handleFilePath(id), { force: true });
	} catch {
		// Idempotent: missing file is fine
	}
}

/**
 * List all handle ids in the durable store. Useful for bulk recovery scans.
 * Does not validate liveness — callers should use recoverRunHandle for that.
 */
export function listRunHandleIds(): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(RUN_HANDLES_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -5))
		.filter((id) => isSafeNestedPathId(id));
}
