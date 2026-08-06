import type { Message } from "@earendil-works/pi-ai";
import { isMutatingBashCommand } from "./long-running-guard.ts";

const REVIEW_ONLY_PATTERNS = [
	/\breview only\b/i,
	/\bsuggest fixes only\b/i,
	/\bonly return findings\b/i,
	/\breturn findings only\b/i,
];

const REVIEWER_REQUIRED_EDIT_PATTERNS = [
	/\bmust\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\brequired\s+to\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bregardless\s+of\s+findings\b/i,
	/\balways\s+(?:edit|modify|change|fix|patch|apply)\b/i,
	/\bapply\s+(?:the\s+)?fix(?:es)?\s+directly\b/i,
	/\bmake\s+(?:the\s+)?code\s+changes\b/i,
];

const EXPLICIT_NO_EDIT_PATTERNS = [
	/\bdo not edit\b/i,
	/\bdon't edit\b/i,
	/\bdo not modify\b/i,
	/\bdo not change files\b/i,
	/\bedit nothing\b/i,
	// Scoped-aware: "no edits needed to tests" / "without editing the parser" constrains
	// only a target, so an implementation dispatch carrying such a phrase still mutates.
	/\bmake no edits\b(?=\s*(?:[.!?;\n]|$))/i,
	/\bmaking no edits\b(?=\s*(?:[.!?;\n]|$))/i,
	/\bwithout (?:editing|making (?:any )?edits|making (?:any )?changes)\b(?=\s*(?:[.!?;\n]|$))/i,
	/\bno edits? (?:needed|required|necessary)\b(?=\s*(?:[.!?;\n]|$))/i,
];

// Tasks that are unambiguously analysis/read-only regardless of any embedded payload.
// An agent forbidden from tools cannot mutate; an "output only ..." constraint is non-mutating.
const ANALYSIS_ONLY_PATTERNS = [
	/\bdo not use tools\b/i,
	/\bdo not read files\b/i,
	/\boutput only the (?:summary|findings|analysis|answer|report)\b/i,
];

// Lines that introduce an embedded data payload (transcript/diff/log/etc.) to be
// processed rather than instructions to the agent. Everything after such a label line
// is data, not instruction, and must not be scanned for implementation intent.
const PAYLOAD_LABEL_LINE = /^\s*(?:transcript|input|context|diff|log|data|content|paste|payload|excerpt|snippet)\s*:?\s*$/i;

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
	/\bdo not edit files?\s+outside\b/i,
	/\bdo not edit\s+outside\b/i,
	/\bdo not edit\s+unrelated files?\b/i,
	/\bdo not change\s+unrelated files?\b/i,
	/\bdo not modify\s+unrelated files?\b/i,
];

const RESEARCH_AGENT_PATTERNS = [
	/\binvestigate\b/i,
	/\bscout\b/i,
	/\bresearch(?:er)?\b/i,
];

const WORKER_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|fix|edit|modify|patch|refactor|delete)\b/i,
	/\b(?:update|add|remove|replace|create)\b(?!\s+(?:(?:a|an|the)\s+)?(?:report|summary|findings?)(?:\b|$))/i,
	/\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
];

const GENERAL_IMPLEMENTATION_PATTERNS = [
	/\b(?:implement|fix|edit|modify|patch|refactor)\b/i,
	/\bapply\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
	/\bmake\s+(?:the\s+)?changes\b/i,
	/\bdo those fixes\b/i,
	/\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];


interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	/**
	 * The agent's resolved tool allowlist. When provided and it contains neither `edit`
	 * nor `write`, the agent cannot make file changes, so it is never expected to mutate
	 * (exempts read-only/analysis agents such as oracle). Omit to keep legacy behavior.
	 */
	tools?: string[];
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
}

function stripFrameworkInstructions(task: string): string {
	return task
		.split("\n")
		.filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
		.filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|Write your findings to:)/i.test(line))
		.join("\n");
}

function stripScopedNoEditConstraints(task: string): string {
	let stripped = task;
	for (const pattern of SCOPED_NO_EDIT_CONSTRAINT_PATTERNS) {
		stripped = stripped.replace(pattern, " ");
	}
	return stripped;
}

// Strip embedded data payloads so only the instruction is scanned for implementation intent.
// Removes fenced code blocks, blockquoted lines, and everything after a payload label line.
function stripEmbeddedPayload(task: string): string {
	const withoutFences = task.replace(/```[\s\S]*?```/g, " ");
	const lines = withoutFences.split("\n");
	const cutoff = lines.findIndex((line) => PAYLOAD_LABEL_LINE.test(line));
	const instructionLines = cutoff === -1 ? lines : lines.slice(0, cutoff);
	return instructionLines.filter((line) => !/^\s*>/.test(line)).join("\n");
}

export function expectsImplementationMutation(agent: string, task: string): boolean {
	const taskText = stripEmbeddedPayload(stripFrameworkInstructions(task));
	const taskTextWithoutScopedConstraints = stripScopedNoEditConstraints(taskText);
	if (REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;
	if (EXPLICIT_NO_EDIT_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;
	if (ANALYSIS_ONLY_PATTERNS.some((pattern) => pattern.test(taskTextWithoutScopedConstraints))) return false;

	if (RESEARCH_AGENT_PATTERNS.some((pattern) => pattern.test(agent))) return false;
	if (/\breviewer\b/i.test(agent)) return REVIEWER_REQUIRED_EDIT_PATTERNS.some((pattern) => pattern.test(taskText));

	const workerIntent = agent === "worker" && WORKER_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
	if (workerIntent) return true;

	return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (part.name === "edit" || part.name === "write") return true;
			if (part.name !== "bash") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (typeof args.command === "string" && isMutatingBashCommand(args.command)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const canMakeFileChanges = input.tools === undefined || input.tools.includes("edit") || input.tools.includes("write");
	const expectedMutation = canMakeFileChanges && expectsImplementationMutation(input.agent, input.task);
	const attemptedMutation = hasMutationToolCall(input.messages);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation,
	};
}
