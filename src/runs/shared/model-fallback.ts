import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { Usage } from "../../shared/types.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (model.includes("/")) return model;
	if (!availableModels || availableModels.length === 0) return model;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const matches = availableModels.filter((entry) => entry.id === baseModel);
	if (preferredProvider) {
		const preferredMatch = matches.find((entry) => entry.provider === preferredProvider);
		if (preferredMatch) return `${preferredMatch.fullId}${thinkingSuffix}`;
	}
	if (matches.length !== 1) return model;
	return `${matches[0]!.fullId}${thinkingSuffix}`;
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
		if (!raw) continue;
		const normalized = resolveModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS = [
	/rate\s*limit/i,
	/too many requests/i,
	/\b429\b/,
	/quota/i,
	/billing/i,
	/credit/i,
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
	/provider.*unavailable/i,
	/model.*unavailable/i,
	/model.*disabled/i,
	/model.*not found/i,
	/unknown model/i,
	/overloaded/i,
	/service unavailable/i,
	// The stream watchdog proves the current model is no longer making usable
	// progress. Retrying another configured model is safe; retrying the same one is not.
	/^runaway output aborted:/i,
	// MiniMax's Anthropic-compatible stream has emitted a terminal assistant error
	// when a usage-bearing event omits the expected usage object. Keep this narrow:
	// unrelated child TypeErrors remain ordinary task failures.
	/Cannot read properties of undefined \(reading ['"]input_tokens['"]\)/i,
	/temporar(?:ily)? unavailable/i,
	/connection refused/i,
	/fetch failed/i,
	/network error/i,
	/web\s?socket/i,
	/ws\s+(?:error|closed|disconnect)/i,
	/socket hang up/i,
	/(?:connection|stream|socket|request|response)\s+terminated/i,
	/terminated unexpectedly/i,
	// pi-ai reports a terminated streaming request as the bare errorMessage
	// "terminated" (seen in production). Anchored so prose like "process
	// terminated after inactivity timeout" never matches.
	/^\s*terminated\s*\.?\s*$/i,
	/upstream/i,
	/timed? out/i,
	/timeout/i,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export function isRetryableModelFailure(error: string | undefined): boolean {
	if (!error) return false;
	return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

/**
 * Tight transport/connection failure matcher (a strict subset of the retryable
 * patterns). Used for output-aware finalization: a transport error that struck
 * *after* an agent produced its declared output should not fail the run. We keep
 * this narrow so genuine config/auth/quota errors are never downgraded.
 */
const TRANSPORT_FAILURE_PATTERNS = [
	/web\s?socket/i,
	/ws\s+(?:error|closed|disconnect)/i,
	/socket hang up/i,
	/(?:connection|stream|socket|request|response)\s+terminated/i,
	/terminated unexpectedly/i,
	// Bare "terminated" is pi-ai's errorMessage for a terminated streaming
	// request — a transport failure. Anchored to the full string so control
	// kills ("process terminated after inactivity timeout") never match.
	/^\s*terminated\s*\.?\s*$/i,
	/network error/i,
	/econnreset/i,
	/epipe/i,
];

export function isTransportFailure(error: string | undefined): boolean {
	if (!error) return false;
	return TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
