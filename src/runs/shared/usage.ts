import type { ModelAttempt, TokenUsage, Usage } from "../../shared/types.js";

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/** Mutating accumulator — adds source fields into target in place. */
export function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

/**
 * Derive a TokenUsage ({ input, output, total }) by summing per-attempt Usage across
 * model attempts (including retries). Returns null when no attempt carries usage data so
 * callers can skip token bookkeeping. Used as a fallback for token accounting when
 * session-file parsing is unavailable (notably parallel runs without a session dir).
 */
export function tokenUsageFromAttempts(attempts: ModelAttempt[] | undefined): TokenUsage | null {
	if (!attempts || attempts.length === 0) return null;
	let input = 0;
	let output = 0;
	let sawUsage = false;
	for (const attempt of attempts) {
		if (!attempt?.usage) continue;
		sawUsage = true;
		input += attempt.usage.input;
		output += attempt.usage.output;
	}
	if (!sawUsage) return null;
	return { input, output, total: input + output };
}
