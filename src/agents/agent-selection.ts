import type { AgentScope, AgentConfig } from "./agents.ts";

/**
 * Heuristic: does this string look like a model id / alias rather than an agent
 * role name? Used to turn an opaque "Unknown agent" error into actionable guidance
 * when a caller put a model id (e.g. "openai/gpt-5.5", "opus", "claude-opus-4-8")
 * into the `agent` field instead of using `agent: "worker", model: "..."`.
 */
export function looksLikeModelId(name: string): boolean {
	const n = name.trim().toLowerCase();
	if (!n) return false;
	if (n.includes("/")) return true; // provider/model
	if (n.includes(":") || n.includes("@")) return true; // model:thinking or model@version
	// Known model family tokens that never appear in builtin role names.
	if (/\b(gpt|o[134]|opus|sonnet|haiku|claude|gemini|deepseek|glm|mimo|grok|qwen|llama|mistral|flash|kimi)\b/.test(n)) return true;
	// Trailing version suffix like "...-4-8", "...-v4", "...-5.5".
	if (/[a-z].*-v?\d+([.-]\d+)*$/.test(n)) return true;
	return false;
}

/**
 * Build an actionable "Unknown agent" error: always lists the valid agent names,
 * and when the offending value looks like a model id, shows the correct
 * `agent: "worker", model: "..."` dispatch shape. `position` annotates which
 * task/step the bad name came from (e.g. "task 2", "step 1").
 */
export function formatUnknownAgentError(
	name: string | undefined,
	agents: AgentConfig[],
	position?: string,
): string {
	const where = position ? ` (${position})` : "";
	const available = agents.map((a) => a.name).join(", ") || "none";
	let msg = `Unknown agent: ${name ?? "(none)"}${where}. Available agents: ${available}.`;
	if (name && looksLikeModelId(name)) {
		msg += ` '${name}' looks like a model id, not an agent role. To run a task on a specific model, pass a role in 'agent' and the model in 'model', e.g. subagent({ agent: "worker", model: "${name}", task: "..." }).`;
	} else {
		msg += ` 'agent' must be a role name; choose the model separately via the 'model' field.`;
	}
	return msg;
}

export function mergeAgentsForScope(
	scope: AgentScope,
	userAgents: AgentConfig[],
	projectAgents: AgentConfig[],
	builtinAgents: AgentConfig[] = [],
): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();

	for (const agent of builtinAgents) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return Array.from(agentMap.values());
}
