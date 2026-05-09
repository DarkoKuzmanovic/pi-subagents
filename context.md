# Code Context

## Files Retrieved

### Area 1: pendingForegroundControlNotices crash

1. `src/extension/control-notices.ts` (lines 28-34, 79-89) - Shows `clearPendingForegroundControlNotices` function and how `pending` is used
2. `src/runs/foreground/subagent-executor.ts` (lines 2084-2085) - Shows initialization of `foregroundControls` and `lastForegroundControlId`
3. `src/runs/foreground/subagent-executor.ts` (lines 2322-2327) - Shows cleanup call to `clearPendingForegroundControlNotices`
4. `src/shared/types.ts` (line 404) - Shows type definition for `pendingForegroundControlNotices`
5. `src/extension/index.ts` (line 252) - Shows initialization of `pendingForegroundControlNotices`

### Area 2: Built-in chain discovery

1. `package.json` (lines 28-36) - Shows the `files` array for npm package
2. `src/agents/agents.ts` (lines 668-683, 775-803) - Shows chain discovery and loading functions
3. `src/agents/agents.ts` (lines 723, 735, 776) - Shows `BUILTIN_AGENTS_DIR` and how built-in agents are loaded
4. `chains/go.chain.md` (full) - Example chain file
5. `chains/review.chain.md` (full) - Example chain with parallel syntax

### Area 4: Ambiguous {agent, parallel} validation

1. `src/extension/schemas.ts` (lines 66-84) - Shows ChainItem schema
2. `src/runs/foreground/subagent-executor.ts` (lines 662-680) - Shows chain validation logic
3. `src/shared/settings.ts` (lines 86-88) - Shows `isParallelStep` type guard

---

## Key Code

### Area 1: pendingForegroundControlNotices crash

**Type definition** (`src/shared/types.ts:404`):
```typescript
pendingForegroundControlNotices: Map<string, ReturnType<typeof setTimeout>>;
```

**Initialization** (`src/extension/index.ts:252`):
```typescript
pendingForegroundControlNotices: new Map(),
```

**clearPendingForegroundControlNotices** (`src/extension/control-notices.ts:28-34`):
```typescript
export function clearPendingForegroundControlNotices(state: SubagentState, runId?: string): void {
	const pending = state.pendingForegroundControlNotices;
	for (const [key, timer] of pending) {
		if (runId !== undefined && !key.startsWith(`${runId}:`)) continue;
		clearTimeout(timer);
		pending.delete(key);
	}
}
```

**Usage in handleSubagentControlNotice** (`src/extension/control-notices.ts:79-89`):
```typescript
const pending = input.state.pendingForegroundControlNotices;
const timerKey = noticeTimerKey(input.details);
const existing = pending.get(timerKey);
if (existing) clearTimeout(existing);
const timer = setTimeout(() => {
	pending.delete(timerKey);
	// ...
}, input.foregroundDelayMs ?? 1000);
timer.unref?.();
pending.set(timerKey, timer);
```

**Initialization in subagent-executor** (`src/runs/foreground/subagent-executor.ts:2084-2085`):
```typescript
deps.state.foregroundControls ??= new Map();
deps.state.lastForegroundControlId ??= null;
// NOTE: pendingForegroundControlNotices is NOT initialized here
```

**Cleanup call** (`src/runs/foreground/subagent-executor.ts:2322-2327`):
```typescript
if (foregroundControl) {
	clearPendingForegroundControlNotices(deps.state, runId);
	deps.state.foregroundControls.delete(runId);
	if (deps.state.lastForegroundControlId === runId) {
		deps.state.lastForegroundControlId = null;
	}
}
```

**Answer:** `pendingForegroundControlNotices` should be initialized as `Map<string, ReturnType<typeof setTimeout>>`. It is initialized in `src/extension/index.ts:252` but NOT in `subagent-executor.ts` where `foregroundControls` and `lastForegroundControlId` are initialized (lines 2084-2085). This is the bug - the cleanup code at line 2323 calls `clearPendingForegroundControlNotices` which iterates over `pending`, but if `pendingForegroundControlNotices` is undefined, the `for...of` loop will crash.

---

### Area 2: Built-in chain discovery

**package.json files array** (`package.json:28-36`):
```json
"files": [
  "src/**/*.ts",
  "*.mjs",
  "agents/",
  "skills/**/*",
  "prompts/**/*",
  "README.md",
  "CHANGELOG.md"
]
```
**Note:** `chains/` directory is NOT included in the `files` array.

**Chain discovery** (`src/agents/agents.ts:668-683`):
```typescript
function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
	const chains: ChainConfig[] = [];

	for (const filePath of listMarkdownFilesRecursive(dir, (fileName) => fileName.endsWith(".chain.md"))) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source, filePath));
		} catch {
			continue;
		}
	}

	return chains;
}
```

**Chain loading in discoverAgentsAll** (`src/agents/agents.ts:794-803`):
```typescript
const chainMap = new Map<string, ChainConfig>();
for (const dir of projectChainDirs) {
	for (const chain of loadChainsFromDir(dir, "project")) {
		chainMap.set(chain.name, chain);
	}
}
const chains = [
	...loadChainsFromDir(userChainDir, "user"),
	...Array.from(chainMap.values()),
];
```

**Built-in agent discovery pattern** (`src/agents/agents.ts:723, 775-781`):
```typescript
const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

const builtin = applyBuiltinOverrides(
	loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
	userSettings,
	projectSettings,
	userSettingsPath,
	projectSettingsPath,
);
```

**Answer:** There is NO built-in chain discovery currently. Built-in agents are loaded from `BUILTIN_AGENTS_DIR` (resolved to `agents/` directory relative to the source), but chains are only loaded from user and project directories. To mirror the built-in agent pattern for chains, you would need to:
1. Add a `BUILTIN_CHAINS_DIR` constant pointing to a `chains/` directory
2. Add `chains/` to the `package.json` files array (currently missing)
3. Load built-in chains similar to how built-in agents are loaded

---

### Area 3: review.chain.md parallel syntax

**Full content** (`chains/review.chain.md`):
```markdown
---
name: review
description: Parallel model-diverse reviewers → synthesis. Use when you want adversarial review from multiple perspectives and models before implementation.
---

## reviewers
parallel:
  - agent: reviewer
    task: |
      Review the current diff or repository for **correctness and regressions**.
      ...
    model: openai-codex/gpt-5.5
    output: review/findings-correctness.md

  - agent: reviewer
    task: |
      Review the current diff or repository for **tests and validation quality**.
      ...
    model: wafer/MiniMax-M2.7
    output: review/findings-tests.md

  - agent: reviewer
    task: |
      Review the current diff or repository for **simplicity and maintainability**.
      ...
    model: wafer/DeepSeek-V4-Pro
    output: review/findings-simplicity.md

output: review/

## synthesis
agent: context-builder
task: |
  Read the review findings from {previous} and synthesize them into a single
  consolidated review. Produce:
  ...
output: review/synthesis.md
model: wafer/GLM-5.1
```

**Key syntax:** Parallel steps use `parallel:` followed by an array of task objects. Each task has `agent`, `task`, `model`, and `output` fields.

---

### Area 4: Ambiguous {agent, parallel} validation

**ChainItem schema** (`src/extension/schemas.ts:66-84`):
```typescript
const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder. Required for first step, defaults to '{previous}' for subsequent steps."
	})),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Override model for this step" })),
	parallel: Type.Optional(Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" })),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, { description: "Chain step: use {agent, task?, ...} for sequential or {parallel: [...]} for concurrent execution" });
```

**Chain validation logic** (`src/runs/foreground/subagent-executor.ts:662-680`):
```typescript
for (let i = 0; i < params.chain.length; i++) {
	const step = params.chain[i] as ChainStep;
	const stepAgents = getStepAgents(step);
	for (const agentName of stepAgents) {
		if (!agents.find((a) => a.name === agentName)) {
			return {
				content: [{ type: "text", text: `Unknown agent: ${agentName} (step ${i + 1})` }],
				isError: true,
				details: { mode: "chain" as const, results: [] },
			};
		}
	}
	if (isParallelStep(step) && step.parallel.length === 0) {
		return {
			content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
			isError: true,
			details: { mode: "chain" as const, results: [] },
		};
	}
}
```

**isParallelStep type guard** (`src/shared/settings.ts:86-88`):
```typescript
export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}
```

**Answer:** The validation at line 674 checks `isParallelStep(step) && step.parallel.length === 0`, but the schema allows both `agent` and `parallel` to be present simultaneously (both are `Type.Optional`). This creates ambiguity - a step could have both `agent` and `parallel`, and the current validation doesn't catch this. The `isParallelStep` guard only checks if `parallel` exists and is an array, not whether `agent` is also present.

---

## Architecture

### Control Notices Flow
1. `SubagentState` holds `pendingForegroundControlNotices: Map<string, Timer>` 
2. `handleSubagentControlNotice` adds timers to the map when foreground control notices are scheduled
3. `clearPendingForegroundControlNotices` is called during cleanup to clear all pending timers
4. **Bug:** The map is initialized in `extension/index.ts` but not in `subagent-executor.ts` execute function, causing crashes when cleanup runs

### Chain Discovery Architecture
- **Agents:** Built-in (`agents/` dir) → User (`~/.agents` or `~/.pi/agent/agents`) → Project (`.pi/agents`)
- **Chains:** User (`~/.pi/chains`) → Project (`.pi/chains`) - **NO built-in chains**
- Chain files must end with `.chain.md` to be discovered
- Built-in agents use `BUILTIN_AGENTS_DIR` resolved from source location; chains have no equivalent

### Chain Step Validation
- Schema allows `agent` and `parallel` to coexist (both optional)
- Runtime validation checks for unknown agents and empty parallel arrays
- Missing: validation that `agent` and `parallel` are mutually exclusive

---

## Test Infrastructure

**Test runner command:**
```bash
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/unit/*.test.ts
```

**Test file locations:**
- Unit tests: `test/unit/*.test.ts`

**Key patterns:**
- Uses Node.js native test runner with `--experimental-strip-types`
- Custom loader registered via `--import ./test/support/register-loader.mjs`

---

## Start Here

**For Area 1 (pendingForegroundControlNotices crash):**
Open `src/runs/foreground/subagent-executor.ts` at line 2084. Add initialization for `pendingForegroundControlNotices` alongside `foregroundControls` and `lastForegroundControlId`:
```typescript
deps.state.pendingForegroundControlNotices ??= new Map();
```

**For Area 2 (Built-in chain discovery):**
Open `src/agents/agents.ts` at line 723. Add a `BUILTIN_CHAINS_DIR` constant similar to `BUILTIN_AGENTS_DIR`, then modify `discoverAgentsAll` to load built-in chains. Also update `package.json` to include `"chains/"` in the `files` array.

**For Area 4 (Ambiguous validation):**
Open `src/runs/foreground/subagent-executor.ts` at line 662. Add validation to ensure `agent` and `parallel` are mutually exclusive in chain steps.
