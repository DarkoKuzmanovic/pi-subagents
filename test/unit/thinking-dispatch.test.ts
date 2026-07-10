import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	applyEffectiveThinkingSuffix,
	applyThinkingSuffix,
	buildModelThinkingOverride,
	buildPiArgs,
	stripKnownThinkingSuffix,
} from "../../src/runs/shared/pi-args.ts";
import type { ParallelTaskItem } from "../../src/shared/settings.ts";
import { resolveParallelBehaviors, resolveStepBehavior } from "../../src/shared/settings.ts";
import { currentModelFullId } from "../../src/shared/model-info.ts";

// ============================================================================
// stripKnownThinkingSuffix
// ============================================================================

describe("stripKnownThinkingSuffix", () => {
	it("strips known thinking suffixes from model strings", () => {
		assert.equal(stripKnownThinkingSuffix("provider/model:high"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:off"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:minimal"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:low"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:medium"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:xhigh"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("provider/model:max"), "provider/model");
	});

	it("leaves models without thinking suffixes unchanged", () => {
		assert.equal(stripKnownThinkingSuffix("provider/model"), "provider/model");
		assert.equal(stripKnownThinkingSuffix("bare-model"), "bare-model");
	});

	it("does not strip unknown suffixes", () => {
		assert.equal(stripKnownThinkingSuffix("provider/model:custom"), "provider/model:custom");
	});

	it("handles models with multiple colons correctly", () => {
		assert.equal(stripKnownThinkingSuffix("provider/model:v2:high"), "provider/model:v2");
	});
});

// ============================================================================
// applyEffectiveThinkingSuffix
// ============================================================================

describe("applyEffectiveThinkingSuffix", () => {
	it("applies thinking suffix to bare model", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model", "high"), "provider/model:high");
	});

	it("replaces existing known suffix with new thinking level", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model:high", "low"), "provider/model:low");
		assert.equal(applyEffectiveThinkingSuffix("provider/model:max", "high"), "provider/model:high");
	});

	it("handles thinking off by stripping existing suffix", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model:high", "off"), "provider/model");
	});

	it("handles thinking off on bare model (no-op)", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model", "off"), "provider/model");
	});

	it("returns model unchanged when thinking is undefined", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model:high", undefined), "provider/model:high");
	});

	it("returns model unchanged when model is undefined", () => {
		assert.equal(applyEffectiveThinkingSuffix(undefined, "high"), undefined);
	});

	it("does not corrupt unknown suffixes", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model:v2", "high"), "provider/model:v2:high");
	});

	it("replaces suffix even with multiple colons in model", () => {
		assert.equal(applyEffectiveThinkingSuffix("provider/model:v2:high", "low"), "provider/model:v2:low");
	});
});

// ============================================================================
// current model fallback for inline thinking
// ============================================================================

describe("currentModelFullId", () => {
	it("derives provider/id from current model objects", () => {
		assert.equal(currentModelFullId({ provider: "provider", id: "model" }), "provider/model");
	});

	it("derives provider/modelId from replay-like model objects", () => {
		assert.equal(currentModelFullId({ provider: "provider", modelId: "model" }), "provider/model");
	});

	it("returns undefined when provider or id is missing", () => {
		assert.equal(currentModelFullId({ provider: "provider" }), undefined);
		assert.equal(currentModelFullId(undefined), undefined);
	});
});

// ============================================================================
// applyThinkingSuffix (existing behavior preserved)
// ============================================================================

describe("applyThinkingSuffix (existing behavior)", () => {
	it("treats off as no-op", () => {
		assert.equal(applyThinkingSuffix("provider/model", "off"), "provider/model");
	});

	it("guards against double suffixes", () => {
		assert.equal(applyThinkingSuffix("provider/model:high", "low"), "provider/model:high");
	});

	it("adds suffix to bare model", () => {
		assert.equal(applyThinkingSuffix("provider/model", "high"), "provider/model:high");
	});
});

// ============================================================================
// resolveStepBehavior thinking propagation
// ============================================================================

describe("resolveStepBehavior thinking propagation", () => {
	const baseAgentConfig = {
		name: "worker",
		model: "provider/model",
		thinking: "high",
		output: undefined as string | undefined,
		outputMode: "inline" as const,
		reads: undefined as string[] | false | undefined,
		progress: undefined as boolean | undefined,
		skills: undefined as string[] | false | undefined,
		systemPromptMode: "replace" as const,
		inheritProjectContext: false,
		inheritSkills: false,
		systemPrompt: "test",
		source: "builtin" as const,
		filePath: "/test",
		description: "test",
	};

	it("propagates step-level thinking override over agent config", () => {
		const behavior = resolveStepBehavior(baseAgentConfig, { thinking: "low" });
		assert.equal(behavior.thinking, "low");
	});

	it("falls back to agent thinking when step has no override", () => {
		const behavior = resolveStepBehavior(baseAgentConfig, {});
		assert.equal(behavior.thinking, "high");
	});

	it("propagates explicit off from step override", () => {
		const behavior = resolveStepBehavior(baseAgentConfig, { thinking: "off" });
		assert.equal(behavior.thinking, "off");
	});

	it("resolves thinking when agent has no thinking configured", () => {
		const agentNoThinking = { ...baseAgentConfig, thinking: undefined };
		const behavior = resolveStepBehavior(agentNoThinking, {});
		assert.equal(behavior.thinking, undefined);
	});

	it("step thinking overrides even when agent has thinking configured", () => {
		const behavior = resolveStepBehavior(baseAgentConfig, { thinking: "xhigh" });
		assert.equal(behavior.thinking, "xhigh");
	});
});

// ============================================================================
// Thinking precedence integration
// ============================================================================

describe("thinking precedence with model suffix", () => {
	it("off strips pre-existing model suffix from provider/model:high", () => {
		// Simulates: model was set with :high suffix (e.g., from hub), thinking: "off" should strip it
		const model = "anthropic/claude-sonnet-4:high";
		const thinking = "off";
		const result = applyEffectiveThinkingSuffix(model, thinking);
		assert.equal(result, "anthropic/claude-sonnet-4");
	});

	it("inline high replaces existing low suffix", () => {
		const model = "openai/gpt-5:low";
		const thinking = "high";
		const result = applyEffectiveThinkingSuffix(model, thinking);
		assert.equal(result, "openai/gpt-5:high");
	});

	it("no thinking leaves model suffix intact", () => {
		const model = "openai/gpt-5:high";
		const result = applyEffectiveThinkingSuffix(model, undefined);
		assert.equal(result, "openai/gpt-5:high");
	});

	it("chain step thinking is independent per step", () => {
		// Step 1: thinking "high"
		const step1Behavior = resolveStepBehavior(
			{ ...baseAgentConfig, thinking: undefined },
			{ thinking: "high" },
		);
		assert.equal(step1Behavior.thinking, "high");

		// Step 2: thinking "off" - does not inherit step 1's thinking
		const step2Behavior = resolveStepBehavior(
			{ ...baseAgentConfig, thinking: undefined },
			{ thinking: "off" },
		);
		assert.equal(step2Behavior.thinking, "off");
	});
});

const baseAgentConfig = {
	name: "worker",
	model: "provider/model",
	thinking: undefined as string | undefined,
	output: undefined as string | undefined,
	outputMode: "inline" as const,
	reads: undefined as string[] | false | undefined,
	progress: undefined as boolean | undefined,
	skills: undefined as string[] | false | undefined,
	systemPromptMode: "replace" as const,
	inheritProjectContext: false,
	inheritSkills: false,
	systemPrompt: "test",
	source: "builtin" as const,
	filePath: "/test",
	description: "test",
};

// --- buildPiArgs execution-level tests ---
function getModelArg(result: { args: string[] }): string | undefined {
	const idx = result.args.indexOf("--model");
	return idx >= 0 ? result.args[idx + 1] : undefined;
}

describe("buildPiArgs thinking integration", () => {
	it("strips :high suffix when thinking is off", () => {
		const result = buildPiArgs({
			baseArgs: ["--mode", "json"],
			task: "test",
			sessionEnabled: false,
			model: "openai/o3:high",
			thinking: "off",
		});
		assert.equal(getModelArg(result), "openai/o3");
	});

	it("applies inline thinking after stripping stale suffix", () => {
		const result = buildPiArgs({
			baseArgs: ["--mode", "json"],
			task: "test",
			sessionEnabled: false,
			model: "openai/o3:high",
			thinking: "medium",
		});
		assert.equal(getModelArg(result), "openai/o3:medium");
	});

	it("preserves model suffix when no thinking provided", () => {
		const result = buildPiArgs({
			baseArgs: ["--mode", "json"],
			task: "test",
			sessionEnabled: false,
			model: "openai/o3:high",
		});
		assert.equal(getModelArg(result), "openai/o3:high");
	});

	it("adds thinking suffix to bare model", () => {
		const result = buildPiArgs({
			baseArgs: ["--mode", "json"],
			task: "test",
			sessionEnabled: false,
			model: "openai/o3",
			thinking: "high",
		});
		assert.equal(getModelArg(result), "openai/o3:high");
	});

	it("omits --model when model is undefined", () => {
		const result = buildPiArgs({
			baseArgs: ["--mode", "json"],
			task: "test",
			sessionEnabled: false,
			model: undefined,
			thinking: "high",
		});
		assert.equal(getModelArg(result), undefined);
	});
});

describe("resolveParallelBehaviors thinking propagation", () => {
	const agentConfigs = [baseAgentConfig];

	it("includes task thinking in resolved behavior", () => {
		const tasks: ParallelTaskItem[] = [
			{ agent: "worker", task: "t1", thinking: "high" },
		];
		const result = resolveParallelBehaviors(tasks, agentConfigs, 0);
		assert.equal(result[0].thinking, "high");
	});

	it("falls back to agent config thinking when task omits it", () => {
		const tasks: ParallelTaskItem[] = [
			{ agent: "worker", task: "t1" },
		];
		const configWithThinking = { ...baseAgentConfig, thinking: "medium" as string | undefined };
		const result = resolveParallelBehaviors(tasks, [configWithThinking], 0);
		assert.equal(result[0].thinking, "medium");
	});

	it("task thinking overrides agent config thinking", () => {
		const tasks: ParallelTaskItem[] = [
			{ agent: "worker", task: "t1", thinking: "off" },
		];
		const configWithThinking = { ...baseAgentConfig, thinking: "high" as string | undefined };
		const result = resolveParallelBehaviors(tasks, [configWithThinking], 0);
		assert.equal(result[0].thinking, "off");
	});

	it("thinking is independent per parallel task", () => {
		const tasks: ParallelTaskItem[] = [
			{ agent: "worker", task: "t1", thinking: "high" },
			{ agent: "worker", task: "t2", thinking: "off" },
		];
		const result = resolveParallelBehaviors(tasks, agentConfigs, 0);
		assert.equal(result[0].thinking, "high");
		assert.equal(result[1].thinking, "off");
	});
});

// ============================================================================
// Subagent hub save: model suffix stripping when thinking override coexists
// ============================================================================

describe("subagent hub save: suffix stripping with thinking override", () => {
	it("strips :high suffix from model when separate thinking override is low", () => {
		const modelOverride = "provider/id:high";
		const stripped = stripKnownThinkingSuffix(modelOverride);
		assert.equal(stripped, "provider/id");
		assert.notEqual(stripped, modelOverride);
	});

	it("does not strip model without suffix when thinking override exists", () => {
		const modelOverride = "provider/id";
		const stripped = stripKnownThinkingSuffix(modelOverride);
		assert.equal(stripped, modelOverride);
	});

	it("strips :off suffix from model when thinking override is high", () => {
		const modelOverride = "provider/id:off";
		const stripped = stripKnownThinkingSuffix(modelOverride);
		assert.equal(stripped, "provider/id");
	});

	it("preserves unknown suffixes when thinking override exists", () => {
		const modelOverride = "provider/id:custom";
		const stripped = stripKnownThinkingSuffix(modelOverride);
		assert.equal(stripped, "provider/id:custom");
	});
});

// ============================================================================
// subagent hub save override construction
// ============================================================================

describe("buildModelThinkingOverride", () => {
	it("keeps bare model when saving model and thinking together", () => {
		assert.deepEqual(buildModelThinkingOverride("provider/id", "low"), {
			model: "provider/id",
			thinking: "low",
		});
	});

	it("strips known model suffix when saving separate thinking", () => {
		assert.deepEqual(buildModelThinkingOverride("provider/id:high", "low"), {
			model: "provider/id",
			thinking: "low",
		});
	});

	it("preserves model-only overrides", () => {
		assert.deepEqual(buildModelThinkingOverride("provider/id:high", undefined), {
			model: "provider/id:high",
		});
	});

	it("saves thinking-only overrides", () => {
		assert.deepEqual(buildModelThinkingOverride(undefined, "medium"), {
			thinking: "medium",
		});
	});
});

// ============================================================================
// runtime propagation guardrails
// ============================================================================

describe("foreground runtime thinking propagation", () => {
	const source = readFileSync(new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url), "utf8");

	it("passes resolved parallel task thinking into foreground runSync", () => {
		assert.match(source, /effectiveThinking:\s*behavior\?\.thinking/);
	});

	it("passes single clarify thinking into async background dispatch", () => {
		assert.match(source, /executeAsyncSingle\([\s\S]*thinking:\s*effectiveThinking[\s\S]*\}\);/);
	});
});
