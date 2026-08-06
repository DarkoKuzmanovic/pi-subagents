import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { readNestedControlRequests, readNestedControlResults, resolveNestedRouteFromEnv, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { deliverSubagentIntercomMessageEvent } from "../intercom/result-intercom.ts";
import { resolveSubagentIntercomTarget } from "../intercom/intercom-bridge.ts";
import { SubagentParams } from "./schemas.ts";
import { loadConfig } from "./config.ts";
import { type Details, type SubagentState } from "../shared/types.ts";

type NestedControlResultInput = Parameters<typeof writeNestedControlResult>[1];

interface NestedControlInboxHandoff {
	pendingResults: Map<string, NestedControlResultInput>;
	seenRequestIds: Set<string>;
}

interface StoppableLifecycle {
	stop(): NestedControlInboxHandoff | void | Promise<NestedControlInboxHandoff | void>;
}

interface NestedControlInboxListener {
	stop(): Promise<void>;
}

interface FanoutChildExtensionDeps {
	state?: SubagentState;
	readControlRequests?: typeof readNestedControlRequests;
	readControlResults?: typeof readNestedControlResults;
	writeControlResult?: typeof writeNestedControlResult;
	unlinkControlRequest?: (filePath: string) => void;
	logError?: (...args: unknown[]) => void;
}

const FANOUT_CHILD_CONTROL_LIFECYCLE_KEY = "__piSubagentFanoutChildControlLifecycle";

function asStoppable(value: unknown): StoppableLifecycle | undefined {
	if (!value || typeof value !== "object") return undefined;
	return typeof (value as { stop?: unknown }).stop === "function" ? value as StoppableLifecycle : undefined;
}

function asNestedControlInboxHandoff(value: unknown): NestedControlInboxHandoff | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { pendingResults?: unknown; seenRequestIds?: unknown };
	if (!(candidate.pendingResults instanceof Map)) return undefined;
	return {
		pendingResults: candidate.pendingResults as Map<string, NestedControlResultInput>,
		seenRequestIds: candidate.seenRequestIds instanceof Set
			? candidate.seenRequestIds as Set<string>
			: new Set(),
	};
}

function mergeNestedControlInboxHandoff(target: NestedControlInboxHandoff, source: NestedControlInboxHandoff): void {
	for (const [requestId, result] of source.pendingResults) {
		if (!target.pendingResults.has(requestId)) target.pendingResults.set(requestId, result);
	}
	for (const requestId of source.seenRequestIds) target.seenRequestIds.add(requestId);
}

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function startNestedControlInboxListener(
	pi: ExtensionAPI,
	state: SubagentState,
	deps: FanoutChildExtensionDeps,
	handoff: NestedControlInboxHandoff,
): NestedControlInboxListener | undefined {
	let route: ReturnType<typeof resolveNestedRouteFromEnv>;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	const readControlRequests = deps.readControlRequests ?? readNestedControlRequests;
	const readControlResults = deps.readControlResults ?? readNestedControlResults;
	const writeControlResult = deps.writeControlResult ?? writeNestedControlResult;
	const unlinkControlRequest = deps.unlinkControlRequest ?? fs.unlinkSync;
	const logError = deps.logError ?? ((...args: unknown[]) => console.error(...args));
	let stopped = false;
	const seen = handoff.seenRequestIds;
	const inFlight = new Set<string>();
	const pendingResults = handoff.pendingResults;
	const pendingTasks = new Set<Promise<void>>();
	let resultsSeeded = false;
	const timer = setInterval(() => {
		if (stopped) return;
		try {
			if (!resultsSeeded) {
				for (const result of readControlResults(route)) {
					seen.add(result.requestId);
					pendingResults.delete(result.requestId);
				}
				resultsSeeded = true;
			}
			for (const request of readControlRequests(route)) {
				if (seen.has(request.requestId) && !pendingResults.has(request.requestId)) {
					try { unlinkControlRequest(request.filePath); } catch {}
					continue;
				}
				if (inFlight.has(request.requestId)) continue;
				inFlight.add(request.requestId);
				const task = (async () => {
					try {
						if (stopped) return;
						let result = pendingResults.get(request.requestId);
						if (!result) {
							let ok = false;
							let message = "Control request failed.";
							try {
								const control = state.foregroundControls.get(request.targetRunId);
								if (!control) {
									message = `Nested run ${request.targetRunId} is not active in this fanout child.`;
								} else if (request.action === "interrupt") {
									ok = control.interrupt?.() === true;
									message = ok
										? `Interrupt requested for nested run ${request.targetRunId}.`
										: `Nested run ${request.targetRunId} has no active child step to interrupt.`;
								} else if (!request.message?.trim()) {
									message = "Nested resume requires message.";
								} else if (!control.currentAgent) {
									message = `Nested run ${request.targetRunId} has no active child message route.`;
								} else {
									const index = control.currentIndex ?? 0;
									const target = resolveSubagentIntercomTarget(request.targetRunId, control.currentAgent, index);
									ok = await deliverSubagentIntercomMessageEvent(
										pi.events,
										target,
										`Follow-up for nested run ${request.targetRunId} (${control.currentAgent}):\n\n${request.message.trim()}`,
										500,
										{ source: "nested-resume", runId: request.targetRunId, agent: control.currentAgent, index },
									);
									message = ok
										? `Delivered follow-up to live nested run ${request.targetRunId}.`
										: `Nested child intercom target is not registered: ${target}`;
								}
							} catch (error) {
								message = error instanceof Error ? error.message : String(error);
							}
							result = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok, message };
						}
						try {
							writeControlResult(route, result);
						} catch (error) {
							pendingResults.set(request.requestId, result);
							logError(`Failed to write nested control result for request '${request.requestId}' targeting '${request.targetRunId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
							return;
						}
						pendingResults.delete(request.requestId);
						seen.add(request.requestId);
						try { unlinkControlRequest(request.filePath); } catch {}
					} finally {
						inFlight.delete(request.requestId);
					}
				})();
				pendingTasks.add(task);
				void task.then(
					() => pendingTasks.delete(task),
					() => pendingTasks.delete(task),
				);
			}
		} catch (error) {
			logError(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	let stopPromise: Promise<void> | undefined;
	return {
		stop(): Promise<void> {
			if (stopPromise) return stopPromise;
			stopPromise = (async () => {
				if (!stopped) {
					stopped = true;
					clearInterval(timer);
				}
				while (pendingTasks.size > 0) {
					await Promise.allSettled([...pendingTasks]);
				}
			})();
			return stopPromise;
		},
	};
}

export default async function registerFanoutChildSubagentExtension(pi: ExtensionAPI, deps: FanoutChildExtensionDeps = {}): Promise<void> {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const config = loadConfig();
	const state = deps.state ?? createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault: config.asyncByDefault === true,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Allowed management/control actions: list, get, status, interrupt, resume, doctor.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		parameters: SubagentParams,
		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as SubagentParamsLike, signal, onUpdate, ctx);
		},
	};

	pi.registerTool(tool);

	const inboxHandoff: NestedControlInboxHandoff = {
		pendingResults: new Map(),
		seenRequestIds: new Set(),
	};
	let listener: NestedControlInboxListener | undefined;
	let desiredRunning = false;
	let predecessorDrain: Promise<NestedControlInboxHandoff | undefined> = Promise.resolve(undefined);
	let predecessorAbsorb: Promise<void> | undefined;
	const absorbPredecessorHandoff = (): Promise<void> => {
		if (predecessorAbsorb) return predecessorAbsorb;
		predecessorAbsorb = predecessorDrain.then((predecessorHandoff) => {
			if (predecessorHandoff) mergeNestedControlInboxHandoff(inboxHandoff, predecessorHandoff);
		});
		return predecessorAbsorb;
	};
	let transition = Promise.resolve();
	const enqueueTransition = (operation: () => Promise<void>): Promise<void> => {
		const next = transition.then(operation, operation);
		transition = next.catch(() => {});
		return next;
	};
	const lifecycle: StoppableLifecycle & { start(): Promise<void> } = {
		start(): Promise<void> {
			desiredRunning = true;
			return enqueueTransition(async () => {
				await absorbPredecessorHandoff();
				const current = listener;
				listener = undefined;
				await current?.stop();
				if (desiredRunning && globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY] === lifecycle) {
					listener = startNestedControlInboxListener(pi, state, deps, inboxHandoff);
				}
			});
		},
		stop(): Promise<NestedControlInboxHandoff> {
			desiredRunning = false;
			const current = listener;
			listener = undefined;
			const currentStop = current?.stop();
			return enqueueTransition(async () => {
				await absorbPredecessorHandoff();
				await currentStop;
				const lateListener = listener;
				listener = undefined;
				await lateListener?.stop();
			}).then(() => inboxHandoff);
		},
	};

	// Publish the new owner before draining the previous one so stale lifecycle hooks cannot
	// restart it. The predecessor barrier and state handoff are transitive across overlapping reloads.
	const previous = asStoppable(globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY]);
	globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY] = lifecycle;
	predecessorDrain = Promise.resolve()
		.then(() => previous?.stop())
		.then((value) => asNestedControlInboxHandoff(value));
	await absorbPredecessorHandoff();
	if (globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY] !== lifecycle) return;

	pi.on("session_start", async () => {
		if (globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY] !== lifecycle) return;
		await lifecycle.start();
	});
	pi.on("session_shutdown", async () => {
		await lifecycle.stop();
		if (globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY] === lifecycle) {
			delete globalStore[FANOUT_CHILD_CONTROL_LIFECYCLE_KEY];
		}
	});
}
