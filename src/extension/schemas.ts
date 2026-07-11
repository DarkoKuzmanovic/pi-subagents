/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";
import { SUBAGENT_ACTIONS } from "../shared/types.ts";
import { THINKING_LEVELS } from "../shared/model-info.ts";

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "Skill name(s) to inject (comma-separated), array of strings, or boolean (false disables, true uses default)",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean" },
	],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "Return saved output inline (default) or only a concise file reference. file-only requires output to be a path.",
});

const MaxOutputParam = Type.Object(
	{
		bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum UTF-8 bytes returned inline after the child finishes." })),
		lines: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines returned inline after the child finishes." })),
	},
	{
		description: "Post-run truncation limits for model-visible returned text. Full output remains in artifacts/session data. This does not limit model generation or child runtime.",
	},
);

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running (array of filenames, supports globs like src/**/*.ts), or false to disable",
});

const AsParam = Type.String({ description: "Store this step/task output under this name for later {outputs.name} references in the chain. Must match /^[A-Za-z_][A-Za-z0-9_]*$/ and be unique across the chain." });
const OutputSchemaParam = Type.Unsafe<Record<string, unknown>>({ type: "object", description: "JSON Schema (object) the child's structured_output value must satisfy. When set, the step must finish by calling the structured_output tool; prose-only or schema-invalid completion fails the step." });

const TaskItem = Type.Object({
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task (e.g. 'google/gemini-3-pro')" })),
	lane: Type.Optional(Type.String({ description: "Select a configured model lane for this task (for example 'easy' or 'hard')." })),
	thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS], description: "Thinking level override for this task. Takes precedence over agent config for this dispatch only." })),
	skill: Type.Optional(SkillOverride),
});

// Parallel task item (within a parallel step)
const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
	lane: Type.Optional(Type.String({ description: "Select a configured model lane for this parallel task." })),
	thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS], description: "Thinking level override for this parallel task" })),
	as: Type.Optional(AsParam),
	outputSchema: Type.Optional(OutputSchemaParam),
});

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder. Required for first step, defaults to '{previous}' for subsequent steps."
	})),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	lane: Type.Optional(Type.String({ description: "Select a configured model lane for this chain step." })),
	thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS], description: "Thinking level override for this chain step" })),
	as: Type.Optional(AsParam),
	outputSchema: Type.Optional(OutputSchemaParam),
	parallel: Type.Optional(Type.Union([Type.Array(ParallelTaskSchema, { minItems: 1 }), ParallelTaskSchema, Type.String()], { description: "Tasks to run in parallel (array), or a single parallel template object when used with expand/collect for dynamic fanout. Prefer literal JSON; a JSON-stringified array is tolerated and parsed." })),
	expand: Type.Optional(Type.Object({
		from: Type.Object({
			output: Type.String({ description: "Name of a prior step's structured output ({outputs.name}) to expand." }),
			path: Type.String({ description: "JSON Pointer into that structured output addressing the array to fan out over (e.g. '/files')." }),
		}),
		item: Type.Optional(Type.String({ description: "Template variable name for each item (default 'item'); reference as {item} or {item.field} in the parallel task." })),
		key: Type.Optional(Type.String({ description: "JSON Pointer into each item producing a unique key (default: array index)." })),
		maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum items to fan out; required unless the dynamicFanoutMaxItems config setting is set. A dynamic step with no effective cap is rejected before execution." })),
		onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Behavior when the source array is empty (default 'skip')." })),
	}, { description: "Dynamic fanout: expand an array from a prior step's structured output. Pairs with a single parallel template object and collect." })),
	collect: Type.Optional(Type.Object({
		as: AsParam,
		outputSchema: Type.Optional(OutputSchemaParam),
	}, { description: "Dynamic fanout: store the collected per-item results array under collect.as for later {outputs.name} references." })),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, { description: "Chain step: use {agent, task?, ...} for sequential or {parallel: [...]} for concurrent execution" });

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
	stepInactivityTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Per-step inactivity timeout in ms. Kill step if no child event for this duration (default: 300000 = 5min)" })),
	runWallClockTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Overall run wall-clock timeout in ms. Kill entire run if total elapsed exceeds this (default: 1800000 = 30min)" })),
	timeoutAction: Type.Optional(Type.String({ enum: ["notify", "escalate_then_kill", "auto_kill"], description: "Action on timeout: 'notify' (current behavior), 'escalate_then_kill' (nudge then kill), 'auto_kill' (immediate kill). Default: escalate_then_kill" })),
	escalationGraceMs: Type.Optional(Type.Integer({ minimum: 1, description: "Grace period in ms after escalation nudge before killing (default: 30000 = 30s). Only used with escalate_then_kill." })),
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode) or target for management get/update/delete" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode, optional for self-contained agents)" })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		enum: [...SUBAGENT_ACTIONS],
		description: "Management/control action. Omit for execution mode."
	})),
	id: Type.Optional(Type.String({
		description: "Run id or prefix for action='status', action='interrupt', or action='resume'."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID for action='interrupt' or action='resume'. Defaults to the most recently active controllable run for interrupt. Prefer id for new calls."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for action='status' or action='resume'."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for action='resume'. Use index to choose a child from multi-child runs." })),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name for get/update/delete management actions"
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Agent or chain config for create/update. Agent: name, package (optional namespace; runtime name becomes package.name), description, scope ('user'|'project', default 'user'), systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext ('fresh'|'fork'|'lineage'), model, tools (comma-separated), extensions (comma-separated), skills (comma-separated), thinking, output, reads, progress, maxSubagentDepth. Chain: name, package, description, scope, steps (array of {agent, task?, output?, outputMode?, reads?, model?, thinking?, skill?, progress?}). Presence of 'steps' creates a chain instead of an agent. String values must be valid JSON."
	})),
	tasks: Type.Optional(Type.Union([Type.Array(TaskItem), Type.String()], { description: "PARALLEL mode: [{agent, task, count?, output?, outputMode?, reads?, thinking?, progress?}, ...]. Prefer a literal JSON array; a JSON-stringified array is tolerated and parsed." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or 4." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task. " +
			"Prevents filesystem conflicts. Requires clean git state. " +
			"Per-worktree diffs included in output."
	})),
	chain: Type.Optional(Type.Union([Type.Array(ChainItem), Type.String()], { description: "CHAIN mode: sequential pipeline where each step's response becomes {previous} for the next. Use {task}, {previous}, {chain_dir} in task templates. Prefer a literal JSON array; a JSON-stringified array is tolerated and parsed." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork", "lineage"],
		description: "'fresh', 'fork', or 'lineage'. lineage creates a clean child session linked to the parent session without inheriting transcript context. If omitted, any requested agent with defaultContext: 'fork' makes the whole invocation forked; otherwise any requested agent with defaultContext: 'lineage' makes it lineage; otherwise the default is 'fresh'.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Persistent directory for chain artifacts. Default: a user-scoped temp directory under <tmpdir>/ (auto-cleaned after 24h)" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'both'; project wins on name collisions)" })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	maxOutput: Type.Optional(MaxOutputParam),
	budget: Type.Optional(Type.Integer({ minimum: 1, description: "Per-run output token budget override. Stops launching new subagents once completed children have produced this many output tokens; already-running children are not killed, so overshoot is possible." })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution (default: true for chains, false for single/parallel). Implies sync mode." })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Output file for single agent (string), or false to disable. Relative paths resolve against cwd.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for single agent (e.g. 'anthropic/claude-sonnet-4)'" })),
	lane: Type.Optional(Type.String({ description: "Select a configured model lane for this single-agent dispatch." })),
	thinking: Type.Optional(Type.String({ enum: [...THINKING_LEVELS], description: "Thinking level override for single agent dispatch. Takes precedence over agent config for this dispatch only." })),
	reads: Type.Optional(ReadsOverride),
});
