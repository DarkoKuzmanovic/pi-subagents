import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	recordAttachment,
	recoverAttachment,
	deleteAttachment,
	listAttachments,
	RUN_ATTACHMENTS_DIR,
} from "../../src/runs/shared/run-attachment-store.ts";
import { createNestedRoute, type NestedRoute } from "../../src/runs/shared/nested-events.ts";
import { TEMP_ROOT_DIR } from "../../src/shared/types.ts";

const attachmentDir = path.join(TEMP_ROOT_DIR, "run-attachments");
const routes: NestedRoute[] = [];
const attachmentIds: string[] = [];

afterEach(() => {
	for (const id of attachmentIds.splice(0)) {
		try {
			deleteAttachment(id);
		} catch {
			// already gone
		}
		try {
			fs.rmSync(path.join(attachmentDir, `${id}.json`), { force: true });
		} catch {
			// ignore
		}
	}
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
});

function trackRoute(rootRunId = `root-${Math.random().toString(36).slice(2)}`): NestedRoute {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function trackAttachmentId(id: string): string {
	attachmentIds.push(id);
	return id;
}

describe("run attachment store — recording and recovery", () => {
	it("records a nested attachment and recovers it by attachmentId", () => {
		const route = trackRoute();
		const attachmentId = trackAttachmentId(`att-${Math.random().toString(36).slice(2)}`);
		const runId = `nested-${Math.random().toString(36).slice(2)}`;
		const epoch = `epoch-${Math.random().toString(36).slice(2)}`;

		const recorded = recordAttachment({
			attachmentId,
			id: runId,
			kind: "nested",
			route,
			childKey: "0",
			epoch,
			attachedAt: 1000,
		});

		assert.equal(recorded.attachmentId, attachmentId);
		assert.equal(recorded.id, runId);
		assert.equal(recorded.kind, "nested");
		assert.equal(recorded.childKey, "0");
		assert.equal(recorded.epoch, epoch);
		assert.equal(recorded.state, "attached");
		assert.equal(recorded.route?.capabilityToken, route.capabilityToken);

		const recovered = recoverAttachment(attachmentId);
		assert.ok(recovered, "attachment should be recovered");
		assert.equal(recovered?.attachmentId, attachmentId);
		assert.equal(recovered?.id, runId);
		assert.equal(recovered?.epoch, epoch);
		assert.equal(recovered?.route?.rootRunId, route.rootRunId);
	});

	it("records a foreground attachment with note and recovers it", () => {
		const attachmentId = trackAttachmentId(`att-fg-${Math.random().toString(36).slice(2)}`);
		const runId = `fg-${Math.random().toString(36).slice(2)}`;
		recordAttachment({
			attachmentId,
			id: runId,
			kind: "foreground",
			attachedAt: 2000,
			note: "foreground, in-memory",
		});

		const recovered = recoverAttachment(attachmentId);
		assert.ok(recovered);
		assert.equal(recovered?.kind, "foreground");
		assert.equal(recovered?.note, "foreground, in-memory");
		assert.equal(recovered?.route, undefined);
	});

	it("records an async attachment and recovers it", () => {
		const attachmentId = trackAttachmentId(`att-async-${Math.random().toString(36).slice(2)}`);
		const runId = `async-${Math.random().toString(36).slice(2)}`;
		recordAttachment({
			attachmentId,
			id: runId,
			kind: "async",
			attachedAt: 3000,
			note: "async",
		});

		const recovered = recoverAttachment(attachmentId);
		assert.ok(recovered);
		assert.equal(recovered?.kind, "async");
		assert.equal(recovered?.note, "async");
	});

	it("survives extension reload (attachment persists on disk)", () => {
		const attachmentId = trackAttachmentId(`att-reload-${Math.random().toString(36).slice(2)}`);
		recordAttachment({
			attachmentId,
			id: `run-${Math.random().toString(36).slice(2)}`,
			kind: "foreground",
			attachedAt: Date.now(),
			note: "foreground, in-memory",
		});

		// Simulate reload: recover from disk with no in-memory state.
		const recovered = recoverAttachment(attachmentId);
		assert.ok(recovered, "attachment should survive reload");
		assert.equal(recovered?.attachmentId, attachmentId);
		assert.equal(recovered?.state, "attached");
	});

	it("deleteAttachment is idempotent", () => {
		const attachmentId = trackAttachmentId(`att-del-${Math.random().toString(36).slice(2)}`);
		recordAttachment({
			attachmentId,
			id: `run-${Math.random().toString(36).slice(2)}`,
			kind: "async",
			attachedAt: Date.now(),
		});
		assert.ok(recoverAttachment(attachmentId));
		deleteAttachment(attachmentId);
		assert.equal(recoverAttachment(attachmentId), undefined);
		// Second delete must not throw.
		deleteAttachment(attachmentId);
		assert.equal(recoverAttachment(attachmentId), undefined);
	});

	it("listAttachments returns recorded ids", () => {
		const a = trackAttachmentId(`att-list-a-${Math.random().toString(36).slice(2)}`);
		const b = trackAttachmentId(`att-list-b-${Math.random().toString(36).slice(2)}`);
		recordAttachment({ attachmentId: a, id: "run-a", kind: "foreground", attachedAt: 1 });
		recordAttachment({ attachmentId: b, id: "run-b", kind: "async", attachedAt: 2 });
		const listed = listAttachments();
		assert.ok(listed.includes(a));
		assert.ok(listed.includes(b));
	});

	it("rejects nested attachment missing epoch", () => {
		const route = trackRoute();
		const attachmentId = trackAttachmentId(`att-bad-${Math.random().toString(36).slice(2)}`);
		assert.throws(
			() =>
				recordAttachment({
					attachmentId,
					id: "nested-x",
					kind: "nested",
					route,
					childKey: "0",
					attachedAt: 1,
				}),
			/requires epoch/,
		);
	});

	it("returns undefined for corrupted attachment files", () => {
		const attachmentId = trackAttachmentId(`att-corrupt-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(RUN_ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(RUN_ATTACHMENTS_DIR, `${attachmentId}.json`), "{not-json", "utf-8");
		assert.equal(recoverAttachment(attachmentId), undefined);
	});

	it("writes under TEMP_ROOT_DIR/run-attachments with owner-only dir", () => {
		const attachmentId = trackAttachmentId(`att-perms-${Math.random().toString(36).slice(2)}`);
		recordAttachment({
			attachmentId,
			id: "run-perms",
			kind: "foreground",
			attachedAt: 1,
		});
		assert.ok(fs.existsSync(path.join(RUN_ATTACHMENTS_DIR, `${attachmentId}.json`)));
		const mode = fs.statSync(RUN_ATTACHMENTS_DIR).mode & 0o777;
		assert.equal(mode, 0o700);
	});
});
