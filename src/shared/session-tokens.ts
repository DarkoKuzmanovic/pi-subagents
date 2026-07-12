import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsage } from "./types.ts";
import { findLatestSessionFile } from "./utils.ts";

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const usage = entry.usage ?? entry.message?.usage;
				if (usage) {
					input += usage.inputTokens ?? usage.input ?? 0;
					output += usage.outputTokens ?? usage.output ?? 0;
				}
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}

/**
 * Accumulates per-run token usage across two distinct accounting domains:
 *  - Sequential steps share the run's ROOT session file, which grows cumulatively, so a
 *    step's usage is (root cumulative - running baseline).
 *  - Parallel tasks and sequential steps with their own dedicated session file report their
 *    usage directly and must NOT advance the root baseline — doing so corrupts the next
 *    sequential step's delta (undercount / negative delta silently dropped).
 * The display total sums both domains.
 */
export interface StepTokenLedger {
	/** A parallel task's usage (from its own parallel-N session dir or attempts). Display total only. */
	addParallel(tokens: TokenUsage): void;
	/** A sequential step sharing the ROOT session file: returns the delta vs the baseline and advances it. */
	advanceRootCumulative(rootCumulative: TokenUsage): TokenUsage;
	/** A step whose usage is already isolated (dedicated session file / attempts fallback). Baseline untouched. */
	addStandaloneStep(tokens: TokenUsage): void;
	/** Running display total across all domains. */
	readonly total: TokenUsage;
}

export function createStepTokenLedger(): StepTokenLedger {
	let baseline: TokenUsage = { input: 0, output: 0, total: 0 };
	const runningTotal: TokenUsage = { input: 0, output: 0, total: 0 };
	const add = (t: TokenUsage): void => {
		runningTotal.input += t.input;
		runningTotal.output += t.output;
		runningTotal.total += t.total;
	};
	return {
		addParallel(tokens) {
			add(tokens);
		},
		advanceRootCumulative(rootCumulative) {
			const delta: TokenUsage = {
				input: rootCumulative.input - baseline.input,
				output: rootCumulative.output - baseline.output,
				total: rootCumulative.total - baseline.total,
			};
			baseline = { ...rootCumulative };
			add(delta);
			return delta;
		},
		addStandaloneStep(tokens) {
			add(tokens);
		},
		get total() {
			return { ...runningTotal };
		},
	};
}
