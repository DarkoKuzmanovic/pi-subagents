/**
 * Token-economy footer for subagent tool results.
 * Appends a one-line summary showing fresh-context token savings.
 */

import type { Usage } from "./types.ts";

interface TokenFooterOptions {
	mode: string;
	hasError: boolean;
}

/** Format a number with K/M suffix. */
function fmt(n: number): string {
	if (n >= 1_000_000) {
		const s = (n / 1_000_000).toFixed(1);
		return `${s.endsWith(".0") ? s.slice(0, -2) : s}M`;
	}
	if (n >= 1_000) {
		const s = (n / 1_000).toFixed(1);
		return `${s.endsWith(".0") ? s.slice(0, -2) : s}K`;
	}
	return String(n);
}

/** Aggregate usage across multiple results. */
function aggregateUsage(results: { usage: Usage }[]): Usage {
	const agg: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		if (r.usage) {
			agg.input += r.usage.input;
			agg.output += r.usage.output;
			agg.cacheRead += r.usage.cacheRead;
			agg.cacheWrite += r.usage.cacheWrite;
			agg.cost += r.usage.cost;
			agg.turns += r.usage.turns;
		}
	}
	return agg;
}

/** Check if aggregated usage is all zeros. */
function isZeroUsage(u: Usage): boolean {
	return u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0;
}

/**
 * Format a token-economy footer line.
 * Returns null if the footer should be omitted (non-fresh mode, error, missing details, zero usage).
 */
export function formatTokenFooter(
	details: { results?: { usage: Usage }[] } | undefined,
	options: TokenFooterOptions,
): string | null {
	if (!details) return null;
	if (options.mode !== "fresh") return null;
	if (options.hasError) return null;

	const results = details.results;
	if (!results || results.length === 0) return null;

	const usage = aggregateUsage(results);
	if (isZeroUsage(usage)) return null;

	return `[mode=fresh, in=${fmt(usage.input)}, out=${fmt(usage.output)}, cache_read=${fmt(usage.cacheRead)}, cache_write=${fmt(usage.cacheWrite)}]`;
}

/**
 * Append a token-economy footer to the result text if applicable.
 * Returns the (possibly modified) text.
 */
export function appendTokenFooter(
	text: string,
	details: { results?: { usage: Usage }[] } | undefined,
	options: TokenFooterOptions,
): string {
	const footer = formatTokenFooter(details, options);
	if (!footer) return text;
	return `${text}\n\n${footer}`;
}
