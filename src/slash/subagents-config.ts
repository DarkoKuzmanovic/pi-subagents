import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getUserAgentSettingsPath, readSettingsFileStrict } from "../agents/agents.ts";

/** Canonical model lane skeleton seeded when none exists. Model IDs are starters for bakeoff tuning. */
const MODEL_LANES_SKELETON = {
	worker: {
		normal: { model: "zai/glm-5.1", thinking: "high" },
		hard: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
	},
};

/** The set of arg keywords that trigger the config shortcut. */
export const CONFIG_KEYWORDS = new Set(["config", "json", "edit"]);

/** Returns the path of the user settings file. Pure — no I/O. */
export function resolveUserSettingsPath(): string {
	return getUserAgentSettingsPath();
}

function editorValue(): string {
	const visual = process.env["VISUAL"]?.trim();
	if (visual) return visual;
	const editor = process.env["EDITOR"]?.trim();
	return editor || "nano";
}

function splitEditorArgv(value: string): [string, ...string[]] {
	// Deliberately not shell parsing: whitespace-only tokenization supports common
	// values like "code --wait" while still passing argv directly to spawnSync.
	const parts = value.split(/\s+/).filter((part) => part.length > 0);
	const [command, ...args] = parts;
	if (typeof command === "string") return [command, ...args];
	return ["nano"];
}

/**
 * Returns the editor command argv to use.
 * Preference: $VISUAL → $EDITOR → "nano".
 * Pure — no I/O.
 */
export function selectEditorArgv(settingsPath: string): [string, ...string[]] {
	const [editor, ...editorArgs] = splitEditorArgv(editorValue());
	return [editor, ...editorArgs, settingsPath];
}

/**
 * Reads the user settings file and ensures `subagents.modelLanes` exists.
 * Preserves all other fields. Writes back only if a change is needed.
 *
 * Returns `{ changed: true }` when the file was written, `{ changed: false }` otherwise.
 * Throws on read/write failure or invalid existing `subagents` shape.
 */
export function seedModelLanesIfMissing(settingsPath: string): { changed: boolean } {
	const settings = readSettingsFileStrict(settingsPath);

	// Check whether subagents.modelLanes already exists.
	const subagents = settings.subagents;
	if (
		subagents &&
		typeof subagents === "object" &&
		!Array.isArray(subagents) &&
		"modelLanes" in (subagents as Record<string, unknown>) &&
		(subagents as Record<string, unknown>).modelLanes !== undefined
	) {
		return { changed: false };
	}

	if (subagents !== undefined && (typeof subagents !== "object" || Array.isArray(subagents) || subagents === null)) {
		throw new Error(`${settingsPath}: subagents must be an object before modelLanes can be seeded`);
	}

	// Build updated settings preserving all existing fields.
	const existingSubagents =
		subagents && typeof subagents === "object" && !Array.isArray(subagents)
			? (subagents as Record<string, unknown>)
			: {};

	const updated: Record<string, unknown> = {
		...settings,
		subagents: {
			...existingSubagents,
			modelLanes: MODEL_LANES_SKELETON,
		},
	};

	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
	return { changed: true };
}

export interface OpenSettingsResult {
	/** Null when the editor launched successfully; error message otherwise. */
	error: string | null;
	settingsPath: string;
}

/**
 * Attempts to open the settings file in an editor.
 * Uses spawnSync with an argv array — no shell concatenation.
 * Returns an error message string on failure, or null on apparent success.
 */
export function openSettingsInEditor(settingsPath: string): OpenSettingsResult {
	const [editor, ...editorArgs] = selectEditorArgv(settingsPath);

	let spawnResult: ReturnType<typeof spawnSync>;
	try {
		spawnResult = spawnSync(editor, [...editorArgs], { stdio: "inherit" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: `Could not launch editor '${editor}': ${message}`,
			settingsPath,
		};
	}

	if (spawnResult.error) {
		const message = spawnResult.error.message;
		return {
			error: `Could not launch editor '${editor}': ${message}`,
			settingsPath,
		};
	}

	return { error: null, settingsPath };
}
