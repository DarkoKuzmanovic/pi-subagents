import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher, RESULT_DEAD_LETTER_DIRNAME } from "../../src/runs/background/result-watcher.ts";
import { buildCompletionOutbox, publishCompletionOutbox, resolveOmOutboxPath } from "../../src/runs/background/async-om-outbox.ts";
import { resolveOmReceiptPath, resolveOmReceiptsDir } from "../../src/runs/background/async-om-retention.ts";
import { hasDeliveredIntercomMarker } from "../../src/runs/background/async-om-delivery-marker.ts";
import { computeCanonicalSha256 } from "../../src/shared/durable-json.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("result watcher", () => {
	it("processes deferred session-scoped results after session identity is restored", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			const resultPath = path.join(resultsDir, "session-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "session-run",
				sessionId: "session-current",
				success: true,
				summary: "done",
			}), "utf-8");

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(emitted.length, 0);
				assert.equal(fs.existsSync(resultPath), true);

				state.currentSessionId = "session-current";
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs malformed result files instead of swallowing them silently", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const resultPath = path.join(resultsDir, "bad.json");
			fs.writeFileSync(resultPath, "{bad-json", "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 500));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0);
			assert.equal(fs.existsSync(resultPath), false, "malformed result should be quarantined after bounded retries");
			const deadLetterDir = path.join(resultsDir, RESULT_DEAD_LETTER_DIRNAME);
			assert.equal(fs.existsSync(deadLetterDir), true, "dead-letter directory should be created on first quarantine");
			assert.equal(fs.readdirSync(deadLetterDir).some((file) => file.startsWith("bad.json.failed-")), true);
			assert.ok(
				logged.some((entry) => /Failed to process subagent result file/.test(String(entry[0] ?? ""))),
				"expected watcher error to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("dead-letters valid JSON whose shape is unusable instead of emitting or retrying forever", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-shape-"));
		try {
			const resultPath = path.join(resultsDir, "shape.json");
			// Parses fine, but summary/success carry the wrong types — permanently unusable.
			fs.writeFileSync(resultPath, JSON.stringify({ summary: 42, success: "yes", sessionId: "session-1" }), "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			const deadLetterDir = path.join(resultsDir, RESULT_DEAD_LETTER_DIRNAME);
			try {
				watcher.primeExistingResults();
				const deadline = Date.now() + 2000;
				while (fs.existsSync(resultPath) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0, "a shape-invalid result must never emit completion events");
			assert.equal(fs.existsSync(resultPath), false, "shape-invalid result should leave the watched namespace");
			assert.equal(fs.readdirSync(deadLetterDir).some((file) => file.startsWith("shape.json.failed-")), true);
			assert.ok(
				logged.some((entry) => /InvalidResultShapeError|must be a/.test(String(entry[1] ?? entry[0] ?? ""))),
				"expected the shape violation to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when fs.watch throws EMFILE and preserves grouped intercom delivery", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			const emfile = new Error("too many open files") as NodeJS.ErrnoException;
			emfile.code = "EMFILE";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => {
						throw emfile;
					},
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(path.join(resultsDir, "async-fallback.json"), JSON.stringify({
					id: "async-fallback",
					runId: "run-fallback",
					agent: "parallel:a+b",
					mode: "parallel",
					success: true,
					state: "complete",
					summary: "Combined summary",
					results: [
						{ agent: "a", output: "Result from a", success: true, intercomTarget: "subagent-a-run-fallback-1" },
						{ agent: "b", output: "Result from b", success: false, error: "B failed", intercomTarget: "subagent-b-run-fallback-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "async-fallback.json")), false);
			const payload = intercomEvents[0]?.data as { mode?: string; status?: string; message?: string };
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.status, "failed");
			assert.match(String(payload.message ?? ""), /Run: run-fallback/);
			assert.match(String(payload.message ?? ""), /Children: 1 completed, 1 failed/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when an active fs.watch emits ENOSPC", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
			const fakeWatcher = {
				on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
					if (event === "error") emitWatcherError = handler;
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as fs.FSWatcher;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => fakeWatcher,
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, fakeWatcher);
				const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
				enospc.code = "ENOSPC";
				emitWatcherError?.(enospc);
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(path.join(resultsDir, "done.json"), JSON.stringify({ sessionId: "session-1", summary: "done" }), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 75));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("emits async completion plus one grouped intercom result event when an intercom target is present", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const firstSession = path.join(resultsDir, "a-session.jsonl");
			const missingSession = path.join(resultsDir, "b-session.jsonl");
			try {
				fs.writeFileSync(firstSession, "", "utf-8");
				fs.writeFileSync(path.join(resultsDir, "async-1.json"), JSON.stringify({
					id: "async-1",
					runId: "run-123",
					agent: "parallel:a+b",
					mode: "parallel",
					success: true,
					state: "complete",
					summary: "Combined summary",
					results: [
						{ agent: "a", output: "Result from a", success: true, sessionFile: firstSession, artifactPaths: { outputPath: "/tmp/a-output.md" }, intercomTarget: "subagent-a-run-123-1" },
						{ agent: "b", output: "Result from b", success: false, sessionFile: missingSession, artifactPaths: { outputPath: "/tmp/b-output.md" }, intercomTarget: "subagent-b-run-123-2" },
					],
					sessionId: "session-1",
					sessionFile: "/tmp/session.jsonl",
					asyncDir: "/tmp/async-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const eventData = intercomEvents[0]?.data as { message?: string; mode?: string; status?: string };
			assert.equal(eventData.mode, "parallel");
			assert.equal(eventData.status, "failed");
			const message = String(eventData.message ?? "");
			assert.match(message, /Revive child: subagent\(\{ action: "resume", id: "async-1", index: 0, message: "\.\.\." \}\)/);
			assert.ok(message.includes(`Session: ${firstSession}`));
			assert.equal(message.includes(missingSession), false);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not advertise indexed revive from only a top-level async session file", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					emit: (event: string, data: unknown) => {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
						return true;
					},
					on: (event: string, listener: (payload: unknown) => void) => {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				fs.writeFileSync(path.join(resultsDir, "async-top-session.json"), JSON.stringify({
					id: "async-top-session",
					mode: "parallel",
					success: false,
					state: "failed",
					results: [
						{ agent: "a", output: "A", success: true },
						{ agent: "b", output: "B", success: false },
					],
					sessionId: "session-1",
					sessionFile: "/tmp/top-session.jsonl",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			const eventData = emitted.find((entry) => entry.event === "subagent:result-intercom")?.data as { message?: string } | undefined;
			assert.ok(eventData);
			assert.doesNotMatch(String(eventData.message ?? ""), /Revive child:/);
			assert.match(String(eventData.message ?? ""), /Resume: unavailable; no child session file was persisted/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("marks grouped async results as paused when the result file is paused", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				fs.writeFileSync(path.join(resultsDir, "async-paused.json"), JSON.stringify({
					id: "async-paused",
					runId: "run-paused",
					agent: "chain:a->b",
					mode: "chain",
					success: false,
					state: "paused",
					summary: "Paused after interrupt. Waiting for explicit next action.",
					results: [
						{ agent: "a", output: "Result from a", success: true, intercomTarget: "subagent-a-run-paused-1" },
						{ agent: "b", output: "Paused after interrupt", success: false, intercomTarget: "subagent-b-run-paused-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			const intercomEvents = emitted.filter((entry) => entry.event === "subagent:result-intercom");
			assert.equal(intercomEvents.length, 1);
			const payload = intercomEvents[0]?.data as { mode?: string; status?: string; message?: string; children?: Array<{ status?: string }> };
			assert.equal(payload.mode, "chain");
			assert.equal(payload.status, "paused");
			assert.equal(payload.children?.every((child) => child.status === "paused"), true);
			assert.match(String(payload.message ?? ""), /Status: paused/);
			assert.match(String(payload.message ?? ""), /1\. a — paused/);
			assert.match(String(payload.message ?? ""), /2\. b — paused/);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs one unacknowledged grouped async intercom delivery before completing", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on(_event: string, _handler: (payload: unknown) => void) {
						return () => {};
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(path.join(resultsDir, "async-2.json"), JSON.stringify({
					id: "async-2",
					runId: "run-456",
					agent: "worker",
					success: true,
					state: "complete",
					summary: "Worker summary",
					sessionId: "session-1",
					intercomTarget: "orchestrator",
				}), "utf-8");
				watcher.primeExistingResults();
				const deadline = Date.now() + 1000;
				while (true) {
					const sawWarning = logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? "")));
					const sawCompletion = emitted.some((entry) => entry.event === "subagent:async-complete");
					if ((sawWarning && sawCompletion) || Date.now() > deadline) break;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1);
			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(logged.some((entry) => /Subagent async grouped result intercom delivery was not acknowledged/.test(String(entry[0] ?? ""))), true);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("automatically re-delivers a result whose first delivery failed", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-redeliver-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			let failNextEmit = true;
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						if (event === "subagent:async-complete" && failNextEmit) {
							failNextEmit = false;
							throw new Error("subscriber exploded");
						}
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			const resultPath = path.join(resultsDir, "redeliver-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "redeliver-run",
				success: true,
				summary: "done",
				cwd: "/repo",
			}), "utf-8");

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				// First delivery throws. The watcher must retain the file, unmark the completion key,
				// and schedule its own retry — fs.watch may emit no further event.
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 25));
				assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), false);
				assert.equal(fs.existsSync(resultPath), true, "result file must be retained after failed delivery");

				const deadline = Date.now() + 1000;
				while (emitted.filter((entry) => entry.event === "subagent:async-complete").length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1, "retry must re-deliver without a manual rescan");
				assert.equal(fs.existsSync(resultPath), false, "result file is consumed after successful delivery");
			} finally {
				watcher.stopResultWatcher();
			}
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("does not unlink a result while its first delivery is in flight", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-inflight-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			let completionAttempts = 0;
			let watcher: ReturnType<typeof createResultWatcher>;
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const set = listeners.get(event) ?? new Set();
						set.add(handler);
						listeners.set(event, set);
						return () => set.delete(handler);
					},
					emit(event: string, data: unknown) {
						if (event === "subagent:async-complete") {
							completionAttempts++;
							if (completionAttempts === 1) throw new Error("completion subscriber exploded");
						}
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							watcher.primeExistingResults();
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setTimeout(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }), 75);
							}
						}
					},
				},
			};
			const state = createState();
			const resultPath = path.join(resultsDir, "inflight-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "inflight-run",
				success: true,
				summary: "done",
				cwd: "/repo",
				intercomTarget: "orchestrator",
			}), "utf-8");
			watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.primeExistingResults();
				const deadline = Date.now() + 2000;
				while (emitted.filter((entry) => entry.event === "subagent:async-complete").length === 0 && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}
			assert.equal(completionAttempts, 2, "failed first completion should retry from the retained file");
			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	describe("M6.1 durable OM outbox retention", () => {
		it("retains result.json (post-intercom eager-unlink point) while an OM outbox has no receipt", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-1");
				const outbox = buildCompletionOutbox(
					{
						deliveryId: "om-async-v1:nonce-abc:c000001",
						runId: "om-run-1",
						runNonce: "nonce-abc",
						childId: "c000001",
						consumer: {
							consumerId: "observational-memory",
							contractVersion: 1,
							originParent: { sessionFile: "/tmp/parent.jsonl", sessionHeaderId: "h", rootEntryId: "r", launchLeafId: "l", launchCwd: "/repo" },
						},
					},
					[{ type: "a" }],
				);
				publishCompletionOutbox(asyncDir, outbox);

				const pi = { events: { on: () => () => {}, emit() {} } };
				const state = createState();
				const resultPath = path.join(resultsDir, "om-run-1.json");
				fs.writeFileSync(resultPath, JSON.stringify({ id: "om-run-1", success: true, summary: "done", cwd: "/repo", asyncDir }), "utf-8");

				const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { asyncRunsDir });
				try {
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcher.stopResultWatcher();
				}

				assert.equal(fs.existsSync(resultPath), true, "result.json must survive the post-intercom eager-unlink point until a receipt lands");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true, "outbox must be retained without a matching receipt");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("prunes a retained outbox once a valid receipt appears, discovered on the next startup/poll rescan", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-2");
				const delivery = {
					deliveryId: "om-async-v1:nonce-abc:c000001",
					runId: "om-run-2",
					runNonce: "nonce-abc",
					childId: "c000001",
					consumer: {
						consumerId: "observational-memory" as const,
						contractVersion: 1 as const,
						originParent: { sessionFile: "/tmp/parent.jsonl", sessionHeaderId: "h", rootEntryId: "r", launchLeafId: "l", launchCwd: "/repo" },
					},
				};
				const outbox = buildCompletionOutbox(delivery, [{ type: "a" }]);
				publishCompletionOutbox(asyncDir, outbox);

				const pi = { events: { on: () => () => {}, emit() {} } };
				const state = createState();
				const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { asyncRunsDir });
				try {
					// No receipt yet: startup rescan must retain it.
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
					assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true);

					const outboxOnDisk = JSON.parse(fs.readFileSync(resolveOmOutboxPath(asyncDir, "c000001"), "utf-8"));
					const outboxCanonicalSha256 = computeCanonicalSha256(outboxOnDisk).sha256;
					const withoutHash = {
						schemaVersion: 1 as const,
						consumerId: "observational-memory" as const,
						contractVersion: 1 as const,
						delivery,
						importedAt: new Date().toISOString(),
						snapshotSha256: outbox.snapshot.sha256,
						snapshotByteLength: outbox.snapshot.byteLength,
						outboxSha256: outboxCanonicalSha256,
						inboxSha256: "d".repeat(64),
					};
					const receipt = { ...withoutHash, receiptSha256: computeCanonicalSha256(withoutHash).sha256 };
					fs.mkdirSync(resolveOmReceiptsDir(asyncDir), { recursive: true });
					fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify(receipt), "utf-8");

					// Next rescan (startup or poll) must discover and prune it — with no result.json involved at all.
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
					assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), false, "outbox must be pruned once acknowledged");
				} finally {
					watcher.stopResultWatcher();
				}
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});
	});

	describe("M6.1 Phase 2B durable result-delivery retention", () => {
		function createAckingIntercomPi(): { pi: { events: { on: (event: string, handler: (payload: unknown) => void) => () => void; emit: (event: string, data: unknown) => void } }; emitted: Array<{ event: string; data: unknown }> } {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
							}
						}
					},
				},
			};
			return { pi, emitted };
		}

		function createDecliningIntercomPi(): { pi: { events: { on: (event: string, handler: (payload: unknown) => void) => () => void; emit: (event: string, data: unknown) => void } }; emitted: Array<{ event: string; data: unknown }> } {
			// Simulates an intercom bus that always reports delivery failure (e.g. no listener
			// acknowledged the request) — the promise resolves with `delivered: false` immediately,
			// rather than relying on the 500ms default timeout fallback.
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
						if (event === "subagent:result-intercom") {
							const requestId = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
							if (typeof requestId === "string") {
								setImmediate(() => pi.events.emit("subagent:result-intercom-delivery", { requestId, delivered: false }));
							}
						}
					},
				},
			};
			return { pi, emitted };
		}

		function makeOmOutbox(runId: string) {
			return buildCompletionOutbox(
				{
					deliveryId: `om-async-v1:nonce-abc:c000001`,
					runId,
					runNonce: "nonce-abc",
					childId: "c000001",
					consumer: {
						consumerId: "observational-memory" as const,
						contractVersion: 1 as const,
						originParent: { sessionFile: "/tmp/parent.jsonl", sessionHeaderId: "h", rootEntryId: "r", launchLeafId: "l", launchCwd: "/repo" },
					},
				},
				[{ type: "a" }],
			);
		}

		function writeValidReceipt(asyncDir: string, delivery: ReturnType<typeof makeOmOutbox>["delivery"], outboxOnDisk: unknown) {
			const outboxCanonicalSha256 = computeCanonicalSha256(outboxOnDisk).sha256;
			const withoutHash = {
				schemaVersion: 1 as const,
				consumerId: "observational-memory" as const,
				contractVersion: 1 as const,
				delivery,
				importedAt: new Date().toISOString(),
				snapshotSha256: (outboxOnDisk as { snapshot: { sha256: string } }).snapshot.sha256,
				snapshotByteLength: (outboxOnDisk as { snapshot: { byteLength: number } }).snapshot.byteLength,
				outboxSha256: outboxCanonicalSha256,
				inboxSha256: "d".repeat(64),
			};
			const receipt = { ...withoutHash, receiptSha256: computeCanonicalSha256(withoutHash).sha256 };
			fs.mkdirSync(resolveOmReceiptsDir(asyncDir), { recursive: true });
			fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify(receipt), "utf-8");
		}

		it("1. successful intercom + pending OM outbox retains the original result file and a durable marker", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-1-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-1-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-1");
				publishCompletionOutbox(asyncDir, makeOmOutbox("om-run-1"));

				const { pi, emitted } = createAckingIntercomPi();
				const state = createState();
				const resultPath = path.join(resultsDir, "om-run-1.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "om-run-1", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				const watcher = createResultWatcher(pi, state, resultsDir, 60_000, { asyncRunsDir });
				try {
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcher.stopResultWatcher();
				}

				assert.ok(emitted.some((entry) => entry.event === "subagent:result-intercom"), "intercom delivery must have been attempted");
				assert.equal(fs.existsSync(resultPath), true, "result.json must be retained while the OM outbox is pending");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true, "outbox must be retained");
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true, "a durable delivery marker must exist");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("2. restart/startup scan sees the retained result but does not redeliver intercom", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-2-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-2-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-2");
				publishCompletionOutbox(asyncDir, makeOmOutbox("om-run-2"));
				const resultPath = path.join(resultsDir, "om-run-2.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "om-run-2", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				// First watcher instance: delivers intercom once and retains (no receipt yet).
				const first = createAckingIntercomPi();
				const watcherFirst = createResultWatcher(first.pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcherFirst.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcherFirst.stopResultWatcher();
				}
				assert.equal(first.emitted.filter((entry) => entry.event === "subagent:result-intercom").length, 1, "first pass must deliver intercom once");

				// Simulate a restart: a fresh state (in-memory dedupe reset) and a fresh watcher instance,
				// same on-disk state (retained result.json + marker + outbox).
				const second = createAckingIntercomPi();
				const watcherSecond = createResultWatcher(second.pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcherSecond.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcherSecond.stopResultWatcher();
				}

				assert.equal(
					second.emitted.filter((entry) => entry.event === "subagent:result-intercom").length,
					0,
					"restart must not redeliver intercom for an already-delivered retained result",
				);
				assert.equal(fs.existsSync(resultPath), true, "result.json remains retained (outbox still has no receipt)");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true);
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true);
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("3. an absent or invalid receipt retains the result, marker, and outbox across a rescan", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-3-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-3-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-3");
				publishCompletionOutbox(asyncDir, makeOmOutbox("om-run-3"));
				const resultPath = path.join(resultsDir, "om-run-3.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "om-run-3", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				const { pi } = createAckingIntercomPi();
				const watcher = createResultWatcher(pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));

					// Write a tampered (invalid) receipt and rescan.
					fs.mkdirSync(resolveOmReceiptsDir(asyncDir), { recursive: true });
					fs.writeFileSync(resolveOmReceiptPath(asyncDir, "c000001"), JSON.stringify({ schemaVersion: 1, tampered: true }), "utf-8");
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcher.stopResultWatcher();
				}

				assert.equal(fs.existsSync(resultPath), true, "result.json must remain retained when the receipt is invalid");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true, "outbox must remain retained");
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true, "delivery marker must remain");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("4. a valid receipt prunes the result, marker, and outbox", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-4-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-4-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-4");
				const outbox = makeOmOutbox("om-run-4");
				publishCompletionOutbox(asyncDir, outbox);
				const resultPath = path.join(resultsDir, "om-run-4.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "om-run-4", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				const { pi } = createAckingIntercomPi();
				const watcher = createResultWatcher(pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
					assert.equal(fs.existsSync(resultPath), true, "precondition: result.json retained before the receipt lands");

					const outboxOnDisk = JSON.parse(fs.readFileSync(resolveOmOutboxPath(asyncDir, "c000001"), "utf-8"));
					writeValidReceipt(asyncDir, outbox.delivery, outboxOnDisk);

					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcher.stopResultWatcher();
				}

				assert.equal(fs.existsSync(resultPath), false, "result.json must be pruned once the receipt is validated");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), false, "outbox must be pruned");
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false, "delivery marker must be pruned");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("5. a non-OM run retains existing immediate cleanup behavior", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-5-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-5-runs-"));
			try {
				// No OM outbox is ever published for this run: it never participated in OM registration.
				const asyncDir = path.join(asyncRunsDir, "plain-run-1");
				const resultPath = path.join(resultsDir, "plain-run-1.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "plain-run-1", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				const { pi, emitted } = createAckingIntercomPi();
				const watcher = createResultWatcher(pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcher.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcher.stopResultWatcher();
				}

				assert.ok(emitted.some((entry) => entry.event === "subagent:result-intercom"), "intercom delivery must still have been attempted");
				assert.equal(fs.existsSync(resultPath), false, "non-OM runs must still be unlinked immediately after processing");
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false, "no delivery marker should be created for a non-OM run");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});

		it("6. a failed intercom delivery must never create a durable delivered marker, and remains eligible for retry", async () => {
			const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-6-"));
			const asyncRunsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-om-6-runs-"));
			try {
				const asyncDir = path.join(asyncRunsDir, "om-run-6");
				publishCompletionOutbox(asyncDir, makeOmOutbox("om-run-6"));
				const resultPath = path.join(resultsDir, "om-run-6.json");
				fs.writeFileSync(
					resultPath,
					JSON.stringify({ id: "om-run-6", success: true, summary: "done", cwd: "/repo", asyncDir, intercomTarget: "target-x" }),
					"utf-8",
				);

				// First pass: intercom delivery is never acknowledged (delivered: false).
				const first = createDecliningIntercomPi();
				const watcherFirst = createResultWatcher(first.pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcherFirst.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcherFirst.stopResultWatcher();
				}

				assert.ok(first.emitted.some((entry) => entry.event === "subagent:result-intercom"), "intercom delivery must have been attempted");
				assert.equal(fs.existsSync(resultPath), true, "result.json must remain retained while the OM outbox is pending");
				assert.equal(fs.existsSync(resolveOmOutboxPath(asyncDir, "c000001")), true, "outbox must remain retained");
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), false, "a failed delivery must never create a durable delivered marker");

				// Second pass (e.g. after a watcher restart): since no marker was written, delivery must
				// be retried rather than skipped.
				const second = createAckingIntercomPi();
				const watcherSecond = createResultWatcher(second.pi, createState(), resultsDir, 60_000, { asyncRunsDir });
				try {
					watcherSecond.primeExistingResults();
					await new Promise((resolve) => setTimeout(resolve, 100));
				} finally {
					watcherSecond.stopResultWatcher();
				}

				assert.equal(
					second.emitted.filter((entry) => entry.event === "subagent:result-intercom").length,
					1,
					"retry after a failed delivery must re-attempt intercom delivery",
				);
				assert.equal(hasDeliveredIntercomMarker(fs, asyncDir), true, "a successful retry must now create the durable delivered marker");
			} finally {
				fs.rmSync(resultsDir, { recursive: true, force: true });
				fs.rmSync(asyncRunsDir, { recursive: true, force: true });
			}
		});
	});
});
