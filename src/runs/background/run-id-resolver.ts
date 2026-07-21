import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState } from "../../shared/types.ts";
import { findAsyncRunPrefixMatches, type AsyncRunLocation } from "./async-resume.ts";
import { assertSafeNestedId, findNestedRunMatchesById, type NestedRoute, type NestedRunMatch, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { recoverRunHandle, type RecoveredRunHandle } from "../shared/run-handle-store.ts";

export type ResolvedSubagentRunId =
	| { kind: "foreground"; id: string }
	| { kind: "async"; id: string; location: AsyncRunLocation }
	| { kind: "nested"; id: string; match: NestedRunMatch };

export interface ResolveSubagentRunIdDeps {
	state?: SubagentState;
	asyncDirRoot?: string;
	resultsDir?: string;
	nested?: NestedRunResolutionScope;
}

function exactAsyncLocation(id: string, asyncDirRoot: string, resultsDir: string): AsyncRunLocation | undefined {
	const asyncDir = path.join(asyncDirRoot, id);
	const resultPath = path.join(resultsDir, `${id}.json`);
	if (!fs.existsSync(asyncDir) && !fs.existsSync(resultPath)) return undefined;
	return {
		asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
		resultPath: fs.existsSync(resultPath) ? resultPath : null,
		resolvedId: id,
	};
}

function foregroundIds(state: SubagentState | undefined): string[] {
	return state ? [...state.foregroundControls.keys()] : [];
}

function nestedScopeFromState(state: SubagentState | undefined): NestedRunResolutionScope | undefined {
	if (!state) return undefined;
	const routes: NestedRoute[] = [];
	const seen = new Set<string>();
	const add = (route: NestedRoute | undefined) => {
		if (!route) return;
		const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
		if (seen.has(key)) return;
		seen.add(key);
		routes.push(route);
	};
	for (const control of state.foregroundControls.values()) add(control.nestedRoute as NestedRoute | undefined);
	for (const job of state.asyncJobs.values()) add(job.nestedRoute as NestedRoute | undefined);
	return { routes };
}

function asyncPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir);
}

/**
 * Convert a recovered durable handle to the ResolvedSubagentRunId shape.
 * Returns undefined if the handle's kind doesn't map cleanly (e.g. a nested
 * handle whose route no longer resolves to a registry match).
 */
function recoveredHandleToResolved(handle: RecoveredRunHandle, asyncDirRoot: string, resultsDir: string): ResolvedSubagentRunId | undefined {
	switch (handle.kind) {
		case "foreground":
			// Foreground runs live only in the in-memory foregroundControls map.
			// After extension reload that map is empty; PID-based liveness is
			// useless here because process.pid is the host (still alive). Never
			// resolve store-recovered foreground handles as live.
			return undefined;
		case "async": {
			const asyncDir = handle.asyncDir ?? path.join(asyncDirRoot, handle.id);
			const resultPath = path.join(resultsDir, `${handle.id}.json`);
			return {
				kind: "async",
				id: handle.id,
				location: {
					asyncDir: fs.existsSync(asyncDir) ? asyncDir : null,
					resultPath: fs.existsSync(resultPath) ? resultPath : null,
					resolvedId: handle.id,
				},
			};
		}
		case "nested": {
			if (!handle.route) return undefined;
			const nestedMatches = findNestedRunMatchesById(handle.id, { scope: { routes: [handle.route] } });
			if (nestedMatches.length === 0) return undefined;
			return { kind: "nested", id: handle.id, match: nestedMatches[0] };
		}
	}
}

export function resolveSubagentRunId(id: string, deps: ResolveSubagentRunIdDeps = {}): ResolvedSubagentRunId | undefined {
	assertSafeNestedId("id", id);
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;

	const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
	if (deps.state?.foregroundControls.has(id)) return { kind: "foreground", id };
	const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
	if (exactAsync) return { kind: "async", id, location: exactAsync };
	const exactNested = findNestedRunMatchesById(id, nestedScope ? { scope: nestedScope } : {});
	if (exactNested.length > 1) throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
	if (exactNested[0]) return { kind: "nested", id, match: exactNested[0] };

	// Fallback: try the durable handle store. This recovers handles after
	// extension reload or parent crash, when in-memory state is empty and
	// on-disk scans didn't find the run by id.
	const recovered = recoverRunHandle(id);
	if (recovered) {
		const resolved = recoveredHandleToResolved(recovered, asyncDirRoot, resultsDir);
		if (resolved) return resolved;
	}

	const matches: ResolvedSubagentRunId[] = [];
	for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
		matches.push({ kind: "foreground", id: foregroundId });
	}
	for (const match of asyncPrefixMatches(id, asyncDirRoot, resultsDir)) {
		matches.push({ kind: "async", id: match.id, location: match.location });
	}
	for (const match of findNestedRunMatchesById(id, nestedScope ? { prefix: true, scope: nestedScope } : { prefix: true })) {
		matches.push({ kind: "nested", id: match.run.id, match });
	}
	const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
	const values = [...unique.values()];
	if (values.length > 1) {
		throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
	}
	return values[0];
}