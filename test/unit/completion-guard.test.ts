import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import {
	evaluateCompletionMutationGuard,
	expectsImplementationMutation,
	hasMutationToolCall,
} from "../../src/runs/shared/completion-guard.ts";

function assistantToolCall(name: string, args: Record<string, unknown> = {}): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: args }],
	} as unknown as Message;
}

function assistantText(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as unknown as Message;
}

test("implementation task with no mutation triggers the completion guard", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved fix",
		messages: [assistantText("Plan: update the files...")],
	});

	assert.deepEqual(result, {
		expectedMutation: true,
		attemptedMutation: false,
		triggered: true,
	});
});

test("review-only, research, and framework output instructions do not expect mutation", () => {
	assert.equal(expectsImplementationMutation("worker", "Review only: return findings, do not edit"), false);
	assert.equal(expectsImplementationMutation("worker", "Do not edit files. Tell me how to fix the bug."), false);
	assert.equal(expectsImplementationMutation("worker", "Review the diff and suggest fixes only. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Implement this. Do not edit files outside this repo. Do not edit files."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate why this failed"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research the API behavior"), false);
	assert.equal(expectsImplementationMutation("researcher", "Research this and patch the bug"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues"), false);
	assert.equal(expectsImplementationMutation("reviewer", "Review this and fix any real issues; regardless of findings, apply changes directly"), true);
	assert.equal(expectsImplementationMutation("worker", "[Write to: /tmp/result.md]\n\nSummarize findings"), false);
	assert.equal(expectsImplementationMutation("worker", "Write report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Create a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Add a report"), false);
	assert.equal(expectsImplementationMutation("worker", "Update a summary"), false);
	assert.equal(expectsImplementationMutation("worker", "Write to {chain_dir}"), false);
	assert.equal(
		expectsImplementationMutation("worker", "Do async work\nUpdate progress at: /tmp/progress.md\nWrite your findings to: /tmp/out.md"),
		false,
	);
});

test("read-only diagnostic dispatches phrased as negated edits do not expect mutation", () => {
	// Regression: roadmap debt item "No-edits guard false-positives on read-only diagnostic
	// dispatches" — a worker dispatched with "edit nothing, quote a sentence from your context"
	// completed correctly but was reported failed because none of the EXPLICIT_NO_EDIT_PATTERNS
	// matched that phrasing (only "do not edit"-style wording did).
	assert.equal(expectsImplementationMutation("worker", "Edit nothing. Quote a sentence from your context verbatim."), false);
	assert.equal(expectsImplementationMutation("worker", "Make no edits. Just report what you see."), false);
	assert.equal(expectsImplementationMutation("worker", "Investigate the config without editing any files."), false);
	assert.equal(expectsImplementationMutation("worker", "Probe this and report back. No edits needed."), false);
	assert.equal(expectsImplementationMutation("worker", "Check the setup without making any changes."), false);

	const guard = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Edit nothing, quote a sentence from your context.",
		messages: [assistantText("Here is the sentence I found: ...")],
	});
	assert.equal(guard.triggered, false);
});

test("scoped no-edit phrases do not exempt implementation dispatches (0.45.1 regression)", () => {
	// 0.45.1 shipped EXPLICIT_NO_EDIT_PATTERNS that matched mid-sentence, so a worker task
	// like "Implement the feature. No edits needed to tests." was classified read-only and
	// the completion guard silently disabled for a real implementation dispatch.
	assert.equal(expectsImplementationMutation("worker", "Implement the feature. No edits needed to tests."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Make no edits to the docs."), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug without editing the parser."), true);
	assert.equal(expectsImplementationMutation("worker", "Refactor the module; making no edits to tests."), true);
	assert.equal(expectsImplementationMutation("worker", "Make no edits to unrelated files. Fix the bug."), true);

	// Sentence-final constraints still exempt, exactly as before.
	assert.equal(expectsImplementationMutation("worker", "Make no edits."), false);
	assert.equal(expectsImplementationMutation("worker", "No edits needed."), false);
	assert.equal(expectsImplementationMutation("worker", "Check the setup without making any changes."), false);
	assert.equal(expectsImplementationMutation("worker", "No edits needed; just report back."), false);

	const guard = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the feature. No edits needed to tests.",
		messages: [assistantText("Done.")],
	});
	assert.equal(guard.triggered, true);
});

test("worker implementation verbs win over investigative wording", () => {
	assert.equal(expectsImplementationMutation("worker", "Investigate why the worker did not edit files and fix it"), true);
	assert.equal(expectsImplementationMutation("worker", "Research the current code path and patch the bug"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the bug where no edits were made"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix and return findings."), true);
});

test("worker edit intent covers common docs, config, and source tasks", () => {
	assert.equal(expectsImplementationMutation("worker", "Update README to mention the native tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Remove share functionality and all Vercel references"), true);
	assert.equal(expectsImplementationMutation("worker", "Replace the registered command with a render tool"), true);
	assert.equal(expectsImplementationMutation("worker", "Create completion-guard.ts"), true);
	assert.equal(expectsImplementationMutation("worker", "Add tests for the completion guard"), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the approved fixes. Do not edit files outside this repo."), true);
	assert.equal(expectsImplementationMutation("worker", "Implement the fix. Do not edit unrelated files."), true);
});

test("embedded payload content does not trigger the guard for non-implementation tasks", () => {
	// Faithful reproduction of the compaction-benchmark task that spuriously failed run 8d0ce5b7:
	// a read-only summary whose embedded TRANSCRIPT contained the words "fix" and "implement".
	const benchmarkTask = [
		"Compaction benchmark. Do not use tools. Summarize the transcript below. Output only the summary.",
		"",
		"TRANSCRIPT:",
		"[User]: We need to fix the sudoku-blocks drag bug and implement normalize_drop_target. Patch the resize logic too.",
	].join("\n");
	assert.equal(expectsImplementationMutation("delegate", benchmarkTask), false);

	const guard = evaluateCompletionMutationGuard({
		agent: "delegate",
		task: benchmarkTask,
		messages: [assistantText("## Goal\nFix the drag bug...")],
	});
	assert.equal(guard.triggered, false);

	// Implementation keywords inside a fenced code block are data, not instruction.
	assert.equal(expectsImplementationMutation("delegate", "Review this snippet:\n```\nfix the bug; implement feature; patch module\n```"), false);

	// Blockquoted embedded text is data, not instruction.
	assert.equal(expectsImplementationMutation("delegate", "Analyze the quote below.\n> please fix and refactor the parser"), false);

	// Payload after a generic label line is data.
	assert.equal(expectsImplementationMutation("delegate", "Compare the two diffs and report differences.\nDIFF:\n- old\n+ implement new fix"), false);
});

test("explicit analysis-only intent is non-mutating regardless of agent or payload", () => {
	assert.equal(expectsImplementationMutation("delegate", "Do not use tools. Tell me how to fix and refactor this."), false);
	assert.equal(expectsImplementationMutation("worker", "Do not read files. Explain how to implement the patch."), false);
	assert.equal(expectsImplementationMutation("delegate", "Implement-sounding analysis: output only the summary of the fix."), false);
});

test("real implementation instructions still trigger after payload stripping", () => {
	// Regression guard: the legit worker case (keyword in the instruction, not a payload) must still fire.
	assert.equal(expectsImplementationMutation("worker", "Implement the approved file changes"), true);
	assert.equal(expectsImplementationMutation("worker", "Fix the failing test in parser.ts"), true);
	// Instruction keyword survives even when an unrelated payload is appended.
	assert.equal(
		expectsImplementationMutation("worker", "Implement the fix described below.\nCONTEXT:\n[User]: it is broken"),
		true,
	);
});

test("agents without edit/write tools are never expected to mutate (oracle false-positive)", () => {
	// oracle/oracle-fresh have bash but no edit/write — they cannot make file changes, so an
	// implementation-keyword task must not be flagged as a failed implementation run.
	const readOnlyTools = ["read", "grep", "find", "ls", "bash", "contact_supervisor", "intercom"];
	// Pure implementation phrasing with NO review/no-edit/analysis wording, so the ONLY thing
	// that can exempt it is the missing edit/write tools.
	const implTask = "Fix the failing parser and refactor the drag handler in editor.ts.";

	// Sanity: the exact same task IS flagged when the agent has edit/write — proving the
	// exemption below comes from the tool allowlist, not from the task text.
	assert.equal(
		evaluateCompletionMutationGuard({ agent: "oracle", tools: ["read", "edit"], task: implTask, messages: [assistantText("## Findings")] }).triggered,
		true,
	);

	const oracleGuard = evaluateCompletionMutationGuard({
		agent: "oracle",
		tools: readOnlyTools,
		task: implTask,
		messages: [assistantText("## Findings\n1. Fix the parser by ...")],
	});
	assert.equal(oracleGuard.triggered, false);

	// An agent with `write` (e.g. planner) is still expected to mutate for an implementation task.
	const writerGuard = evaluateCompletionMutationGuard({
		agent: "custom-writer",
		tools: ["read", "write"],
		task: "Implement the approved file changes",
		messages: [assistantText("I'll do that.")],
	});
	assert.equal(writerGuard.triggered, true);

	// Backward-compat: when tools are omitted, behavior is unchanged (still guarded).
	const legacyGuard = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Implement the approved file changes",
		messages: [assistantText("I'll do that.")],
	});
	assert.equal(legacyGuard.triggered, true);
});
test("edit and write tool calls count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("edit", { path: "a.ts" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("write", { path: "a.ts" })]), true);
});

test("obvious mutating bash commands count as mutation attempts", () => {
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "mkdir -p src && cat > src/file.ts <<'EOF'\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "cat <<'EOF' > src/file.ts\nhi\nEOF" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 -c \"from pathlib import Path; Path('x').write_text('hi')\"" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node script.js > generated.txt" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'a > b'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "node -e \"console.log(a > b)\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "python3 <<'PY'\nprint('inspect only')\nPY" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "echo 'rm file'" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "printf \"mkdir x\"" })]), false);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "git apply patch.diff" })]), true);
	assert.equal(hasMutationToolCall([assistantToolCall("bash", { command: "patch -p0 < fix.patch" })]), true);
});

test("implementation task with mutation attempts does not trigger", () => {
	const result = evaluateCompletionMutationGuard({
		agent: "worker",
		task: "Fix the failing test",
		messages: [assistantToolCall("edit", { path: "test.ts" })],
	});

	assert.equal(result.triggered, false);
});
