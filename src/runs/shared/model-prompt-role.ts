/**
 * Model prompt role resolver
 *
 * Resolves model-specific prompt role files from ~/.pi/agent/model-prompts/
 * based on the resolved model candidate and role name.
 *
 * Mirrors interface contract from model-prompts extension (model-prompts.ts:429-430):
 * Block format: "<!-- model-prompts: begin {fileName} -->\n{content}\n<!-- model-prompts: end {fileName} -->"
 * Role file naming: "<stem>@<role>.md"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/model-info.ts";

/**
 * Normalize a string for matching: replace colons/slashes/backslashes with dashes,
 * and convert to lowercase.
 * Mirrors: model-prompts.ts:36-38
 */
function normalize(s: string): string {
	return s.replace(/[:/\\]/g, "-").toLowerCase();
}

/**
 * Parse a model candidate string:
 * 1. Strip trailing thinking suffix (":off" | ":minimal" | ":low" | ":medium" | ":high" | ":xhigh" | ":max")
 * 2. Split on FIRST "/" into provider and modelId; if no "/", provider is "", whole string is modelId
 *
 * Returns { provider: string; modelId: string }
 */
function parseModelCandidate(model: string): { provider: string; modelId: string } {
	// Strip known thinking suffix from the end
	let stripped = model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1) {
		const suffix = model.substring(colonIdx + 1);
		if (THINKING_LEVELS.includes(suffix as ThinkingLevel)) {
			stripped = model.substring(0, colonIdx);
		}
	}

	// Split on first "/"
	const slashIdx = stripped.indexOf("/");
	if (slashIdx === -1) {
		return { provider: "", modelId: stripped };
	}
	return {
		provider: stripped.substring(0, slashIdx),
		modelId: stripped.substring(slashIdx + 1),
	};
}

/**
 * Find matching prompt role files in promptsDir matching the given variant (role),
 * ordered by match tier (exact provider--model > exact model > fuzzy).
 *
 * Fuzzy matching: stem.length >= 3 and stem appears dash-bounded in the normalized model string.
 * Returns array of { stem: string; fileName: string; tier: number } sorted by tier (lower first),
 * then by stem.length (longer first for fuzzy).
 */
function findRoleMatches(
	promptsDir: string,
	model: string,
	role: string,
): Array<{ stem: string; fileName: string; tier: number }> {
	const { provider, modelId } = parseModelCandidate(model);
	const roleLower = role.toLowerCase();
	const providerModelKey = normalize(`${provider}--${modelId}`);
	const modelKey = normalize(modelId);

	const matches: Array<{ stem: string; fileName: string; tier: number }> = [];

	let files: string[] = [];
	try {
		files = fs.readdirSync(promptsDir);
	} catch {
		return matches;
	}

	for (const file of files) {
		// Parity with model-prompts parsePromptFileName: case-insensitive .md
		// extension, lowercased base, split on the FIRST "@" (a leading or
		// trailing "@" means no variant), stem lowercased WITHOUT :/ \
		// normalization (only the model string is normalized).
		const ext = path.extname(file);
		if (ext.toLowerCase() !== ".md") continue;
		const base = file.slice(0, -ext.length).toLowerCase();
		if (base.length === 0) continue;
		const at = base.indexOf("@");
		if (at <= 0 || at === base.length - 1) continue; // no variant -> not a role file

		const stem = base.slice(0, at);
		const variant = base.slice(at + 1);

		// Check if variant matches role (case-insensitive; base already lowered)
		if (variant !== roleLower) continue;

		const stemLower = stem;

		// Tier 1: exact provider--model match
		if (stemLower === providerModelKey) {
			matches.push({ stem, fileName: file, tier: 1 });
			continue;
		}

		// Tier 2: exact model match
		if (stemLower === modelKey) {
			matches.push({ stem, fileName: file, tier: 2 });
			continue;
		}

		// Tier 3: fuzzy dash-bounded match
		if (stemLower.length >= 3) {
			const escapedStem = stemLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const fuzzyRegex = new RegExp(`(^|-)${escapedStem}($|-)`);
			if (fuzzyRegex.test(providerModelKey)) {
				matches.push({ stem, fileName: file, tier: 3 });
			}
		}
	}

	// Sort by tier (ascending), then longest stem, then locale order —
	// parity with model-prompts findPromptMatch fuzzy tiebreak
	matches.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier - b.tier;
		return b.stem.length - a.stem.length || a.stem.localeCompare(b.stem);
	});

	return matches;
}

/**
 * Resolve model prompt role block for injection into child systemPrompt.
 *
 * Returns { block: string; fileName: string } on success, undefined if:
 * - model or role is missing/blank
 * - promptsDir doesn't exist
 * - no matching role file found
 * - file is empty or unreadable
 *
 * Never throws.
 */
export function resolveModelPromptRoleBlock(
	model: string | undefined,
	role: string | undefined,
	promptsDir: string = path.join(os.homedir(), ".pi", "agent", "model-prompts"),
): { block: string; fileName: string } | undefined {
	if (!model || !model.trim() || !role || !role.trim()) {
		return undefined;
	}

	const modelTrimmed = model.trim();
	const roleTrimmed = role.trim();

	try {
		if (!fs.existsSync(promptsDir)) {
			return undefined;
		}

		const matches = findRoleMatches(promptsDir, modelTrimmed, roleTrimmed);
		if (matches.length === 0) {
			return undefined;
		}

		const firstMatch = matches[0];
		const filePath = path.join(promptsDir, firstMatch.fileName);

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8").trim();
		} catch {
			return undefined;
		}

		if (!content) {
			return undefined;
		}

		const block = `<!-- model-prompts: begin ${firstMatch.fileName} -->\n${content}\n<!-- model-prompts: end ${firstMatch.fileName} -->`;
		return { block, fileName: firstMatch.fileName };
	} catch {
		// Never throw
		return undefined;
	}
}
