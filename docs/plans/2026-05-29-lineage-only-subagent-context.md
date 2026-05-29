# Lineage-Only Subagent Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `context: "lineage"` so a subagent starts with clean model context but is linked to the parent session tree through Pi’s `parentSession` header.

**Architecture:** Keep `fresh` as today’s ordinary clean child run, keep `fork` as transcript-copying branch mode, and add `lineage` as the middle option: create a blank persistent child session with `parentSession` pointing at the parent session file, then launch child `pi` with `--session <that-child-file>`. This uses Pi’s `SessionManager.create(cwd, sessionDir, { parentSession })`; do not hand-write JSONL session files. V1 deliberately rejects `context: "lineage"` with worktree or per-child `cwd` overrides so session headers cannot disagree with the child process cwd.

**Tech Stack:** TypeScript ESM, Pi `SessionManager`, TypeBox schemas, Node.js built-in test runner.

---

## Decisions

1. **Context value:** use `"lineage"`, not `"lineage-only"`, because the existing API uses short values (`fresh`, `fork`). Documentation can call it “lineage-only”.
2. **Session creation:** use `SessionManager.create(effectiveCwd, sessionDirForIndex(i), { parentSession })` and pass the returned session file via `--session`. This writes a normal blank Pi session with a `parentSession` header.
3. **No transcript inheritance:** lineage must not call `createBranchedSession()` and must not wrap tasks with `wrapForkTask()`.
4. **V1 cwd scope:** lineage is allowed only when all children use the top-level effective cwd. Reject lineage with `worktree: true`, task `cwd`, chain step `cwd`, or parallel chain task `cwd`. This keeps session header cwd correct without changing async/chain precomputation APIs.
5. **Intercom:** `intercomBridge.mode: "fork-only"` should remain inactive for lineage because lineage children do not inherit the parent transcript.
6. **Defaults:** allow `defaultContext: "lineage"` for agents, but do not change any built-in agent defaults in this plan.

---

## Risks

- **Session tree behavior depends on Pi honoring `parentSession` across files.** Evidence: Pi `SessionManager.newSession()` supports `options.parentSession`; `/fork` uses the same header relationship. Test by checking created session header and manually verifying `/tree` after implementation.
- **Existing name `fork-context.ts` becomes misleading.** Avoid a large rename in the first pass, but rename exported functions to “context” names and keep compatibility aliases only if needed by tests.
- **Async precomputation currently only passes session files, not child cwd.** V1 rejects child cwd/worktree with lineage to avoid mismatched headers.
- **Schema/doc drift.** `context` enum appears in schema, README, extension tool description, types, tests, render badges, prompt-template bridge, doctor, and agent management.
- **Context badges.** `[fork]` should remain fork-specific; lineage can show `[lineage]` but should not reuse warning color semantics if that implies inherited context.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/shared/fork-context.ts` | Resolve `fresh` / `fork` / `lineage` into optional child session files | Modify |
| `src/runs/foreground/subagent-executor.ts` | Accept `lineage`, create resolver after `sessionRoot`, reject unsupported cwd/worktree combos, propagate context details | Modify |
| `src/shared/types.ts` | Widen `Details.context` | Modify |
| `src/agents/agents.ts` | Widen `AgentDefaultContext`, parser, overrides | Modify |
| `src/agents/agent-management.ts` | Allow management create/update `defaultContext: "lineage"` | Modify |
| `src/extension/schemas.ts` | Add `lineage` to TypeBox enum and descriptions | Modify |
| `src/extension/index.ts` | Update LLM-facing tool docs | Modify |
| `src/intercom/intercom-bridge.ts` | Widen context type; keep fork-only behavior fork-only | Modify |
| `src/extension/doctor.ts` | Widen context type and diagnostic wording if needed | Modify |
| `src/slash/prompt-template-bridge.ts` | Allow prompt templates to request lineage | Modify |
| `src/tui/render.ts` | Optional `[lineage]` badge | Modify |
| `README.md` | Document context modes and parameter reference | Modify |
| `test/unit/fork-context.test.ts` | Add lineage resolver tests | Modify |
| `test/unit/schemas.test.ts` | Expect context enum includes lineage | Modify |
| `test/integration/fork-context-execution.test.ts` | Add wiring tests for lineage and defaultContext lineage | Modify |
| `test/integration/render-fork-badge.test.ts` | Add or rename tests for lineage badge | Modify |

---

## Sprint Cadence and Oracle Gates

Implement this plan as five short sprints. Each sprint must end with:

1. Focused tests for that sprint passing.
2. A tiny local summary of files changed, behavior added, and known risks.
3. An `oracle` review before starting the next sprint.
4. Any oracle-blocking findings fixed in the same sprint, followed by one more focused test run.

Use this exact gate shape after each sprint, changing the sprint number and summary:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint N of docs/plans/2026-05-29-lineage-only-subagent-context.md.

Completed work:
- <files changed>
- <tests run and results>
- <known tradeoffs or skipped items>

Check for: plan drift, incorrect layer, context/fork/lineage semantic regressions, missing tests, and whether it is safe to proceed to Sprint N+1. Return PASS, PASS_WITH_NITS, or BLOCKED with concrete required fixes.`,
	context: "fork",
})
```

Do **not** continue to the next sprint on `BLOCKED`. Apply required fixes first, rerun focused tests, then ask oracle again with the fix summary.

## Sprint 1: Extend Context Resolver

**Files:**
- Modify: `src/shared/fork-context.ts`
- Modify: `test/unit/fork-context.test.ts`

- [ ] **Step 1: Write failing unit tests for lineage**

Add tests to `test/unit/fork-context.test.ts`:

```typescript
it("accepts lineage", () => {
	assert.equal(resolveSubagentContext("lineage"), "lineage");
});

it("lineage fails fast when parent session file is missing", () => {
	assert.throws(
		() => createSubagentContextResolver({
			getSessionFile: () => undefined,
			getLeafId: () => "leaf-123",
			getCwd: () => "/repo",
			getSessionDir: () => "/sessions",
			constructor: {
				open: () => ({ createBranchedSession: () => "/tmp/fork.jsonl" }),
				create: () => ({ getSessionFile: () => "/tmp/lineage.jsonl" }),
			},
		}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` }),
		/Lineage subagent context requires a persisted parent session\./,
	);
});

it("lineage creates blank child sessions with parentSession without branching", () => {
	const creates: Array<{ cwd: string; sessionDir?: string; parentSession?: string }> = [];
	let branchCalls = 0;
	const resolver = createSubagentContextResolver({
		getSessionFile: () => "/tmp/parent.jsonl",
		getLeafId: () => "leaf-123",
		getCwd: () => "/repo",
		getSessionDir: () => "/sessions",
		constructor: {
			open: () => ({
				createBranchedSession: () => {
					branchCalls++;
					return "/tmp/fork.jsonl";
				},
			}),
			create: (cwd: string, sessionDir?: string, options?: { parentSession?: string }) => {
				creates.push({ cwd, sessionDir, parentSession: options?.parentSession });
				return { getSessionFile: () => `${sessionDir}/lineage.jsonl` };
			},
		},
	}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` });

	assert.equal(resolver.sessionFileForIndex(0), "/tmp/run-0/lineage.jsonl");
	assert.equal(resolver.sessionFileForIndex(1), "/tmp/run-1/lineage.jsonl");
	assert.equal(branchCalls, 0);
	assert.deepEqual(creates, [
		{ cwd: "/repo", sessionDir: "/tmp/run-0", parentSession: "/tmp/parent.jsonl" },
		{ cwd: "/repo", sessionDir: "/tmp/run-1", parentSession: "/tmp/parent.jsonl" },
	]);
});

it("lineage memoizes per index", () => {
	let creates = 0;
	const resolver = createSubagentContextResolver({
		getSessionFile: () => "/tmp/parent.jsonl",
		getLeafId: () => "leaf-123",
		getCwd: () => "/repo",
		getSessionDir: () => "/sessions",
		constructor: {
			open: () => ({ createBranchedSession: () => "/tmp/fork.jsonl" }),
			create: (_cwd: string, sessionDir?: string) => {
				creates++;
				return { getSessionFile: () => `${sessionDir}/lineage-${creates}.jsonl` };
			},
		},
	}, "lineage", { cwd: "/repo", sessionDirForIndex: (i = 0) => `/tmp/run-${i}` });

	assert.equal(resolver.sessionFileForIndex(7), "/tmp/run-7/lineage-1.jsonl");
	assert.equal(resolver.sessionFileForIndex(7), "/tmp/run-7/lineage-1.jsonl");
	assert.equal(creates, 1);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm run test:unit -- test/unit/fork-context.test.ts
```

Expected: FAIL because `createSubagentContextResolver` and `lineage` do not exist.

- [ ] **Step 3: Implement resolver support**

Change `src/shared/fork-context.ts` along these lines:

```typescript
export type SubagentExecutionContext = "fresh" | "fork" | "lineage";

interface SubagentSessionManagerStatic {
	open(path: string): { createBranchedSession(leafId: string): string | undefined };
	create(cwd: string, sessionDir?: string, options?: { parentSession?: string }): { getSessionFile(): string | undefined };
}

interface SubagentSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getCwd(): string;
	getSessionDir(): string;
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
	if (context === "fresh") return { sessionFileForIndex: () => undefined };

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error(context === "fork"
			? "Forked subagent context requires a persisted parent session."
			: "Lineage subagent context requires a persisted parent session.");
	}

	if (context === "fork") {
		const leafId = sessionManager.getLeafId();
		if (!leafId) throw new Error("Forked subagent context requires a current leaf to fork from.");
		const cachedSessionFiles = new Map<number, string>();
		return {
			sessionFileForIndex(index = 0) {
				const cached = cachedSessionFiles.get(index);
				if (cached) return cached;
				try {
					const sourceManager = sessionManager.constructor.open(parentSessionFile);
					const sessionFile = sourceManager.createBranchedSession(leafId);
					if (!sessionFile) throw new Error("Session manager did not return a session file.");
					cachedSessionFiles.set(index, sessionFile);
					return sessionFile;
				} catch (error) {
					const cause = error instanceof Error ? error : new Error(String(error));
					throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
				}
			},
		};
	}

	if (!options) throw new Error("Lineage subagent context requires session directory options.");
	const cachedSessionFiles = new Map<number, string>();
	return {
		sessionFileForIndex(index = 0) {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				const childManager = sessionManager.constructor.create(options.cwd, options.sessionDirForIndex(index), { parentSession: parentSessionFile });
				const sessionFile = childManager.getSessionFile();
				if (!sessionFile) throw new Error("Session manager did not return a session file.");
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
```

- [ ] **Step 4: Run unit tests**

Run:

```bash
npm run test:unit -- test/unit/fork-context.test.ts
```

Expected: PASS.

- [ ] **Oracle Gate 1: Resolver semantics review**

Call oracle before Sprint 2:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint 1 of docs/plans/2026-05-29-lineage-only-subagent-context.md.

Completed work:
- Modified src/shared/fork-context.ts and test/unit/fork-context.test.ts
- Focused command: npm run test:unit -- test/unit/fork-context.test.ts
- Added lineage resolver semantics without changing fork/fresh behavior

Check specifically that lineage uses SessionManager.create(..., { parentSession }) rather than createBranchedSession(), memoizes per index, fails fast on missing parent session, and leaves fork behavior unchanged. Return PASS, PASS_WITH_NITS, or BLOCKED with required fixes.`,
	context: "fork",
})
```

---

## Sprint 2: Wire `context: "lineage"` Through Execution

**Files:**
- Modify: `src/runs/foreground/subagent-executor.ts`
- Modify: `test/integration/fork-context-execution.test.ts`

- [ ] **Step 1: Add execution tests**

In `test/integration/fork-context-execution.test.ts`, add tests equivalent to the existing fork tests:

```typescript
it("uses lineage context to pass a parent-linked clean session", async () => {
	const parentSessionFile = path.join(tempDir, "parent.jsonl");
	const created: Array<{ cwd: string; sessionDir?: string; parentSession?: string }> = [];
	const { manager } = makeForkingSessionManagerRecorder({
		sessionFile: parentSessionFile,
		leafId: "leaf-current",
		createSession: (cwd, sessionDir, options) => {
			created.push({ cwd, sessionDir, parentSession: options?.parentSession });
			return { getSessionFile: () => path.join(sessionDir ?? tempDir, "lineage.jsonl") };
		},
	});
	const executor = makeExecutorWithDiscoverAgents(() => ({
		agents: [{ name: "scout", description: "Scout" }],
		projectAgentsDir: null,
		userAgentsDir: null,
	}));

	const result = await executor.execute("run", { agent: "scout", task: "inspect", context: "lineage" }, new AbortController().signal, undefined, makeCtx({ sessionManager: manager }));

	assert.equal(result.isError, undefined);
	assert.equal(result.details?.context, "lineage");
	assert.deepEqual(readSessionArgsFromCalls(), [path.join(created[0]!.sessionDir!, "lineage.jsonl")]);
	assert.equal(created[0]!.parentSession, parentSessionFile);
});

it("uses agent defaultContext lineage when launch context is omitted", async () => {
	const parentSessionFile = path.join(tempDir, "parent.jsonl");
	const created: Array<{ cwd: string; sessionDir?: string; parentSession?: string }> = [];
	const { manager } = makeForkingSessionManagerRecorder({
		sessionFile: parentSessionFile,
		leafId: "leaf-current",
		createSession: (cwd, sessionDir, options) => {
			created.push({ cwd, sessionDir, parentSession: options?.parentSession });
			return { getSessionFile: () => path.join(sessionDir ?? tempDir, "lineage-default.jsonl") };
		},
	});
	const executor = makeExecutorWithDiscoverAgents(() => ({
		agents: [{ name: "worker", description: "Worker", defaultContext: "lineage" }],
		projectAgentsDir: null,
		userAgentsDir: null,
	}));

	const result = await executor.execute("run", { agent: "worker", task: "continue clean" }, new AbortController().signal, undefined, makeCtx({ sessionManager: manager }));

	assert.equal(result.isError, undefined);
	assert.equal(result.details?.context, "lineage");
	assert.deepEqual(readSessionArgsFromCalls(), [path.join(created[0]!.sessionDir!, "lineage-default.jsonl")]);
	assert.equal(created[0]!.parentSession, parentSessionFile);
});

it("rejects lineage with worktree because child cwd can differ", async () => {
	const result = await executor.execute("run", {
		tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }],
		context: "lineage",
		worktree: true,
	}, new AbortController().signal, undefined, ctx);
	assert.equal(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /context: "lineage" does not support worktree/);
});
```

If `makeForkingSessionManagerRecorder` does not currently accept a `createSession` hook, extend the helper to include `constructor.create` in the fake manager.

- [ ] **Step 2: Run integration test to verify failure**

Run:

```bash
npm run test:integration -- test/integration/fork-context-execution.test.ts
```

Expected: FAIL on context type/schema/resolver wiring.

- [ ] **Step 3: Widen local executor types**

In `src/runs/foreground/subagent-executor.ts`:

```typescript
context?: "fresh" | "fork" | "lineage";
```

Rename `withForkContext` to `withContextDetails` and set any non-fresh explicit context:

```typescript
function withContextDetails(
	result: AgentToolResult<Details>,
	context: SubagentParamsLike["context"],
): AgentToolResult<Details> {
	if ((context !== "fork" && context !== "lineage") || !result.details) return result;
	return { ...result, details: { ...result.details, context } };
}
```

Update all `withForkContext(...)` call sites to `withContextDetails(...)`.

- [ ] **Step 4: Keep fork-only prompt wrapping fork-only**

Leave these checks as `params.context === "fork"`:

```typescript
params.context === "fork" ? wrapForkTask(...) : ...
```

Do not wrap lineage tasks.

- [ ] **Step 5: Reject unsupported lineage cwd shapes**

Add helper near validation helpers:

```typescript
function findLineageUnsupportedCwdReason(params: SubagentParamsLike): string | undefined {
	if (params.context !== "lineage") return undefined;
	if (params.worktree) return 'context: "lineage" does not support worktree yet because lineage session headers must match child cwd.';
	for (const task of params.tasks ?? []) {
		if (task.cwd) return 'context: "lineage" does not support task cwd overrides yet.';
	}
	for (const step of params.chain ?? []) {
		if (step.cwd) return 'context: "lineage" does not support chain step cwd overrides yet.';
		if (isParallelStep(step)) {
			if (step.worktree) return 'context: "lineage" does not support chain parallel worktree yet.';
			for (const task of step.parallel) {
				if (task.cwd) return 'context: "lineage" does not support chain parallel task cwd overrides yet.';
			}
		}
	}
	return undefined;
}
```

Call it after `validateExecutionInput(...)` and before creating context sessions:

```typescript
const lineageCwdError = findLineageUnsupportedCwdReason(effectiveParams);
if (lineageCwdError) return buildRequestedModeError(effectiveParams, lineageCwdError);
```

- [ ] **Step 6: Create resolver after `sessionRoot` and `sessionDirForIndex` exist**

Move context resolver creation from before `requestedAsync` to after `sessionRoot` and `sessionDirForIndex` are defined. Replace:

```typescript
let sessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
try {
	sessionFileForIndex = createForkContextResolver(ctx.sessionManager, effectiveParams.context).sessionFileForIndex;
} catch (error) {
	return toExecutionErrorResult(effectiveParams, error);
}
```

with:

```typescript
const sessionDirForIndex = (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`);

let resolvedContextSessionFileForIndex: (idx?: number) => string | undefined = () => undefined;
try {
	resolvedContextSessionFileForIndex = createSubagentContextResolver(ctx.sessionManager, effectiveParams.context, {
		cwd: effectiveCwd,
		sessionDirForIndex,
	}).sessionFileForIndex;
} catch (error) {
	return toExecutionErrorResult(effectiveParams, error);
}

const childSessionFileForIndex = (idx?: number) =>
	resolvedContextSessionFileForIndex(idx) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
```

- [ ] **Step 7: Run integration test**

Run:

```bash
npm run test:integration -- test/integration/fork-context-execution.test.ts
```

Expected: PASS.

- [ ] **Oracle Gate 2: Execution wiring review**

Call oracle before Sprint 3:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint 2 of docs/plans/2026-05-29-lineage-only-subagent-context.md.

Completed work:
- Modified src/runs/foreground/subagent-executor.ts and test/integration/fork-context-execution.test.ts
- Focused command: npm run test:integration -- test/integration/fork-context-execution.test.ts
- Wired context: "lineage" into child session file plumbing and result details

Check specifically that lineage creates clean parent-linked sessions, does not wrap prompts with wrapForkTask(), rejects worktree/cwd overrides, and does not regress async/chain/fork/fresh execution paths. Return PASS, PASS_WITH_NITS, or BLOCKED with required fixes.`,
	context: "fork",
})
```

---

## Sprint 3: Widen Public Types, Schemas, and Agent Config

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/agents/agents.ts`
- Modify: `src/agents/agent-management.ts`
- Modify: `src/agents/agent-serializer.ts` only if tests reveal serializer assumptions
- Modify: `src/extension/schemas.ts`
- Modify: `src/extension/index.ts`
- Modify: `src/intercom/intercom-bridge.ts`
- Modify: `src/extension/doctor.ts`
- Modify: `src/slash/prompt-template-bridge.ts`
- Modify: `test/unit/schemas.test.ts`

- [ ] **Step 1: Update schema test**

In `test/unit/schemas.test.ts`, change expected enum:

```typescript
assert.deepEqual(contextSchema.enum, ["fresh", "fork", "lineage"]);
assert.match(description, /lineage/);
```

Run:

```bash
npm run test:unit -- test/unit/schemas.test.ts
```

Expected: FAIL until schema changes.

- [ ] **Step 2: Widen shared context type**

In `src/shared/types.ts`:

```typescript
context?: "fresh" | "fork" | "lineage";
```

- [ ] **Step 3: Widen agent default context**

In `src/agents/agents.ts`:

```typescript
export type AgentDefaultContext = "fresh" | "fork" | "lineage";
```

Update override validation:

```typescript
if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === "lineage" || input.defaultContext === false) {
```

Update error text to:

```typescript
expected 'fresh', 'fork', 'lineage', or false
```

Update frontmatter parsing around `defaultContext`:

```typescript
const defaultContext = frontmatter.defaultContext === "fork"
	? "fork" as const
	: frontmatter.defaultContext === "lineage"
		? "lineage" as const
		: frontmatter.defaultContext === "fresh"
			? "fresh" as const
			: undefined;
```

- [ ] **Step 4: Widen management create/update**

In `src/agents/agent-management.ts`:

```typescript
else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork" || cfg.defaultContext === "lineage") target.defaultContext = cfg.defaultContext;
else return "config.defaultContext must be 'fresh', 'fork', 'lineage', or false when provided.";
```

- [ ] **Step 5: Widen TypeBox schema and tool docs**

In `src/extension/schemas.ts`:

```typescript
enum: ["fresh", "fork", "lineage"],
description: "'fresh', 'lineage', or 'fork'. fresh starts a clean independent child session; lineage starts clean but links the child session to the parent tree; fork copies parent context into a branched child session. If omitted, any requested agent defaultContext may choose a mode; otherwise fresh.",
```

Also update the `config` description’s `defaultContext ('fresh'|'fork')` to include `lineage`.

In `src/extension/index.ts`, update the LLM-facing description line:

```text
• Optional context: { context: "fresh" | "lineage" | "fork" } ... lineage links a clean child session into the parent tree; fork copies parent transcript.
```

- [ ] **Step 6: Widen intercom/doctor/template types**

Update `context: "fresh" | "fork" | undefined` to `"fresh" | "fork" | "lineage" | undefined` in:

- `src/intercom/intercom-bridge.ts`
- `src/extension/doctor.ts`
- `src/slash/prompt-template-bridge.ts`

Keep this logic unchanged in `intercom-bridge.ts`:

```typescript
const wantsIntercom = mode !== "off" && !(mode === "fork-only" && input.context !== "fork");
```

Lineage is intentionally not fork for `fork-only`.

- [ ] **Step 7: Run unit tests**

Run:

```bash
npm run test:unit -- test/unit/schemas.test.ts test/unit/fork-context.test.ts test/unit/intercom-bridge.test.ts
```

Expected: PASS.

- [ ] **Oracle Gate 3: Public API surface review**

Call oracle before Sprint 4:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint 3 of docs/plans/2026-05-29-lineage-only-subagent-context.md.

Completed work:
- Modified shared types, agent config parsing/management, schema/tool docs, intercom/doctor/template context types
- Focused command: npm run test:unit -- test/unit/schemas.test.ts test/unit/fork-context.test.ts test/unit/intercom-bridge.test.ts
- Allowed defaultContext: "lineage" while keeping fork-only intercom fork-only

Check specifically for schema/docs/type drift, bad enum ordering or error text, accidental activation of fork-only intercom for lineage, and missing defaultContext lineage coverage. Return PASS, PASS_WITH_NITS, or BLOCKED with required fixes.`,
	context: "fork",
})
```

---

## Sprint 4: UI and Documentation

**Files:**
- Modify: `src/tui/render.ts`
- Modify: `test/integration/render-fork-badge.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add lineage render test**

In `test/integration/render-fork-badge.test.ts`, either rename the suite to “context indicator” or add lineage cases alongside fork:

```typescript
it("shows [lineage] when context is lineage", () => {
	const widget = renderSubagentResult!({
		content: [{ type: "text", text: "done" }],
		details: { mode: "single", context: "lineage", results: [] },
	}, { expanded: false }, theme);
	const text = widget.render(120).join("\n");
	assert.match(text, /\[lineage\]/);
});
```

- [ ] **Step 2: Run render test to verify failure**

Run:

```bash
npm run test:integration -- test/integration/render-fork-badge.test.ts
```

Expected: FAIL until render logic is widened.

- [ ] **Step 3: Add context badge helper**

In `src/tui/render.ts`, replace repeated `d.context === "fork" ? ... : ""` snippets with:

```typescript
function renderContextBadge(context: Details["context"] | undefined, theme: Theme): string {
	if (context === "fork") return theme.fg("warning", " [fork]");
	if (context === "lineage") return theme.fg("muted", " [lineage]");
	return "";
}
```

Use `renderContextBadge(d.context, theme)` in the existing locations. If the theme type has no `muted` color, use the same neutral style used for low-emphasis metadata in this file.

- [ ] **Step 4: Update README**

Update the feature list and parameter reference:

```markdown
- **Lineage context** — clean child sessions linked under the parent session tree without copying the parent transcript
```

Replace the context row with:

```markdown
| `context` | `fresh \| lineage \| fork` | agent default or `fresh` | `fresh` starts a clean child run; `lineage` starts clean but links the child session under the parent tree; `fork` creates a branched child session with inherited parent transcript. |
```

Add paragraph near the current fork paragraph:

```markdown
`context: "lineage"` is the middle ground between `fresh` and `fork`: the child gets a blank model context, but its session header points at the parent session file so Pi can show the relationship in session-tree tools. Use it when you want traceable subagent branches without paying to copy the parent transcript. V1 requires all children to run in the top-level cwd; use `fresh` or `fork` when per-task cwd/worktree isolation is required.
```

- [ ] **Step 5: Run render test**

Run:

```bash
npm run test:integration -- test/integration/render-fork-badge.test.ts
```

Expected: PASS.

- [ ] **Oracle Gate 4: UI and documentation review**

Call oracle before Sprint 5:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint 4 of docs/plans/2026-05-29-lineage-only-subagent-context.md.

Completed work:
- Modified src/tui/render.ts, test/integration/render-fork-badge.test.ts, and README.md
- Focused command: npm run test:integration -- test/integration/render-fork-badge.test.ts
- Documented lineage as clean parent-linked context, not a child process startup optimization

Check specifically that the lineage badge is visually non-alarming, README accurately distinguishes fresh/lineage/fork, and docs do not imply lineage removes child Pi startup latency. Return PASS, PASS_WITH_NITS, or BLOCKED with required fixes.`,
	context: "fork",
})
```

---

## Sprint 5: End-to-End Verification and Release

**Files:**
- Possibly modify: `CHANGELOG.md`
- Possibly modify: `package.json`

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm run test:unit -- test/unit/fork-context.test.ts test/unit/schemas.test.ts test/unit/intercom-bridge.test.ts
npm run test:integration -- test/integration/fork-context-execution.test.ts test/integration/render-fork-badge.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run full project checks**

Run:

```bash
npm run typecheck
npm test
npm run test:integration
```

Expected: all PASS.

- [ ] **Step 3: Manual smoke test**

From this repo in an interactive Pi session, run a small lineage child:

```typescript
subagent({ agent: "scout", task: "Say exactly: lineage smoke ok", context: "lineage" })
```

Expected:

- Tool result includes `details.context === "lineage"`.
- Child final output says `lineage smoke ok`.
- Child session file exists.
- The child session JSONL first line has `parentSession` equal to the parent session file.
- The child did **not** receive the parent transcript unless included in the explicit task.

- [ ] **Step 4: Manual rejection smoke test**

Run:

```typescript
subagent({ tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }], context: "lineage", worktree: true })
```

Expected: error explaining lineage does not support worktree yet.

- [ ] **Step 5: Version and changelog**

Because this is a non-trivial feature, follow repo policy:

- Bump `package.json` semver minor.
- Move `CHANGELOG.md` `[Unreleased]` into a dated release heading.
- Add an entry like:

```markdown
### Added
- Add `context: "lineage"` for clean subagent sessions linked to the parent session tree without copying parent transcript.
```

- [ ] **Step 6: Commit**

Run:

```bash
git add src test README.md CHANGELOG.md package.json docs/plans/2026-05-29-lineage-only-subagent-context.md todo.md
git commit -m "feat: add lineage-only subagent context"
```

- [ ] **Oracle Gate 5: Final release readiness review**

Call oracle before declaring the feature done:

```typescript
subagent({
	agent: "oracle",
	task: `Review Sprint 5 of docs/plans/2026-05-29-lineage-only-subagent-context.md for final release readiness.

Completed work:
- Ran focused unit/integration tests, full typecheck, npm test, and npm run test:integration
- Ran manual lineage smoke test and manual worktree rejection smoke test
- Updated README, CHANGELOG.md, package.json, todo.md, and committed the feature

Check specifically that acceptance criteria are met, version/changelog policy is satisfied, rollback is realistic, and there are no unresolved oracle findings from Sprints 1-4. Return PASS, PASS_WITH_NITS, or BLOCKED with required fixes.`,
	context: "fork",
})
```

---

## Acceptance Criteria

- `subagent({ agent, task, context: "lineage" })` launches a child with `--session <created-lineage-session-file>`.
- The created lineage session has a session header with `parentSession` pointing to the parent session file.
- The child starts with clean model context; it does not inherit parent messages and does not get fork boundary wrapping.
- `context: "fork"` behavior is unchanged.
- `context: "fresh"` behavior is unchanged.
- Agent `defaultContext: "lineage"` works through discovery and management.
- `fork-only` intercom mode does not activate for lineage.
- V1 rejects lineage with worktree or child cwd overrides.
- README and schema clearly explain that lineage does not solve child Pi process startup latency.

---

## Rollback

If implementation destabilizes session handling:

```bash
git restore src/shared/fork-context.ts src/runs/foreground/subagent-executor.ts src/shared/types.ts src/agents/agents.ts src/agents/agent-management.ts src/extension/schemas.ts src/extension/index.ts src/intercom/intercom-bridge.ts src/extension/doctor.ts src/slash/prompt-template-bridge.ts src/tui/render.ts README.md test/unit/fork-context.test.ts test/unit/schemas.test.ts test/integration/fork-context-execution.test.ts test/integration/render-fork-badge.test.ts CHANGELOG.md package.json
```

Keep `todo.md` and this plan unless the user wants the backlog item removed.
