import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { POLL_INTERVAL_MS, type JsonSchemaObject } from "../../shared/types.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV, validateStructuredOutputValue } from "./structured-output.ts";
import { createLiveControlOwnerListener, type LiveControlOwnerListener } from "./live-control-owner.ts";
import { isSafeNestedId, resolveInheritedNestedRouteFromEnv } from "./nested-events.ts";
import { SUBAGENT_CHILD_INDEX_ENV } from "./pi-args.ts";
import { createToolBudgetEnforcer } from "./tool-budget.ts";
import { loadConfig } from "../../extension/config.ts";

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, call the actual edit/write tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This step requires structured output.",
	"You MUST finish by calling the `structured_output` tool exactly once, with a `value` argument that conforms to the provided JSON Schema.",
	"Do not place the final structured result in prose — only the structured_output tool call is captured for this step.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);
const SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN = /<name>\s*pi-subagents\s*<\/name>/;
const PROJECT_CONTEXT_HEADER = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
const SKILLS_HEADER = "\n\nThe following skills provide specialized instructions for specific tasks.";
const DATE_HEADER = "\nCurrent date:";

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function findSectionEnd(prompt: string, startIndex: number, nextHeaders: string[]): number {
	let endIndex = prompt.length;
	for (const header of nextHeaders) {
		const index = prompt.indexOf(header, startIndex);
		if (index !== -1 && index < endIndex) {
			endIndex = index;
		}
	}
	return endIndex;
}

export function stripProjectContext(prompt: string): string {
	const startIndex = prompt.indexOf(PROJECT_CONTEXT_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + PROJECT_CONTEXT_HEADER.length, [SKILLS_HEADER, DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripInheritedSkills(prompt: string): string {
	const startIndex = prompt.indexOf(SKILLS_HEADER);
	if (startIndex === -1) return prompt;
	const endIndex = findSectionEnd(prompt, startIndex + SKILLS_HEADER.length, [DATE_HEADER]);
	return `${prompt.slice(0, startIndex)}${prompt.slice(endIndex)}`;
}

export function stripSubagentOrchestrationSkill(prompt: string): string {
	return prompt
		.replace(/\n{0,2}<skill\s+name=["']pi-subagents["'][^>]*>[\s\S]*?<\/skill>\n{0,2}/g, "\n\n")
		.replace(/[ \t]*<skill>\s*[\s\S]*?<\/skill>\s*/g, (block) => SUBAGENT_ORCHESTRATION_SKILL_NAME_PATTERN.test(block) ? "" : block);
}

export function rewriteSubagentPrompt(
	prompt: string,
	options: { inheritProjectContext: boolean; inheritSkills: boolean },
): string {
	let rewritten = prompt;
	if (!options.inheritProjectContext) {
		rewritten = stripProjectContext(rewritten);
	}
	if (!options.inheritSkills) {
		rewritten = stripInheritedSkills(rewritten);
	}
	rewritten = stripSubagentOrchestrationSkill(rewritten);
	return rewritten.includes(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS)
		? rewritten
		: `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n\n${rewritten}`;
}

function isParentOnlySubagentMessage(message: unknown): boolean {
	const m = message as { role?: string; customType?: string };
	return m?.role === "custom"
		&& typeof m.customType === "string"
		&& PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(m.customType);
}

function isSubagentToolResultMessage(message: unknown): boolean {
	const m = message as { role?: string; toolName?: string };
	return m?.role === "toolResult" && m.toolName === "subagent";
}

function isSubagentToolCallBlock(block: unknown): boolean {
	const b = block as { type?: string; name?: string };
	return b?.type === "toolCall" && b.name === "subagent";
}

function stripAssistantSubagentToolCallBlocks(message: unknown): unknown | undefined {
	const m = message as { role?: string; content?: unknown };
	if (m?.role !== "assistant" || !Array.isArray(m.content)) return message;
	const filteredContent = m.content.filter((block) => !isSubagentToolCallBlock(block));
	if (filteredContent.length === m.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...m, content: filteredContent };
}

export function stripParentOnlySubagentMessages(messages: unknown[]): unknown[] {
	let changed = false;
	const filtered: unknown[] = [];
	for (const message of messages) {
		if (isParentOnlySubagentMessage(message) || isSubagentToolResultMessage(message)) {
			changed = true;
			continue;
		}
		const stripped = stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		if (stripped !== message) changed = true;
		filtered.push(stripped);
	}
	return changed ? filtered : messages;
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	let liveControlListener: LiveControlOwnerListener | undefined;
	let liveControlTimer: NodeJS.Timeout | undefined;

	function stopLiveControlOwner(): void {
		if (liveControlTimer) {
			clearInterval(liveControlTimer);
			liveControlTimer = undefined;
		}
		liveControlListener?.close();
		liveControlListener = undefined;
	}
	const structuredOutputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const structuredSchemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (structuredOutputPath && structuredSchemaPath) {
		const schema = JSON.parse(fs.readFileSync(structuredSchemaPath, "utf-8")) as JsonSchemaObject;
		const parameters = {
			type: "object",
			properties: { value: schema },
			required: ["value"],
			additionalProperties: false,
		};
		const registerTool = pi.registerTool as unknown as (tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (_id: string, params: { value: unknown }) => Promise<unknown>;
		}) => void;
		registerTool({
			name: "structured_output",
			label: "Structured Output",
			description: "Submit the required final structured output for this subagent step. This terminates the step.",
			parameters: parameters as never,
			async execute(_id: string, params: { value: unknown }) {
				let value = params.value;
				// Cheap-driver tolerance: some drivers JSON-stringify nested object/array arguments.
				if (typeof value === "string") {
					const trimmed = value.trim();
					if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
						try {
							value = JSON.parse(trimmed);
						} catch {
							// Keep the raw string; validation below will report the mismatch.
						}
					}
				}
				const validation = validateStructuredOutputValue(schema, value);
				if (validation.status === "invalid") {
					throw new Error(`Structured output validation failed: ${validation.message}`);
				}
				fs.mkdirSync(path.dirname(structuredOutputPath), { recursive: true });
				fs.writeFileSync(structuredOutputPath, JSON.stringify(value), { mode: 0o600 });
				return {
					content: [{ type: "text", text: "Structured output captured." }],
					details: { path: structuredOutputPath },
					terminate: true,
				};
			},
		});
	}

	// Tool budget (upstream 0.33.0 parity). Enforced here rather than parent-side because only the
	// child process sees `tool_call` before execution and can veto it; the parent's run watcher sees
	// `tool_execution_start` after the fact. `subagents.toolBudget` used to be read from config and
	// silently discarded, so a configured budget did nothing at all.
	const toolBudget = loadConfig().toolBudget;
	if (toolBudget) {
		const enforcer = createToolBudgetEnforcer(toolBudget);
		pi.on("tool_call", (event) => {
			const decision = enforcer.onToolCall(event.toolName);
			return decision.blocked ? { block: true, reason: decision.reason } : undefined;
		});
		pi.on("tool_result", (event) => {
			const nudge = enforcer.takeSoftNudge();
			return nudge ? { content: [...event.content, { type: "text", text: nudge }] } : undefined;
		});
	}
	pi.on("context", (event) => {
		const messages = stripParentOnlySubagentMessages(event.messages);
		if (messages === event.messages) return undefined;
		return { messages };
	});

	pi.on("before_agent_start", async (event) => {
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && typeof pi.setSessionName === "function") {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const structuredSuffix = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]
			? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}`
			: "";
		if (inheritProjectContext === undefined && inheritSkills === undefined && !structuredSuffix) return;
		let rewritten = inheritProjectContext === undefined && inheritSkills === undefined
			? event.systemPrompt
			: rewriteSubagentPrompt(event.systemPrompt, {
				inheritProjectContext: inheritProjectContext ?? true,
				inheritSkills: inheritSkills ?? true,
			});
		if (structuredSuffix && !rewritten.includes(STRUCTURED_OUTPUT_INSTRUCTIONS)) {
			rewritten = `${rewritten}${structuredSuffix}`;
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});

	// Live control v2 (M12.1): a single-flight direct steer/follow-up listener bound to this
	// child's own owner epoch. Always loaded (not fanout-only) so any foreground or async child
	// — not just ones authorized to run the `subagent` tool themselves — can accept parent steering.
	pi.on("session_start", (_event, ctx) => {
		stopLiveControlOwner();
		const route = resolveInheritedNestedRouteFromEnv();
		const childKey = process.env[SUBAGENT_CHILD_INDEX_ENV];
		if (!route || !childKey || !isSafeNestedId(childKey)) return;
		liveControlListener = createLiveControlOwnerListener({
			route,
			childKey,
			sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
			isBusy: () => !ctx.isIdle(),
		});
		liveControlTimer = setInterval(() => {
			void liveControlListener?.pollOnce().catch((error) => {
				console.error("Live control owner poll failed:", error);
			});
		}, POLL_INTERVAL_MS);
		liveControlTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		stopLiveControlOwner();
	});
}
