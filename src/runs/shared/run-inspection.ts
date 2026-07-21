/**
 * Attach/detach + compact run inspection (M12.3).
 *
 * Attach verifies owner epoch/capability for nested (and async-with-route)
 * targets, then durably records an Attachment. Detach revokes that record only
 * — it never submits live-control requests and never touches the child.
 *
 * inspectRun returns a compact RunInspection summary (NestedRunSummary fields
 * only). No transcript, no full UI contract.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	RESULTS_DIR,
	type ActivityState,
	type AsyncJobState,
	type NestedRouteInfo,
	type NestedRunState,
	type NestedRunSummary,
	type NestedStepSummary,
	type SubagentRunMode,
	type SubagentState,
	type TokenUsage,
} from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import {
	resolveSubagentRunId,
	type ResolveSubagentRunIdDeps,
	type ResolvedSubagentRunId,
} from "../background/run-id-resolver.ts";
import {
	readLiveControlOwnerEpoch,
	type NestedRoute,
} from "./nested-events.ts";
import {
	deleteAttachment,
	recordAttachment,
	type Attachment,
} from "./run-attachment-store.ts";

export type { Attachment } from "./run-attachment-store.ts";

export interface RunInspectionStepsSummary {
	count: number;
	current?: number;
	chainStepCount?: number;
	agents?: string[];
	/** Compact per-step status only — no transcript/output. */
	statuses?: Array<{ agent: string; status: NestedStepSummary["status"] }>;
}

export interface RunInspection {
	id: string;
	kind: "foreground" | "async" | "nested";
	state: NestedRunState | AsyncJobState["status"] | "unknown";
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	pid?: number;
	activityState?: ActivityState;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: TokenUsage;
	currentTool?: string;
	currentToolStartedAt?: number;
	lastActivityAt?: number;
	steps?: RunInspectionStepsSummary;
	startedAt?: number;
	endedAt?: number;
	error?: string;
}

export interface AttachToRunOptions {
	/** Zero-based child index for multi-child targets; defaults to 0 for single. */
	index?: number;
	/** Override attach timestamp (tests). */
	now?: number;
	/** Stable attachment id (tests / idempotent re-attach). */
	attachmentId?: string;
}

export type AttachToRunResult =
	| { ok: true; attachment: Attachment }
	| { ok: false; error: string };

export interface InspectRunOptions {
	/** Zero-based child index for multi-child targets; defaults to 0 for single. */
	index?: number;
}

function resolveDeps(deps: ResolveSubagentRunIdDeps = {}): ResolveSubagentRunIdDeps {
	return deps;
}

function liveControlChildKey(
	label: string,
	mode: SubagentRunMode | undefined,
	index: number | undefined,
	knownChildCount?: number,
): string {
	if (index !== undefined) {
		if (!Number.isInteger(index) || index < 0) {
			throw new Error(`${label} index must be a non-negative integer.`);
		}
		if (knownChildCount !== undefined && index >= knownChildCount) {
			throw new Error(`${label} has ${knownChildCount} children. Index ${index} is out of range.`);
		}
		return String(index);
	}
	if (mode === "parallel" || mode === "chain" || (knownChildCount !== undefined && knownChildCount > 1)) {
		throw new Error(`${label} targets a ${mode ?? "multi-child"} run. Provide index to choose the exact live child.`);
	}
	return "0";
}

function verifyOwnerEpoch(
	route: NestedRouteInfo,
	childKey: string,
): { ok: true; epoch: string } | { ok: false; error: string } {
	const owner = readLiveControlOwnerEpoch(route as NestedRoute, childKey);
	if (!owner) {
		return {
			ok: false,
			error: "No live control owner is registered for this run; it may not have started its control listener yet, or it has already exited.",
		};
	}
	if (owner.closedAt !== undefined) {
		return {
			ok: false,
			error: "Live control owner epoch is closed; the run has exited or rotated ownership.",
		};
	}
	if (owner.capabilityToken !== route.capabilityToken) {
		return {
			ok: false,
			error: "Capability token does not match the live control owner for this route.",
		};
	}
	return { ok: true, epoch: owner.epoch };
}

function compactStepsFromNested(run: NestedRunSummary): RunInspectionStepsSummary | undefined {
	const steps = run.steps;
	const count = steps?.length ?? run.agents?.length ?? 0;
	if (count === 0 && run.currentStep === undefined && run.chainStepCount === undefined) return undefined;
	return {
		count,
		...(run.currentStep !== undefined ? { current: run.currentStep } : {}),
		...(run.chainStepCount !== undefined ? { chainStepCount: run.chainStepCount } : {}),
		...(run.agents ? { agents: run.agents } : {}),
		...(steps && steps.length > 0
			? { statuses: steps.map((step) => ({ agent: step.agent, status: step.status })) }
			: {}),
	};
}

function compactStepsFromAsync(
	job: Pick<AsyncJobState, "steps" | "agents" | "currentStep" | "chainStepCount" | "stepsTotal">,
): RunInspectionStepsSummary | undefined {
	const steps = job.steps;
	const count = steps?.length ?? job.stepsTotal ?? job.agents?.length ?? 0;
	if (count === 0 && job.currentStep === undefined && job.chainStepCount === undefined) return undefined;
	return {
		count,
		...(job.currentStep !== undefined ? { current: job.currentStep } : {}),
		...(job.chainStepCount !== undefined ? { chainStepCount: job.chainStepCount } : {}),
		...(job.agents ? { agents: job.agents } : {}),
		...(steps && steps.length > 0
			? {
					statuses: steps.map((step) => ({
						agent: typeof step.agent === "string" ? step.agent : "unknown",
						status: step.status,
					})),
				}
			: {}),
	};
}

function inspectionFromNested(id: string, run: NestedRunSummary): RunInspection {
	return {
		id,
		kind: "nested",
		state: run.state,
		...(run.mode ? { mode: run.mode } : {}),
		...(run.agent ? { agent: run.agent } : {}),
		...(run.agents ? { agents: run.agents } : {}),
		...(typeof run.pid === "number" ? { pid: run.pid } : {}),
		...(run.activityState ? { activityState: run.activityState } : {}),
		...(typeof run.turnCount === "number" ? { turnCount: run.turnCount } : {}),
		...(typeof run.toolCount === "number" ? { toolCount: run.toolCount } : {}),
		...(run.totalTokens ? { totalTokens: run.totalTokens } : {}),
		...(run.currentTool ? { currentTool: run.currentTool } : {}),
		...(typeof run.currentToolStartedAt === "number" ? { currentToolStartedAt: run.currentToolStartedAt } : {}),
		...(typeof run.lastActivityAt === "number" ? { lastActivityAt: run.lastActivityAt } : {}),
		...(compactStepsFromNested(run) ? { steps: compactStepsFromNested(run) } : {}),
		...(typeof run.startedAt === "number" ? { startedAt: run.startedAt } : {}),
		...(typeof run.endedAt === "number" ? { endedAt: run.endedAt } : {}),
		...(run.error ? { error: run.error } : {}),
	};
}

function inspectionFromForeground(
	id: string,
	control: NonNullable<SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never>,
): RunInspection {
	const nestedChild = control.nestedChildren?.[0] ?? control.children?.[0];
	const state: NestedRunState = "running";
	const totalTokens =
		typeof control.tokens === "number"
			? { input: 0, output: 0, total: control.tokens }
			: nestedChild?.totalTokens;
	return {
		id,
		kind: "foreground",
		state,
		mode: control.mode,
		...(control.currentAgent ? { agent: control.currentAgent } : {}),
		...(typeof nestedChild?.pid === "number" ? { pid: nestedChild.pid } : {}),
		...(control.currentActivityState ? { activityState: control.currentActivityState } : {}),
		...(typeof control.turnCount === "number" ? { turnCount: control.turnCount } : {}),
		...(typeof control.toolCount === "number" ? { toolCount: control.toolCount } : {}),
		...(totalTokens ? { totalTokens } : {}),
		...(control.currentTool ? { currentTool: control.currentTool } : {}),
		...(typeof control.currentToolStartedAt === "number" ? { currentToolStartedAt: control.currentToolStartedAt } : {}),
		...(typeof control.lastActivityAt === "number" ? { lastActivityAt: control.lastActivityAt } : {}),
		...(typeof control.startedAt === "number" ? { startedAt: control.startedAt } : {}),
		...(nestedChild?.error ? { error: nestedChild.error } : {}),
		...(nestedChild ? compactStepsFromNested(nestedChild) ? { steps: compactStepsFromNested(nestedChild) } : {} : {}),
	};
}

function inspectionFromAsyncJob(id: string, job: AsyncJobState): RunInspection {
	const mappedState: RunInspection["state"] =
		job.status === "queued" || job.status === "running" || job.status === "complete" || job.status === "failed" || job.status === "paused"
			? job.status
			: "unknown";
	return {
		id,
		kind: "async",
		state: mappedState,
		...(job.mode ? { mode: job.mode } : {}),
		...(job.agents?.[0] ? { agent: job.agents[0] } : {}),
		...(job.agents ? { agents: job.agents } : {}),
		...(typeof job.pid === "number" ? { pid: job.pid } : {}),
		...(job.activityState ? { activityState: job.activityState } : {}),
		...(typeof job.turnCount === "number" ? { turnCount: job.turnCount } : {}),
		...(typeof job.toolCount === "number" ? { toolCount: job.toolCount } : {}),
		...(job.totalTokens ? { totalTokens: job.totalTokens } : {}),
		...(job.currentTool ? { currentTool: job.currentTool } : {}),
		...(typeof job.currentToolStartedAt === "number" ? { currentToolStartedAt: job.currentToolStartedAt } : {}),
		...(typeof job.lastActivityAt === "number" ? { lastActivityAt: job.lastActivityAt } : {}),
		...(compactStepsFromAsync(job) ? { steps: compactStepsFromAsync(job) } : {}),
		...(typeof job.startedAt === "number" ? { startedAt: job.startedAt } : {}),
	};
}

function inspectionFromAsyncStatus(id: string, asyncDir: string | null, resultPath: string | null): RunInspection | undefined {
	if (asyncDir) {
		const status = readStatus(asyncDir);
		if (status) {
			return {
				id,
				kind: "async",
				state: status.state,
				mode: status.mode,
				...(typeof status.pid === "number" ? { pid: status.pid } : {}),
				...(status.activityState ? { activityState: status.activityState } : {}),
				...(typeof status.turnCount === "number" ? { turnCount: status.turnCount } : {}),
				...(typeof status.toolCount === "number" ? { toolCount: status.toolCount } : {}),
				...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
				...(status.currentTool ? { currentTool: status.currentTool } : {}),
				...(typeof status.currentToolStartedAt === "number" ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
				...(typeof status.lastActivityAt === "number" ? { lastActivityAt: status.lastActivityAt } : {}),
				...(compactStepsFromAsync({
					steps: status.steps,
					currentStep: status.currentStep,
					chainStepCount: status.chainStepCount,
					agents: status.steps?.map((step) => step.agent),
				})
					? {
							steps: compactStepsFromAsync({
								steps: status.steps,
								currentStep: status.currentStep,
								chainStepCount: status.chainStepCount,
								agents: status.steps?.map((step) => step.agent),
							}),
						}
					: {}),
				...(typeof status.startedAt === "number" ? { startedAt: status.startedAt } : {}),
				...(typeof status.endedAt === "number" ? { endedAt: status.endedAt } : {}),
			};
		}
	}

	const resolvedResultPath = resultPath ?? path.join(RESULTS_DIR, `${id}.json`);
	if (!fs.existsSync(resolvedResultPath)) return undefined;
	try {
		const raw = JSON.parse(fs.readFileSync(resolvedResultPath, "utf-8")) as {
			id?: string;
			runId?: string;
			success?: boolean;
			state?: string;
			exitCode?: number;
			summary?: string;
			error?: string;
			startedAt?: number;
			endedAt?: number;
			totalTokens?: TokenUsage;
			turnCount?: number;
			toolCount?: number;
			mode?: SubagentRunMode;
			agent?: string;
		};
		const state: NestedRunState =
			raw.state === "paused"
				? "paused"
				: raw.success === true || raw.exitCode === 0
					? "complete"
					: "failed";
		return {
			id,
			kind: "async",
			state,
			...(raw.mode ? { mode: raw.mode } : {}),
			...(raw.agent ? { agent: raw.agent } : {}),
			...(typeof raw.turnCount === "number" ? { turnCount: raw.turnCount } : {}),
			...(typeof raw.toolCount === "number" ? { toolCount: raw.toolCount } : {}),
			...(raw.totalTokens ? { totalTokens: raw.totalTokens } : {}),
			...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
			...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
			...(raw.error ? { error: raw.error } : raw.success === false && raw.summary ? { error: raw.summary } : {}),
		};
	} catch {
		return undefined;
	}
}

/**
 * Attach to a live run for compact inspection (and to record the verified
 * route/childKey/epoch tuple). Does not submit any live-control request.
 */
export function attachToRun(
	id: string,
	deps: ResolveSubagentRunIdDeps = {},
	options: AttachToRunOptions = {},
): AttachToRunResult {
	let resolved: ResolvedSubagentRunId | undefined;
	try {
		resolved = resolveSubagentRunId(id, resolveDeps(deps));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!resolved) {
		return { ok: false, error: `No subagent run matched '${id}'.` };
	}

	const attachedAt = options.now ?? Date.now();
	const attachmentId = options.attachmentId ?? randomUUID();

	if (resolved.kind === "foreground") {
		const control = deps.state?.foregroundControls.get(resolved.id);
		if (!control) {
			return { ok: false, error: `Foreground run '${resolved.id}' is not live in this session.` };
		}
		// Foreground is already in-memory; attach is a durable no-op bookkeeping record.
		const attachment = recordAttachment({
			attachmentId,
			id: resolved.id,
			kind: "foreground",
			attachedAt,
			note: "foreground, in-memory",
			...(control.nestedRoute
				? (() => {
						try {
							const childKey = liveControlChildKey(
								`Foreground run '${resolved.id}'`,
								control.mode,
								options.index,
							);
							const verified = verifyOwnerEpoch(control.nestedRoute, childKey);
							if (!verified.ok) return {};
							return {
								route: control.nestedRoute,
								childKey,
								epoch: verified.epoch,
							};
						} catch {
							return {};
						}
					})()
				: {}),
		});
		return { ok: true, attachment };
	}

	if (resolved.kind === "async") {
		const job = deps.state?.asyncJobs.get(resolved.id);
		const route = job?.nestedRoute;
		let childKey: string | undefined;
		let epoch: string | undefined;
		if (route) {
			try {
				childKey = liveControlChildKey(
					`Async run '${resolved.id}'`,
					job?.mode,
					options.index,
					job?.agents?.length ?? job?.stepsTotal,
				);
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			const verified = verifyOwnerEpoch(route, childKey);
			if (verified.ok === false) {
				// Async may still be attachable for inspection without a live owner
				// (completed/result-only). Only require epoch when the job is live.
				if (job && (job.status === "queued" || job.status === "running")) {
					return { ok: false, error: verified.error };
				}
				childKey = undefined;
			} else {
				epoch = verified.epoch;
			}
		}

		const attachment = recordAttachment({
			attachmentId,
			id: resolved.id,
			kind: "async",
			attachedAt,
			note: "async",
			...(route && childKey && epoch ? { route, childKey, epoch } : {}),
		});
		return { ok: true, attachment };
	}

	// nested
	const match = resolved.match;
	if (match.run.state !== "running" && match.run.state !== "queued" && match.run.state !== "paused") {
		// Allow attach only to non-terminal? Spec says live nested run. Completed nested:
		// reject attach with honest error (inspection still works via inspectRun).
		if (match.run.state === "complete" || match.run.state === "failed") {
			return {
				ok: false,
				error: `Nested run '${resolved.id}' is not live (state: ${match.run.state}). Use inspectRun for completed-run inspection.`,
			};
		}
	}

	let childKey: string;
	try {
		childKey = liveControlChildKey(
			`Nested run '${resolved.id}'`,
			match.run.mode,
			options.index,
			match.run.agents?.length ?? match.run.steps?.length,
		);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}

	const verified = verifyOwnerEpoch(match.route, childKey);
	if (verified.ok === false) {
		return { ok: false, error: verified.error };
	}

	const attachment = recordAttachment({
		attachmentId,
		id: resolved.id,
		kind: "nested",
		route: match.route,
		childKey,
		epoch: verified.epoch,
		attachedAt,
	});
	return { ok: true, attachment };
}

/**
 * Detach from a previously attached run. Revokes the attachment record only.
 * Idempotent. Does not send any control request to the child.
 */
export function detachFromRun(attachmentId: string): void {
	deleteAttachment(attachmentId);
}

/**
 * Compact inspection of a live or completed run. Returns undefined when the
 * run cannot be resolved. Never includes transcript or full UI contract fields.
 */
export function inspectRun(
	id: string,
	deps: ResolveSubagentRunIdDeps = {},
	_options: InspectRunOptions = {},
): RunInspection | undefined {
	let resolved: ResolvedSubagentRunId | undefined;
	try {
		resolved = resolveSubagentRunId(id, resolveDeps(deps));
	} catch {
		return undefined;
	}
	if (!resolved) return undefined;

	if (resolved.kind === "foreground") {
		const control = deps.state?.foregroundControls.get(resolved.id);
		if (!control) return undefined;
		return inspectionFromForeground(resolved.id, control);
	}

	if (resolved.kind === "async") {
		const job = deps.state?.asyncJobs.get(resolved.id);
		if (job) return inspectionFromAsyncJob(resolved.id, job);
		return inspectionFromAsyncStatus(resolved.id, resolved.location.asyncDir, resolved.location.resultPath);
	}

	return inspectionFromNested(resolved.id, resolved.match.run);
}
