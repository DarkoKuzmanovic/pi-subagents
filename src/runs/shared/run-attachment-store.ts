/**
 * Durable run-attachment store (M12.3).
 *
 * Records parent-side attachments to live runs so the parent can recover its
 * attach set after extension reload. Each attachment is a small JSON file under
 * TEMP_ROOT_DIR/run-attachments/, written with fsynced durable JSON and
 * owner-only permissions.
 *
 * Attach/detach does not send control requests to the child and does not alter
 * the M12.1/M12.2 live-control transport. Detach is idempotent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR, type NestedRouteInfo } from "../../shared/types.ts";
import { writeDurableJson } from "../../shared/durable-json.ts";
import { containedPath, NESTED_EVENTS_DIR } from "./nested-events.ts";
import { isSafeNestedPathId } from "./nested-path.ts";

export const RUN_ATTACHMENTS_DIR = path.join(TEMP_ROOT_DIR, "run-attachments");

export type AttachmentKind = "foreground" | "async" | "nested";

export interface AttachmentRecord {
	/** Schema version for forward compatibility. */
	schemaVersion: 2;
	/** Record type discriminator. */
	type: "subagent.run-attachment";
	/** Stable attachment id (distinct from the run id). */
	attachmentId: string;
	/** The run id this attachment targets. */
	id: string;
	/** What kind of run this is. */
	kind: AttachmentKind;
	/** Nested route info when the attachment is bound to a control route. */
	route?: NestedRouteInfo;
	/** Live-control child key (index as string) for nested/async route owners. */
	childKey?: string;
	/** Owner epoch verified at attach time. */
	epoch?: string;
	/** When the attachment was recorded. */
	attachedAt: number;
	/** Attachment lifecycle state. */
	state: "attached";
	/** Optional human note (e.g. "foreground, in-memory"). */
	note?: string;
}

/** Public attachment handle returned by attach/recover. */
export interface Attachment {
	attachmentId: string;
	id: string;
	kind: AttachmentKind;
	route?: NestedRouteInfo;
	childKey?: string;
	epoch?: string;
	attachedAt: number;
	state: "attached";
	note?: string;
}

function assertSafeAttachmentId(label: string, value: string): void {
	if (!isSafeNestedPathId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

function attachmentFilePath(attachmentId: string): string {
	return path.join(RUN_ATTACHMENTS_DIR, `${attachmentId}.json`);
}

function assertPathContainment(record: Pick<AttachmentRecord, "route">): void {
	if (record.route) {
		if (!containedPath(NESTED_EVENTS_DIR, record.route.eventSink)) {
			throw new Error("Nested event sink is outside the subagent nested event root.");
		}
		if (!containedPath(NESTED_EVENTS_DIR, record.route.controlInbox)) {
			throw new Error("Nested control inbox is outside the subagent nested event root.");
		}
	}
}

function pathsAreContained(record: Pick<AttachmentRecord, "route">): boolean {
	if (record.route) {
		if (!containedPath(NESTED_EVENTS_DIR, record.route.eventSink)) return false;
		if (!containedPath(NESTED_EVENTS_DIR, record.route.controlInbox)) return false;
	}
	return true;
}

function parseAttachmentRecord(raw: string, expectedId: string): AttachmentRecord | undefined {
	try {
		const parsed = JSON.parse(raw) as Partial<AttachmentRecord>;
		if (parsed.schemaVersion !== 2 || parsed.type !== "subagent.run-attachment") return undefined;
		if (typeof parsed.attachmentId !== "string" || parsed.attachmentId !== expectedId) return undefined;
		if (typeof parsed.id !== "string" || !isSafeNestedPathId(parsed.id)) return undefined;
		if (typeof parsed.kind !== "string") return undefined;
		if (typeof parsed.attachedAt !== "number") return undefined;
		if (parsed.state !== "attached") return undefined;
		const kind = parsed.kind as AttachmentKind;
		if (kind !== "foreground" && kind !== "async" && kind !== "nested") return undefined;

		const record: AttachmentRecord = {
			schemaVersion: 2,
			type: "subagent.run-attachment",
			attachmentId: parsed.attachmentId,
			id: parsed.id,
			kind,
			attachedAt: parsed.attachedAt,
			state: "attached",
		};
		if (typeof parsed.childKey === "string") record.childKey = parsed.childKey;
		if (typeof parsed.epoch === "string") record.epoch = parsed.epoch;
		if (typeof parsed.note === "string") record.note = parsed.note;
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

		// Kind invariants on read: nested attachments require a route + epoch + childKey.
		if (kind === "nested") {
			if (!record.route || typeof record.epoch !== "string" || typeof record.childKey !== "string") return undefined;
		}
		if (!pathsAreContained(record)) return undefined;

		return record;
	} catch {
		return undefined;
	}
}

function toAttachment(record: AttachmentRecord): Attachment {
	return {
		attachmentId: record.attachmentId,
		id: record.id,
		kind: record.kind,
		...(record.route ? { route: record.route } : {}),
		...(typeof record.childKey === "string" ? { childKey: record.childKey } : {}),
		...(typeof record.epoch === "string" ? { epoch: record.epoch } : {}),
		attachedAt: record.attachedAt,
		state: "attached",
		...(typeof record.note === "string" ? { note: record.note } : {}),
	};
}

function ensureOwnerOnlyDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
	// mkdirSync mode is not applied when the directory already exists; enforce 0700.
	try {
		const mode = (fs.statSync(dirPath) as unknown as { mode: number }).mode & 0o777;
		if (mode !== 0o700) {
			(fs as unknown as { chmodSync(path: string, mode: number): void }).chmodSync(dirPath, 0o700);
		}
	} catch {
		// Best-effort; writeDurableJson will still reject looser modes.
	}
}

/**
 * Record an active attachment. Writes with fsynced durable JSON and owner-only
 * permissions so the attachment survives extension reload.
 */
export function recordAttachment(input: {
	attachmentId: string;
	id: string;
	kind: AttachmentKind;
	route?: NestedRouteInfo;
	childKey?: string;
	epoch?: string;
	attachedAt: number;
	note?: string;
}): Attachment {
	assertSafeAttachmentId("attachmentId", input.attachmentId);
	assertSafeAttachmentId("id", input.id);

	if (input.kind === "nested" && !input.route) {
		throw new Error('kind "nested" requires route.');
	}
	if (input.kind === "nested" && typeof input.epoch !== "string") {
		throw new Error('kind "nested" requires epoch.');
	}
	if (input.kind === "nested" && typeof input.childKey !== "string") {
		throw new Error('kind "nested" requires childKey.');
	}
	if (typeof input.childKey === "string") assertSafeAttachmentId("childKey", input.childKey);
	if (typeof input.epoch === "string") assertSafeAttachmentId("epoch", input.epoch);

	assertPathContainment({ route: input.route });

	const record: AttachmentRecord = {
		schemaVersion: 2,
		type: "subagent.run-attachment",
		attachmentId: input.attachmentId,
		id: input.id,
		kind: input.kind,
		attachedAt: input.attachedAt,
		state: "attached",
	};
	if (input.route) record.route = input.route;
	if (typeof input.childKey === "string") record.childKey = input.childKey;
	if (typeof input.epoch === "string") record.epoch = input.epoch;
	if (typeof input.note === "string") record.note = input.note;

	const filePath = attachmentFilePath(input.attachmentId);
	ensureOwnerOnlyDir(RUN_ATTACHMENTS_DIR);
	// exclusive:false so re-recording the same attachmentId overwrites.
	writeDurableJson(filePath, record, { exclusive: false });
	try {
		(fs as unknown as { chmodSync(path: string, mode: number): void }).chmodSync(filePath, 0o600);
	} catch {
		// Best-effort; the directory is already 0700
	}
	return toAttachment(record);
}

/**
 * Recover an attachment by attachmentId. Returns undefined if missing or corrupted.
 * Does not re-verify owner epoch liveness — callers that need a live attach should
 * re-run attachToRun.
 */
export function recoverAttachment(attachmentId: string): Attachment | undefined {
	assertSafeAttachmentId("attachmentId", attachmentId);

	const filePath = attachmentFilePath(attachmentId);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}

	const record = parseAttachmentRecord(raw, attachmentId);
	if (!record) return undefined;
	return toAttachment(record);
}

/**
 * Delete an attachment from the durable store. Idempotent — does not throw if
 * the attachment doesn't exist.
 */
export function deleteAttachment(attachmentId: string): void {
	assertSafeAttachmentId("attachmentId", attachmentId);
	try {
		fs.rmSync(attachmentFilePath(attachmentId), { force: true });
	} catch {
		// Idempotent: missing file is fine
	}
}

/**
 * List all attachment ids in the durable store. Does not validate record
 * integrity — callers should use recoverAttachment for that.
 */
export function listAttachments(): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(RUN_ATTACHMENTS_DIR);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -5))
		.filter((id) => isSafeNestedPathId(id));
}
