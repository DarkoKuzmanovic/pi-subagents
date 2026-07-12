import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildModelCandidates,
	isRetryableModelFailure,
	isTransportFailure,
	resolveModelCandidate,
} from "../../src/runs/shared/model-fallback.ts";

describe("model fallback helpers", () => {
	const availableModels = [
		{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
		{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
	];

	it("keeps explicit provider/model ids unchanged", () => {
		assert.equal(resolveModelCandidate("openai/gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("resolves a bare id when there is exactly one registry match", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini", availableModels), "openai/gpt-5-mini");
	});

	it("preserves thinking suffix when resolving a bare id", () => {
		assert.equal(resolveModelCandidate("gpt-5-mini:high", availableModels), "openai/gpt-5-mini:high");
	});

	it("leaves ambiguous bare ids untouched", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous), "gpt-5-mini");
	});

	it("prefers the current provider when an ambiguous bare id exists there", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.equal(resolveModelCandidate("gpt-5-mini", ambiguous, "github-copilot"), "github-copilot/gpt-5-mini");
	});

	it("falls back to the unique registry match when the current provider does not offer the model", () => {
		assert.equal(resolveModelCandidate("claude-sonnet-4", availableModels, "github-copilot"), "anthropic/claude-sonnet-4");
	});

	it("builds a deduplicated ordered candidate list", () => {
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["openai/gpt-5-mini", "anthropic/claude-sonnet-4", "gpt-5-mini"], availableModels),
			["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("applies the current provider preference to fallback candidates too", () => {
		const ambiguous = [
			...availableModels,
			{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
		];
		assert.deepEqual(
			buildModelCandidates("gpt-5-mini", ["gpt-5-mini", "anthropic/claude-sonnet-4"], ambiguous, "github-copilot"),
			["github-copilot/gpt-5-mini", "anthropic/claude-sonnet-4"],
		);
	});

	it("detects retryable provider/model failures", () => {
		assert.equal(isRetryableModelFailure("rate limit exceeded for provider"), true);
		assert.equal(isRetryableModelFailure("model unavailable"), true);
		assert.equal(isRetryableModelFailure("authentication failed"), true);
		assert.equal(isRetryableModelFailure("connection terminated"), true);
		assert.equal(isRetryableModelFailure("stream terminated unexpectedly"), true);
		assert.equal(isRetryableModelFailure("runaway output aborted: degenerate streaming loop detected"), true);
		assert.equal(isRetryableModelFailure("runaway output aborted: 30 MB of raw model events since last text or tool activity"), true);
		assert.equal(isRetryableModelFailure("Cannot read properties of undefined (reading 'input_tokens')"), true);
	});

	it("does not treat ordinary task/tool failures as retryable model failures", () => {
		assert.equal(isRetryableModelFailure("bash failed (exit 1): command not found"), false);
		assert.equal(isRetryableModelFailure("read failed (exit 1): no such file or directory"), false);
		assert.equal(isRetryableModelFailure("bash failed (exit 143): process terminated by signal"), false);
		assert.equal(isRetryableModelFailure("the build was terminated"), false);
		assert.equal(isRetryableModelFailure("Cannot read properties of undefined (reading 'project')"), false);
		assert.equal(isRetryableModelFailure(undefined), false);
	});
});

describe("isTransportFailure", () => {
	it("matches transport/connection drops", () => {
		assert.equal(isTransportFailure("WebSocket error"), true);
		assert.equal(isTransportFailure("websocket closed unexpectedly"), true);
		assert.equal(isTransportFailure("socket hang up"), true);
		assert.equal(isTransportFailure("stream terminated"), true);
		assert.equal(isTransportFailure("ECONNRESET"), true);
		assert.equal(isTransportFailure("network error"), true);
	});

	it("matches pi-ai's bare 'terminated' errorMessage (seen in production)", () => {
		assert.equal(isTransportFailure("terminated"), true);
		assert.equal(isTransportFailure(" Terminated. "), true);
		assert.equal(isRetryableModelFailure("terminated"), true);
	});

	it("does not match control-kill prose containing 'terminated'", () => {
		assert.equal(isTransportFailure("Process terminated after inactivity timeout."), false);
		assert.equal(isTransportFailure("the run was terminated by the user"), false);
	});

	it("does not match config/auth/quota failures", () => {
		assert.equal(isTransportFailure("401 unauthorized"), false);
		assert.equal(isTransportFailure("insufficient credit"), false);
		assert.equal(isTransportFailure("model not found"), false);
		assert.equal(isTransportFailure("400 invalid_request_error"), false);
		assert.equal(isTransportFailure(undefined), false);
	});
});
