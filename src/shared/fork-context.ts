export type SubagentExecutionContext = "fresh" | "fork" | "lineage";

interface SubagentSessionManagerStatic {
	open(path: string): { createBranchedSession(leafId: string): string | undefined };
	create(cwd: string, sessionDir?: string, options?: { parentSession?: string }): { getSessionFile(): string | undefined };
}

interface SubagentSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	constructor: SubagentSessionManagerStatic;
}

interface SubagentContextResolverOptions {
	cwd: string;
	sessionDirForIndex: (index?: number) => string;
}

interface SubagentContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" || value === "lineage" ? value : "fresh";
}

export function createSubagentContextResolver(
	sessionManager: SubagentSessionManager,
	requestedContext: unknown,
	options?: SubagentContextResolverOptions,
): SubagentContextResolver {
	const context = resolveSubagentContext(requestedContext);
	if (context === "fresh") {
		return {
			sessionFileForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error(
			context === "fork"
				? "Forked subagent context requires a persisted parent session."
				: "Lineage subagent context requires a persisted parent session.",
		);
	}

	if (context === "fork") {
		const leafId = sessionManager.getLeafId();
		if (!leafId) {
			throw new Error("Forked subagent context requires a current leaf to fork from.");
		}

		const cachedSessionFiles = new Map<number, string>();

		return {
			sessionFileForIndex(index = 0): string | undefined {
				const cached = cachedSessionFiles.get(index);
				if (cached) return cached;
				try {
					const sourceManager = sessionManager.constructor.open(parentSessionFile);
					const sessionFile = sourceManager.createBranchedSession(leafId);
					if (!sessionFile) {
						throw new Error("Session manager did not return a session file.");
					}
					cachedSessionFiles.set(index, sessionFile);
					return sessionFile;
				} catch (error) {
					const cause = error instanceof Error ? error : new Error(String(error));
					throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
				}
			},
		};
	}

	if (!options) {
		throw new Error("Lineage subagent context requires session directory options.");
	}

	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				const childManager = sessionManager.constructor.create(options.cwd, options.sessionDirForIndex(index), {
					parentSession: parentSessionFile,
				});
				const sessionFile = childManager.getSessionFile();
				if (!sessionFile) {
					throw new Error("Session manager did not return a session file.");
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create lineage subagent session: ${cause.message}`, { cause });
			}
		},
	};
}

export const createForkContextResolver = createSubagentContextResolver;
