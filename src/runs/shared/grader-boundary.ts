/**
 * Read-only path boundary for acceptance-gate graders.
 *
 * The child process still runs with Pi's normal file tools, so cwd alone is
 * not a security boundary. This hook rejects every read/search/list path
 * that would leave the attempt worktree, including symlink escapes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_GRADER_ALLOWED_ROOT_ENV } from "./pi-args.ts";

export const GRADER_ALLOWED_ROOT_ENV = SUBAGENT_GRADER_ALLOWED_ROOT_ENV;
export const GRADER_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

interface PathBoundarySuccess {
	status: "allowed";
	resolvedPath: string;
}

interface PathBoundaryFailure {
	status: "blocked";
	message: string;
}

export type GraderPathBoundaryResult =
	| PathBoundarySuccess
	| PathBoundaryFailure;

type ToolCallEventLike = {
	toolName: string;
	input: unknown;
};

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	);
}

function hasParentTraversal(rawPath: string): boolean {
	return rawPath
		.replaceAll("\\", "/")
		.split("/")
		.some((segment) => segment === "..");
}

function realpathWithMissingSuffix(candidate: string): string {
	let current = candidate;
	const missingSuffix: string[] = [];

	while (true) {
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) {
				return fs.realpathSync(current);
			}
			// `missingSuffix` is already root-to-leaf: the walk moves leafward-to-rootward and
			// unshifts each basename, so reversing it here would invert nested missing segments.
			return path.resolve(fs.realpathSync(current), ...missingSuffix);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) {
				throw new Error(`cannot resolve path '${candidate}'`);
			}
			missingSuffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

function normalizeToolPath(rawPath: string): string {
	return rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
}

/**
 * Check a tool path against an already-canonicalized worktree root.
 * `cwd` is the child process cwd used by Pi to resolve relative tool paths.
 */
export function checkGraderPath(
	root: string,
	cwd: string,
	rawPath: string,
): GraderPathBoundaryResult {
	const normalizedPath = normalizeToolPath(rawPath);
	if (hasParentTraversal(normalizedPath)) {
		return {
			status: "blocked",
			message: `path traversal via '..' is not allowed: ${rawPath}`,
		};
	}

	const candidate = path.resolve(cwd, normalizedPath || ".");
	if (!isWithinRoot(root, candidate)) {
		return {
			status: "blocked",
			message: `path is outside the grader worktree root: ${rawPath}`,
		};
	}

	let realCandidate: string;
	try {
		realCandidate = realpathWithMissingSuffix(candidate);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			status: "blocked",
			message: `cannot validate grader path '${rawPath}': ${detail}`,
		};
	}
	if (!isWithinRoot(root, realCandidate)) {
		return {
			status: "blocked",
			message: `path escapes the grader worktree through a symlink: ${rawPath}`,
		};
	}

	return { status: "allowed", resolvedPath: realCandidate };
}

function canonicalRoot(root: string): string {
	const resolved = path.resolve(root);
	try {
		return fs.realpathSync(resolved);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`grader allowed root is not accessible: ${detail}`);
	}
}

/** Register the child-process guard when the grader boundary env var is set. */
export default function registerGraderReadBoundary(pi: ExtensionAPI): void {
	const configuredRoot = process.env[GRADER_ALLOWED_ROOT_ENV]?.trim();
	if (!configuredRoot) return;
	const root = canonicalRoot(configuredRoot);

	pi.on("tool_call", (event: ToolCallEventLike, ctx) => {
		if (!(GRADER_READ_ONLY_TOOLS as readonly string[]).includes(event.toolName))
			return undefined;

		const input =
			event.input &&
			typeof event.input === "object" &&
			!Array.isArray(event.input)
				? (event.input as Record<string, unknown>)
				: {};
		const rawPath = input.path;
		if (rawPath !== undefined && typeof rawPath !== "string") {
			return {
				block: true,
				reason: "grader read boundary requires a string path",
			};
		}
		const result = checkGraderPath(
			root,
			ctx.cwd,
			typeof rawPath === "string" ? rawPath : ".",
		);
		if (result.status === "blocked") {
			return {
				block: true,
				reason: `Grader read boundary blocked tool '${event.toolName}': ${result.message}`,
			};
		}
		return undefined;
	});
}
