/**
 * Tool-call budgets for child subagents (upstream 0.33.0 parity, adapted).
 *
 * A budget is enforced inside the child process, because that is where tool calls actually happen:
 * the parent only ever observes `tool_execution_start` after the fact and cannot veto a call. The
 * child nudges itself once when it crosses the soft limit, and blocks budgeted tools once it
 * reaches the hard limit so a runaway explorer can still finish with a final text answer.
 *
 * Blocking is deliberately partial. A child whose every tool is blocked cannot report back, so the
 * tools it needs to return a result stay available even at a fully exhausted budget.
 */

import type { ToolBudget } from "../../shared/types.ts";

export type { ToolBudget };

/** Tools a child always keeps, so an exhausted budget can still produce a reportable result. */
export const TOOL_BUDGET_ALWAYS_ALLOWED: readonly string[] = ["structured_output", "contact_supervisor", "intercom"];

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Parse a user-supplied tool budget. Returns undefined when `hard` is missing or unusable. */
export function sanitizeToolBudget(value: unknown): ToolBudget | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const hard = positiveInt(record.hard);
	if (hard === undefined) return undefined;
	const budget: ToolBudget = { hard };
	const soft = positiveInt(record.soft);
	// A soft limit at or above the hard limit could never fire before blocking starts, so drop it
	// rather than silently keeping a value that reads as configured but never applies.
	if (soft !== undefined && soft < hard) budget.soft = soft;
	if (Array.isArray(record.block)) {
		const block = [...new Set(record.block.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))];
		if (block.length > 0) budget.block = block;
	}
	return budget;
}

/** Whether this tool is subject to the hard limit. */
export function isBudgetedTool(toolName: string, budget: ToolBudget): boolean {
	if (budget.block?.length) return budget.block.includes(toolName);
	return !TOOL_BUDGET_ALWAYS_ALLOWED.includes(toolName);
}

export interface ToolBudgetEnforcer {
	/** Tool calls allowed so far. Blocked attempts do not count, so the reported figure stays truthful. */
	used(): number;
	/** Decide one tool call before it executes. */
	onToolCall(toolName: string): { blocked: true; reason: string } | { blocked: false };
	/** One-time nudge text, returned the first time the soft limit has been crossed. */
	takeSoftNudge(): string | undefined;
}

export function createToolBudgetEnforcer(budget: ToolBudget): ToolBudgetEnforcer {
	let used = 0;
	let softNudgeDelivered = false;

	return {
		used: () => used,
		onToolCall(toolName: string) {
			if (used >= budget.hard && isBudgetedTool(toolName, budget)) {
				const remaining = budget.block?.length
					? `Tools still available: ${budget.block.length} blocked, everything else allowed.`
					: `Tools still available: ${TOOL_BUDGET_ALWAYS_ALLOWED.join(", ")}.`;
				return {
					blocked: true,
					reason: [
						`Tool budget exhausted: ${used} of ${budget.hard} tool calls used, and '${toolName}' is budgeted.`,
						remaining,
						"Stop exploring and finish now with your final answer from what you already know.",
					].join(" "),
				};
			}
			used += 1;
			return { blocked: false };
		},
		takeSoftNudge() {
			if (softNudgeDelivered || budget.soft === undefined || used < budget.soft) return undefined;
			softNudgeDelivered = true;
			return [
				`[tool budget] ${used} of ${budget.hard} tool calls used.`,
				`At ${budget.hard} the budgeted tools stop working, so start converging on a final answer now.`,
			].join(" ");
		},
	};
}
