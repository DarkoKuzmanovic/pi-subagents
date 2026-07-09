import * as fs from "node:fs";
import * as path from "node:path";
import { hasDeliveredIntercomMarker, removeDeliveredIntercomMarker, writeDeliveredIntercomMarker } from "./async-om-delivery-marker.ts";
import { hasPendingOmOutboxes, hasPendingOmOutboxesOrReceipts, reconcileOmOutboxesForRun, scanAsyncRunsWithPendingOutboxes } from "./async-om-retention.ts";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.ts";
import { createFileCoalescer } from "../../shared/file-coalescer.ts";
import {
	ASYNC_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_BUDGET_EXHAUSTED_EVENT,
	type IntercomEventBus,
	type BudgetExhaustedEvent,
	type BudgetSummary,
	type SubagentState,
} from "../../shared/types.ts";
import {
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	resolveSubagentResultStatus,
} from "../../intercom/result-intercom.ts";

const WATCHER_RESTART_DELAY_MS = 3000;
const WATCHER_POLL_INTERVAL_MS = 3000;

type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "watch">;

type ResultWatcherTimers = {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	setInterval: typeof setInterval;
	clearInterval: typeof clearInterval;
};

type ResultWatcherDeps = {
	fs?: ResultWatcherFs;
	/** Root directory containing per-run async directories. Defaults to ASYNC_DIR; overridable for tests. */
	asyncRunsDir?: string;
	timers?: ResultWatcherTimers;
};

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === "ENOENT";
}

function shouldFallBackToPolling(error: unknown): boolean {
	const code = getErrorCode(error);
	return code === "EMFILE" || code === "ENOSPC";
}

export function createResultWatcher(
	pi: { events: IntercomEventBus },
	state: SubagentState,
	resultsDir: string,
	completionTtlMs: number,
	deps: ResultWatcherDeps = {},
): {
	startResultWatcher: () => void;
	primeExistingResults: () => void;
	stopResultWatcher: () => void;
} {
	const fsApi = deps.fs ?? fs;
	const asyncRunsDir = deps.asyncRunsDir ?? ASYNC_DIR;
	const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };

	const handleResult = async (file: string) => {
		const resultPath = path.join(resultsDir, file);
		if (!fsApi.existsSync(resultPath)) return;
		let completionKey: string | undefined;
		let completionMarkedNow = false;
		try {
			const data = JSON.parse(fsApi.readFileSync(resultPath, "utf-8")) as {
				id?: string;
				runId?: string;
				agent?: string;
				success?: boolean;
				state?: string;
				mode?: string;
				summary?: string;
				results?: Array<{
					agent?: string;
					output?: string;
					error?: string;
					success?: boolean;
					sessionFile?: string;
					artifactPaths?: { outputPath?: string };
					intercomTarget?: string;
				}>;
				sessionId?: string;
				cwd?: string;
				sessionFile?: string;
				asyncDir?: string;
				intercomTarget?: string;
				budget?: BudgetSummary;
				budgetExhausted?: boolean;
			};
			if (data.sessionId && data.sessionId !== state.currentSessionId) return;
			if (!data.sessionId && data.cwd && data.cwd !== state.baseCwd) return;

			const now = Date.now();
			completionKey = buildCompletionKey(data, `result:${file}`);
			if (markSeenWithTtl(state.completionSeen, completionKey, now, completionTtlMs)) {
				// Same-process rescan of an already-delivered result: never unlink out from under a
				// still-pending OM outbox — leave the OM reconcile loop (see reconcilePendingOmOutboxes)
				// to finish the job once every outbox for this run has a validated receipt.
				if (data.asyncDir && hasPendingOmOutboxes(fsApi, data.asyncDir)) return;
				fsApi.unlinkSync(resultPath);
				return;
			}
			completionMarkedNow = true;

			const intercomTarget = data.intercomTarget?.trim();
			// M6.1 Phase 2B: a durable marker means intercom for this run already succeeded in a
			// prior (possibly since-restarted) watcher process — never redeliver it.
			const alreadyDeliveredForOm = data.asyncDir ? hasDeliveredIntercomMarker(fsApi, data.asyncDir) : false;
			// Tracks whether intercom delivery for this run has actually been confirmed (either just
			// now, or in a prior watcher process via the durable marker). Only a confirmed delivery may
			// ever cause a delivered marker to be (re)written below — a failed delivery must remain
			// eligible for retry on the next pass/restart.
			let intercomDeliveredForOm = alreadyDeliveredForOm;
			if (intercomTarget && !alreadyDeliveredForOm) {
				const childResults = Array.isArray(data.results) && data.results.length > 0
					? data.results
					: [{
						agent: data.agent,
						output: data.summary,
						success: data.success,
					}];
				const runId = data.runId ?? data.id ?? file.replace(/\.json$/i, "");
				const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain"
					? data.mode
					: childResults.length > 1 ? "chain" : "single";
				const payload = buildSubagentResultIntercomPayload({
					to: intercomTarget,
					runId,
					mode,
					source: "async",
					children: childResults.map((result = {}, index) => {
						const baseOutput = result.output ?? data.summary;
						const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
						const output = hasRealOutput ? baseOutput : "(no output)";
						const summary = result.success === false && result.error
							? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
							: output;
						const sessionPath = result.sessionFile ?? (childResults.length === 1 ? data.sessionFile : undefined);
						return {
							agent: result.agent ?? data.agent ?? `step-${index + 1}`,
							status: resolveSubagentResultStatus({
								success: result.success,
								state: data.state === "paused" || typeof result.success !== "boolean" ? data.state : undefined,
							}),
							summary,
							index,
							artifactPath: result.artifactPaths?.outputPath,
							...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
							intercomTarget: result.intercomTarget,
						};
					}),
					asyncId: data.id,
					asyncDir: data.asyncDir,
				});
				const delivered = await deliverSubagentResultIntercomEvent(pi.events, payload);
				intercomDeliveredForOm = delivered;
				if (!delivered) {
					console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
				}
			}

			if (data.budgetExhausted && data.budget) {
				const payload: BudgetExhaustedEvent = {
					runId: data.runId ?? data.id ?? file.replace(/\.json$/i, ""),
					mode: data.mode === "single" || data.mode === "parallel" || data.mode === "chain" ? data.mode : "chain",
					budget: data.budget,
				};
				pi.events.emit(SUBAGENT_BUDGET_EXHAUSTED_EVENT, payload);
			}

			pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, data);
			// M6.1 Phase 2B: retain result.json (and a durable delivery marker) past this eager-unlink
			// point until every OM outbox for this run has a validated receipt. Gate on
			// hasPendingOmOutboxesOrReceipts first so a run that was never OM-registered takes exactly
			// the same immediate-unlink path as before OM registration existed.
			let retainForOm = false;
			if (data.asyncDir && hasPendingOmOutboxesOrReceipts(fsApi, data.asyncDir)) {
				try {
					reconcileOmOutboxesForRun(fsApi, data.asyncDir);
				} catch (reconcileError) {
					console.error(`Async OM outbox reconciliation failed for '${data.asyncDir}':`, reconcileError);
				}
				try {
					if (hasPendingOmOutboxes(fsApi, data.asyncDir)) {
						retainForOm = true;
						if (intercomTarget && intercomDeliveredForOm) {
							writeDeliveredIntercomMarker(
								data.asyncDir,
								{ runId: data.runId ?? data.id ?? file.replace(/\.json$/i, ""), deliveredAt: new Date().toISOString() },
								{ mkdirSync: fsApi.mkdirSync },
							);
						}
					} else if (hasDeliveredIntercomMarker(fsApi, data.asyncDir)) {
						removeDeliveredIntercomMarker(fsApi, data.asyncDir);
					}
				} catch (omError) {
					console.error(`Async OM retention bookkeeping failed for '${data.asyncDir}':`, omError);
				}
			}
			if (!retainForOm) {
				fsApi.unlinkSync(resultPath);
			}
		} catch (error) {
			if (isNotFoundError(error)) return;
			// Delivery failed after the completion key was marked seen. Unmark it,
			// otherwise the retained result file would hit the dedupe branch on
			// retry and be unlinked WITHOUT ever emitting — permanently dropping
			// the result (mark-seen-before-delivery hazard).
			if (completionMarkedNow && completionKey) state.completionSeen.delete(completionKey);
			console.error(`Failed to process subagent result file '${resultPath}':`, error);
		}
	};

	state.resultFileCoalescer = createFileCoalescer((file) => {
		void handleResult(file);
	}, 50);

	// M6.1: durable, restart-safe retry for outboxes that were retained past a first reconcile
	// attempt (no receipt yet). Scans `asyncRunsDir` directly — independent of result.json, whose
	// dedupe state does not survive a watcher restart (see async-om-retention.ts header).
	const reconcilePendingOmOutboxes = () => {
		try {
			for (const pendingAsyncDir of scanAsyncRunsWithPendingOutboxes(fsApi, asyncRunsDir)) {
				reconcileOmOutboxesForRun(fsApi, pendingAsyncDir);
				if (!hasPendingOmOutboxes(fsApi, pendingAsyncDir)) {
					finalizeResolvedOmRun(pendingAsyncDir);
				}
			}
		} catch (error) {
			console.error(`Failed to reconcile pending async OM outboxes under '${asyncRunsDir}':`, error);
		}
	};

	// M6.1 Phase 2B: once every outbox for a run has a validated receipt, prune whatever was
	// retained on its behalf: the result.json (looked up by the run-id convention shared with
	// async-execution.ts: `<resultsDir>/<basename(asyncDir)>.json`) and the delivery marker.
	// Independent of handleResult's own prune-on-first-pass path — this is what finishes the job
	// for a receipt that lands only after result.json was already retained on a prior pass.
	const finalizeResolvedOmRun = (asyncDir: string) => {
		try {
			const retainedResultPath = path.join(resultsDir, `${path.basename(asyncDir)}.json`);
			if (fsApi.existsSync(retainedResultPath)) fsApi.unlinkSync(retainedResultPath);
		} catch (error) {
			console.error(`Failed to prune retained result for resolved async OM run '${asyncDir}':`, error);
		}
		try {
			if (hasDeliveredIntercomMarker(fsApi, asyncDir)) removeDeliveredIntercomMarker(fsApi, asyncDir);
		} catch (error) {
			console.error(`Failed to remove delivery marker for resolved async OM run '${asyncDir}':`, error);
		}
	};

	const primeExistingResults = () => {
		try {
			fsApi.readdirSync(resultsDir)
				.filter((file) => file.endsWith(".json"))
				.forEach((file) => {
					state.resultFileCoalescer.schedule(file, 0);
				});
		} catch (error) {
			if (isNotFoundError(error)) return;
			console.error(`Failed to scan subagent result directory '${resultsDir}':`, error);
		}
		reconcilePendingOmOutboxes();
	};

	const startPollingFallback = (reason: unknown) => {
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) return;

		console.error(
			`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${getErrorCode(reason) ?? "unknown error"}).`,
		);
		primeExistingResults();
		state.watcherRestartTimer = timers.setInterval(primeExistingResults, WATCHER_POLL_INTERVAL_MS);
		state.watcherRestartTimer.unref?.();
	};

	const scheduleRestart = () => {
		if (state.watcherRestartTimer) return;
		state.watcherRestartTimer = timers.setTimeout(() => {
			state.watcherRestartTimer = null;
			try {
				fsApi.mkdirSync(resultsDir, { recursive: true });
				startResultWatcher();
			} catch (error) {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
				scheduleRestart();
			}
		}, WATCHER_RESTART_DELAY_MS);
		state.watcherRestartTimer.unref?.();
	};

	// M6.1: independent of native-watch vs. polling-fallback mode, retained OM outboxes need a
	// periodic rescan even when no new result ever completes (fs.watch mode otherwise never
	// revisits `asyncRunsDir` on its own). Local to this closure — not state.watcherRestartTimer,
	// which polling-fallback already reuses for a different purpose.
	let omRetentionTimer: ReturnType<ResultWatcherTimers["setInterval"]> | null = null;
	const startOmRetentionPolling = () => {
		if (omRetentionTimer) return;
		omRetentionTimer = timers.setInterval(reconcilePendingOmOutboxes, WATCHER_POLL_INTERVAL_MS);
		omRetentionTimer.unref?.();
	};
	const stopOmRetentionPolling = () => {
		if (omRetentionTimer) {
			timers.clearInterval(omRetentionTimer);
			omRetentionTimer = null;
		}
	};

	const startResultWatcher = () => {
		startOmRetentionPolling();
		if (state.watcher) return;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
			state.watcherRestartTimer = null;
		}
		try {
			state.watcher = fsApi.watch(resultsDir, (ev, file) => {
				if (ev !== "rename" || !file) return;
				const fileName = file.toString();
				if (!fileName.endsWith(".json")) return;
				state.resultFileCoalescer.schedule(fileName);
			});
			state.watcher.on("error", (error) => {
				if (shouldFallBackToPolling(error)) {
					startPollingFallback(error);
					return;
				}
				console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
				state.watcher?.close();
				state.watcher = null;
				scheduleRestart();
			});
			state.watcher.unref?.();
		} catch (error) {
			if (shouldFallBackToPolling(error)) {
				startPollingFallback(error);
				return;
			}
			console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
			state.watcher = null;
			scheduleRestart();
		}
	};

	const stopResultWatcher = () => {
		stopOmRetentionPolling();
		state.watcher?.close();
		state.watcher = null;
		if (state.watcherRestartTimer) {
			timers.clearTimeout(state.watcherRestartTimer);
			timers.clearInterval(state.watcherRestartTimer);
		}
		state.watcherRestartTimer = null;
		state.resultFileCoalescer.clear();
	};

	return { startResultWatcher, primeExistingResults, stopResultWatcher };
}
