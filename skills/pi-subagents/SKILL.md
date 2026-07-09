---
name: pi-subagents
description: |
  Delegate work to builtin or custom subagents with single-agent, chain,
  parallel, async, forked-context, and intercom-coordinated workflows. Use
  for advisory review, implementation handoffs, and multi-step tasks where a
  single agent should stay in control while other agents contribute context,
  planning, or execution.
---

# Pi Subagents

This skill is for the main parent orchestrator only. Do not inject or follow it inside spawned child subagents. The parent session owns delegation, orchestration, review fanout, and final fix-worker launches; child subagents should receive concrete role-specific tasks and should not run their own subagent workflows.

Use this skill when the parent orchestrator needs to launch a specialized subagent, compose multiple agents into a workflow, or create/edit agents and chains on demand.

## When to Use

- **Advisory review**: use fresh-context `reviewer` agents for adversarial code review, or fork to `oracle` when inherited decisions and drift matter
- **Implementation handoff**: after an approved direction, use `worker` by default; add `lane: "easy"` for small low-risk edits, `lane: "hard"` for difficult work, and a test-writing prompt/skill for focused test work
- **Recon and planning**: use `recon` for local or web-backed context, then `planner`
- **Parallel exploration**: run multiple non-conflicting tasks concurrently
- **Long-running work**: launch async/background runs and inspect them later
- **Subagent control**: watch needs-attention signals and soft-interrupt only when a delegated run is genuinely blocked
- **Agent authoring**: create, update, or override agents and chains for a project

## Tool vs Slash Commands

Agents can use the `subagent(...)` tool directly for execution, management, status, and control.
Humans often use the slash-command layer instead:

- `/run` — launch a single agent
- `/chain` — launch a chain of steps
- `/parallel` — launch top-level parallel tasks
- `/chain <chainName> -- <task>` — launch a saved `.chain.md` workflow (also supports inline `agent "task" -> agent` syntax)
- `/subagents-doctor` — diagnose setup, discovery, async paths, and intercom bridge state

Prefer the tool when you are writing agent logic. Prefer the slash commands when
you are guiding a human through an interactive flow.

Packaged prompt shortcuts are also available for repeatable workflows. Treat them as reusable orchestration recipes, not just human slash commands. When the user asks for one of these shapes, or when the workflow clearly fits, apply the same pattern directly with `subagent(...)` and other tools:

- `/mesh-review` — fresh-context reviewers with distinct review angles, then synthesis
- `/mesh-recon` — quick `recon` pass by default; add `deep` for artifact-backed synthesis with a `reviewer` synthesis pass
- `/mesh-handoff` — external-reference research plus local `recon` passes, followed by a synthesis handoff plan and implementation-ready meta-prompt
- `/mesh-context` — parallel `recon` passes for planning or implementation handoff context
- `/mesh-cleanup` — cleanup review lanes for simplicity, slop, and verbosity; `autofix` applies only fixes worth doing now
- `/brainstorm` — design-first exploration before any implementation, with clarifying questions and approach tradeoffs
- `/write-plan` — author an implementation plan against a spec/intent, with explicit validation commands
- `/gather-context-and-clarify` — gather focused context, then ask the remaining clarification questions before planning or implementation

## Applying Prompt Techniques Without Slash Commands

The prompt templates in `prompts/` encode workflows the parent agent can run on demand. If the user provides a URL, issue, PR, plan, local file, screenshot, or freeform target, treat that target as the primary scope: read or fetch it before launching children, then include it explicitly in every child task. Do not depend on the parent conversation history when the recipe calls for fresh context.

### Mesh review technique

Use this when the user wants adversarial review of a diff, plan, issue, file, or implemented work. Launch fresh-context `reviewer` agents with distinct angles generated from the actual target. Common angles are correctness/regressions, tests/validation, and simplicity/maintainability; adapt for TypeScript, UI, security, docs, or large structural changes. Reviewers should inspect files and diffs directly, return concise evidence-backed findings with file/line references, and avoid edits unless the user explicitly asks for a writer pass. The parent synthesizes fixes worth doing now, optional improvements, and feedback to ignore/defer before applying anything.

### Mesh recon technique

Use this when the question needs both external evidence and local implications. `/mesh-recon` is lightweight by default: combine `recon` passes for official docs, specs, ecosystem behavior, recent changes, benchmarks, primary sources, repository files, patterns, constraints, tests, and likely integration points. Give each child a distinct angle: external evidence, local code context, and practical tradeoffs. Ask for source links or file ranges, confidence level, gaps, and decision implications. Do not ask these children to edit unless implementation was explicitly requested. Use `/mesh-recon deep` when the question is decision-heavy enough to need lane artifact files plus a `reviewer` synthesis pass.

### Mesh context technique

Use `/mesh-context` before planning or implementation when a stronger handoff is needed. Run a chain with one parallel step of `recon` agents rather than top-level parallel tasks, so relative output files live under the temporary chain directory. Give every task a distinct output path such as `context-build/request-and-scope.md`, `context-build/codebase-and-patterns.md`, and `context-build/validation-and-risks.md`. Choose two or three builders: request/scope, codebase/patterns, and validation/risks. Each builder must read every relevant file needed to understand its slice, follow imports/callers/tests/docs/config, conduct tool-available web research when needed, and include a compact `meta-prompt` section. The parent synthesizes the outputs into important context, recommended next meta-prompt, open questions, assumptions, and artifact paths.

Example shape:

```typescript
subagent({
  chain: [
    {
      parallel: [
        {
          agent: "recon",
          task: "Build request/scope context for: ...",
          output: "context-build/request-and-scope.md",
        },
        {
          agent: "recon",
          task: "Build codebase/pattern context for: ...",
          output: "context-build/codebase-and-patterns.md",
        },
        {
          agent: "recon",
          task: "Build validation/risk context for: ...",
          output: "context-build/validation-and-risks.md",
        },
      ],
    },
  ],
  context: "fresh",
});
```

### Mesh handoff technique

Use `/mesh-handoff` when the user needs a solution brief or implementation-ready handoff from an external reference plus local code context, such as "study this library behavior, inspect our codebase, then produce a worker prompt." Run a chain with a first parallel group and a second synthesis `recon` step. The first group usually includes a `recon` configured with web research for external projects/docs/prompt guidance and a second `recon` for local code context; add another `recon` for implementation strategy only when the scope is large enough to benefit. Use distinct output paths under `handoff/`, then have the synthesis `recon` read those outputs and write `handoff/final-handoff-plan.md` with the recommended approach, likely files, constraints, non-goals, validation, risks, unresolved questions, and final compact implementation-ready meta-prompt.

Example shape:

```typescript
subagent({
  chain: [
    {
      parallel: [
        {
          agent: "recon",
          task: "Research the external reference and transferable implementation ideas for: ...",
          output: "handoff/external-reference.md",
        },
        {
          agent: "recon",
          task: "Build local codebase context for: ...",
          output: "handoff/local-context.md",
        },
        {
          agent: "recon",
          task: "Compare evidence and propose implementation strategy for: ...",
          output: "handoff/implementation-strategy.md",
        },
      ],
    },
    {
      agent: "recon",
      task: "Read {previous} and synthesize the final handoff plan and implementation-ready meta-prompt.",
      output: "handoff/final-handoff-plan.md",
    },
  ],
  context: "fresh",
});
```

### Brainstorm technique

Use this at the start of non-trivial design work when the user wants to explore the option space before committing to an approach. Stay design-first. Launch `recon` for local context and use a web-research prompt when external evidence would materially shape the choice. Ask the user clarifying questions one at a time with `ask_user` instead of dumping a survey. Compare 2–3 approaches with explicit tradeoffs and surface unresolved questions instead of smoothing them over. Do not invoke implementation skills until the user approves a direction.

### Write-plan technique

Use this when the user has a spec, intent, or approved design and wants a concrete implementation plan an executor can pick up. Read the spec/intent (and any referenced files) directly before drafting. Produce step-by-step tasks with file paths, signatures or contracts where they matter, explicit validation commands, and a placeholder scan. Treat "TBD", "appropriate error handling", or other vague filler as a self-review gate — resolve them before handoff. Do not start implementation from this command unless explicitly asked.
### Mesh cleanup technique

Use `/mesh-cleanup` after implementation when the user wants cleanup review or when a final pass would reduce AI-slop. Launch two fresh-context `reviewer` tasks with `output: false` and `progress: false`: one deslop pass and one verbosity pass. If the `deslop` or `verbosity-cleaner` skills are available, pass the relevant skill to that reviewer; otherwise inline the criteria. Both reviewers are review-only and should flag concrete issues with severity, file/line references, and smallest safe fixes. Review-only/no-edit beats progress-writing or artifact-writing instructions. The parent decides what to apply and asks before making changes unless cleanup was already authorized.

## Builtin Agents

Builtin agents load at the lowest priority. Project agents override user agents,
and user/project agents override builtins with the same name.

**Six durable roles** (enabled by default):

| Agent             | Purpose                                     | Context          | Typical output / role                                                     |
| ----------------- | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `recon` | Requirements/codebase handoff builder       | fresh (implicit) | Writes structured context files                                           |
| `planner`         | Creates implementation plans                | fresh            | Writes `plan.md`; reads `context.md`                                      |
| `worker`          | Normal implementation and oracle handoffs   | fork             | Single-writer implementation with decision escalation                     |
| `reviewer`        | Review-and-fix specialist                   | fresh (implicit) | Can edit/fix reviewed code                                                |
| `oracle`          | Decision-consistency advisory review        | fork             | Advisory review, intercom coordination                                    |
| `janitor`         | Repository hygiene and cleanup              | fresh            | Dead code, stale docs, orphaned artifacts; `--review` for audit-only      |

**Compatibility agents** (disabled by default; files preserved for reference):

| Agent         | Folded into                     | Migration path                                    |
| ------------- | ------------------------------- | ------------------------------------------------- |
| `scout`       | `recon`               | Use `recon` with local recon prompt     |
| `researcher`  | `recon`               | Use `recon` with web research prompt    |
| `synthesizer` | `reviewer`                      | Use `reviewer` with synthesis prompt/skill        |
| `test-writer` | `worker`                        | Use `worker` with test-writing prompt/skill       |
| `worker-light`| `worker` + lane                 | Use `worker` with `lane: "easy"` override         |
| `worker-heavy`| `worker` + lane                 | Use `worker` with `lane: "hard"` override         |
| `oracle-fresh`| `oracle`                        | Use `oracle` with `context: "fresh"` and reads   |
| `deslopper`   | `janitor`                       | Use `janitor`                                     |

Builtin agents inherit the current Pi default model unless a run, user setting, or project setting overrides `model`. Override builtin defaults before copying full agent files when a small tweak is enough.

For one run, use inline config:

```text
/run reviewer[model=anthropic/claude-sonnet-4] "Review this diff"
```

For persistent tweaks, edit `subagents.agentOverrides` in user or project settings. User overrides apply everywhere. Project overrides apply only in that repo and win over user overrides.

## Prompting role subagents

Builtin role agents inherit the current Pi default model unless you override them. When launching them, write the task prompt as a compact contract, not a long procedural script. Define the destination and let the role choose the efficient path.

A strong subagent prompt usually includes:

- **Goal**: the concrete outcome the child should produce.
- **Context/evidence**: relevant plan paths, files, diffs, decisions, or user constraints already approved.
- **Success criteria**: what must be true before the child can finish.
- **Hard constraints**: true invariants only, such as no edits for review-only tasks, one writer thread, child must not run subagents, or escalation for unapproved decisions.
- **Validation**: targeted checks to run, or the next-best check when validation is impossible.
- **Output**: the expected summary shape, artifact path, or finding format.
- **Stop rules**: when to ask via `intercom`, when to stop after enough evidence, and when not to keep searching.

Avoid carrying over old prompt habits that over-specify every step. Use `must`, `always`, and `never` for real invariants; for judgment calls, give decision rules. For example, tell a reviewer to inspect the staged diff directly and report only evidence-backed findings, rather than prescribing every file or command. Tell a research-focused context builder the retrieval budget: start with broad targeted searches, fetch only the strongest sources, search again only when a required fact is missing, then stop.

For implementation handoffs, name the approved scope and success criteria more clearly than the process. Good prompts say what to change, what not to change, where the evidence lives, how to validate, and when to escalate. They should not ask the child to create another subagent plan or continue the parent conversation.

Settings locations:

- User scope: `~/.pi/agent/settings.json`
- Project scope: `.pi/settings.json`

Direct settings example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Useful override fields: `model`, `fallbackModels`, `thinking`,
`systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`,
`memory`, `disabled`, `skills`, `tools`, and `systemPrompt`. Create a user or project
agent with the same name only when you want a substantially different agent.

## Discovery and Scope Rules

Agent files can live in:

- `~/.pi/agent/agents/**/*.md` — user scope
- `.pi/agents/**/*.md` — canonical project scope
- legacy `.agents/**/*.md` — still read for compatibility, but `.pi/agents/` wins on conflicts

Chains live in:

- `~/.pi/agent/chains/**/*.chain.md` — user scope
- `.pi/chains/**/*.chain.md` — project scope

Built-in chain templates bundled with the package:

- `go` — recon → planner → worker → reviewer

The former `review` chain has been retired; use `/mesh-review` for parallel model-diverse review and synthesis.
  Discovery is recursive. `.chain.md` files do not define agents. Agents and chains can set optional frontmatter `package: code-analysis`; `name: helper` plus `package: code-analysis` registers as runtime name `code-analysis.helper` while serialization keeps `name` and `package` separate.

Precedence is by parsed runtime name:

1. project scope
2. user scope
3. builtin agents

## Running Subagents

## Model Lanes

Model lanes route an agent through named model configurations (e.g. `easy`, `medium`, `hard`) without keeping duplicate role agents. Configure them in `~/.pi/agent/settings.json` under `subagents.modelLanes`; see AGENTS.md for the full shape.

Use `lane` in dispatch calls:
```typescript
subagent({ agent: "worker", lane: "easy", task: "..." });
// chain step:
{ agent: "worker", lane: "hard", task: "..." }
// parallel task:
{ agent: "worker", lane: "medium", task: "..." }
```

Precedence: inline `model`/`thinking` > lane `model`/`thinking` > agent defaults. Unknown lanes fail with a clear error before spawning.

To open and edit the lanes JSON, use `/subagents config` (or `/subagents json` or `/subagents edit`). It seeds a `subagents.modelLanes` skeleton when absent and opens the file in `$VISUAL`, `$EDITOR`, or `nano`.

> **Future:** A full lane-editing TUI inside `/subagents` is deferred to a later milestone.

### Single agent

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions.",
});
```

### Forked context

```typescript
subagent({
  agent: "oracle",
  task: "Review my current direction and challenge assumptions.",
});
```

`context: "fork"` creates a branched child session from the current persisted
parent session. It does **not** create a fresh minimal review context or filter
history down to only the relevant parts. Use it when you want a separate review
or execution thread that can still reference the parent session history.

### Parallel execution

```typescript
subagent({
  tasks: [
    { agent: "recon", task: "Explore the auth module" },
    { agent: "reviewer", task: "Review the API client" },
  ],
});
```

Top-level parallel tasks can override per-task behavior:

```typescript
subagent({
  tasks: [
    {
      agent: "recon",
      task: "Map auth",
      output: "auth-context.md",
      progress: true,
    },
    {
      agent: "recon",
      task: "Research OAuth best practices and summarize source-backed guidance",
      output: "oauth-research.md",
    },
    {
      agent: "reviewer",
      task: "Review auth tests",
      model: "anthropic/claude-sonnet-4",
    },
  ],
  concurrency: 3,
});
```

Avoid duplicate output paths in parallel tasks. Concurrent children should not write to the same file. For large saved outputs, set `outputMode: "file-only"` together with an `output` path. The parent result then contains only a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` instead of the full saved content. Do not use `output: false` for this; `output: false` means no file output. Failed runs and save errors still return inline details for debugging.

### Chain execution

```typescript
subagent({
  chain: [
    { agent: "recon", task: "Map the auth flow and summarize key files" },
    { agent: "planner", task: "Create an implementation plan from {previous}" },
    {
      agent: "worker",
      task: "Implement the approved plan based on {previous}",
    },
  ],
});
```

Chain steps can use templated variables such as `{task}`, `{previous}`, and
`{chain_dir}`. This is the main way to pass structured summaries between steps
without forcing each step to rediscover everything.

### Async/background

Use async mode whenever the parent agent should keep working while a child runs. A normal foreground `subagent(...)` call blocks the parent until the child completes; it is appropriate when the next parent step depends on the child result. If you say you will "ask a reviewer while I continue auditing" or otherwise run local work in parallel with a child, launch with `async: true`.

Do not end your turn immediately after launching an async child if you promised to keep working. Continue the local inspection or other independent work, then check the async run when its result is needed. If there is no independent work left and you would only be running `sleep` or status polling commands to wait, end your turn instead. Pi will deliver the async completion when it arrives.

```typescript
subagent({
  agent: "worker",
  task: "Run the full test suite",
  async: true,
});
```

File-only output mode also works for async single runs, top-level parallel task items, sequential chain steps, and chain parallel task items. In chains, `{previous}` receives the compact saved-file reference when the prior step used file-only mode.

For review fanout where the parent continues a local audit:

```typescript
const run = subagent({
  agent: "reviewer",
  task: "Review the current diff for correctness issues. Do not edit files.",
  async: true,
  context: "fresh",
});
// Continue local inspection, then later call status with the returned id.
```

Inspect async runs with `subagent({ action: "status", id: "..." })` or `subagent({ action: "status" })` for active runs.

Use `resume` for follow-up work after a delegated run:

```typescript
subagent({
  action: "resume",
  id: "run-id",
  message: "Follow up on this point.",
});
subagent({
  action: "resume",
  id: "run-id",
  index: 1,
  message: "Continue reviewer 2.",
});
```

Resume behavior:

- If an async child is still running and reachable, `resume` sends the follow-up to that live child over intercom.
- If an async child has completed, `resume` revives it by starting a new async child from the persisted child session file.
- Multi-child async runs require `index` unless only one running child is selectable.
- Completed foreground single, parallel, and chain runs can also be revived by `index` while their run metadata remains in extension state.
- Revive starts a new child process from the old session context; it does not restart the same OS process.
- If the chosen child has no persisted `.jsonl` session file, resume fails and reports that directly.

Use diagnostics when setup or child startup looks wrong:

```typescript
subagent({ action: "doctor" });
```

Humans can use `/subagents-doctor` for the same read-only report. It checks runtime paths, discovery counts, async support, current session context, and intercom bridge state.

### Subagent control

Subagent control is the runtime visibility and intervention layer for delegated runs. It is separate from lifecycle status. Lifecycle status says whether a child is `queued`, `running`, `paused`, `complete`, or `failed`. Activity reporting is factual: it tracks the last observed activity time and the current tool when known. It does not pretend to know that a child is truly stuck.

Default behavior is intentionally conservative. When no activity has been observed past the configured threshold, the run emits a `needs_attention` control event. Foreground runs can push this as a `subagent:control-event` event, and async runs persist it to `events.jsonl` so the parent tracker can surface it without constant manual polling. Notification-worthy control events are also inserted into the visible transcript so both the user and the parent agent can see them, with a proactive hint plus concrete `nudge`, `status`, and `interrupt` options. Visible notifications fire once per child run and attention state.

Use soft interrupt when a child is clearly blocked or drifting and the parent needs to regain control:

```typescript
subagent({ action: "interrupt" });
```

Pass `id` when targeting a specific controllable run:

```typescript
subagent({ action: "interrupt", id: "abc123" });
```

A soft interrupt cancels the current child turn and leaves the run paused. It does not mean the delegated task succeeded or failed. After an interrupt, decide the next explicit action: resume with clearer instructions, replace the task, ask the user, or stop the workflow.

Per-run control thresholds can be overridden when a task legitimately runs without observable output for longer than usual:

```typescript
subagent({
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    notifyOn: ["needs_attention"],
  },
});
```

If the run already has an active intercom bridge target, needs-attention notifications can also prepare a compact intercom ping for the orchestrator. When a child route is available, the ping tells the orchestrator which agent needs attention and includes the exact `intercom({ action: "send", to: "..." })` target for a nudge. Do not invent a target or ask the child to self-report when no bridge exists.

## Clarify TUI

Single and parallel runs support a clarification TUI when you want to preview or
edit parameters before launch:

```typescript
subagent({
  agent: "worker",
  task: "Implement feature X",
  clarify: true,
});
```

Chains default to clarify mode; set `clarify: false` to skip it. Clarify edits affect only the next run; use management actions, settings, or markdown files for persistent changes.
For programmatic background launches, use `clarify: false, async: true`.

## Worktree Isolation

When multiple agents might write concurrently, use worktrees instead of letting
them share one filesystem view.

```typescript
subagent({
  tasks: [
    { agent: "worker", task: "Implement feature A" },
    { agent: "worker", task: "Implement feature B" },
  ],
  worktree: true,
});
```

`worktree: true` gives each parallel task its own git worktree branched from
HEAD. This requires a clean git state and is mainly for intentionally parallel
write workflows. If you want one writer thread and several advisory agents,
prefer a single-writer pattern instead.

## The Oracle Workflow

The intended oracle loop is:

1. the main agent forks to `oracle`
2. `oracle` reviews direction, drift, assumptions, and risks
3. `oracle` can coordinate back through `contact_supervisor` when the bridge injects it
4. the main agent decides what direction to approve
5. only then should `worker` implement

```typescript
// Advisory review in a branched thread. Oracle defaults to forked context.
subagent({
  agent: "oracle",
  task: "Review my current direction, challenge assumptions, and propose the best next move.",
});

// Implementation only after explicit approval. Worker defaults to forked context.
subagent({
  agent: "worker",
  task: "Implement the approved approach: ...",
});
```

`oracle` is not a fresh-context reviewer in the Cognition article sense. It is
a forked advisory thread that inherits the parent session history and uses that
history as a baseline contract.

## Subagent + Intercom Coordination

`pi-subagents` works without `pi-intercom`. When `pi-intercom` is installed and enabled, the intercom bridge can automatically give child agents a private coordination channel back to the parent session.

Most agents should not call generic `intercom` directly unless bridge instructions provide a target and `contact_supervisor` is unavailable. Do not invent a target. Prefer the tool from the injected bridge instructions.

Use `contact_supervisor` with `reason: "need_decision"` when:

- a subagent is blocked on a decision
- a child needs clarification instead of guessing
- an approval, product, API, or scope choice is required before continuing safely

Do not use `contact_supervisor` just to resolve review-only/no-edit versus progress-writing or artifact-writing instructions. No-edit wins, and the child should return review findings without touching files.

Use `contact_supervisor` with `reason: "progress_update"` when:

- a child is explicitly asked for progress
- a meaningful discovery changes the plan
- a long-running child needs to report a blocked/progress checkpoint without waiting for normal tool return flow

Message conventions:

- `reason: "need_decision"` waits for the parent reply and returns it to the child.
- `reason: "progress_update"` is non-blocking and should stay concise.
- Child-side routine completion handoffs are not expected. With the intercom bridge active, parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets and full child summaries.

If bridge instructions provide the child-facing tool, a child can ask:

```typescript
contact_supervisor({
  reason: "need_decision",
  message: "Should I optimize for readability or performance here?",
});
```

The parent replies with:

```typescript
intercom({ action: "reply", message: "Optimize for readability." });
```

Or inspects unresolved asks first:

```typescript
intercom({ action: "pending" });
```

If intercom messages do not show up, run `subagent({ action: "doctor" })` or `/subagents-doctor`.

## Management Mode

The `subagent(...)` tool also supports management actions.

### List available agents and chains

```typescript
subagent({ action: "list" });
```

### Create an agent

```typescript
subagent({
  action: "create",
  config: {
    name: "my-agent",
    package: "code-analysis",
    description: "Project-specific implementation helper",
    systemPrompt: "Your system prompt here.",
    systemPromptMode: "replace",
    model: "openai-codex/gpt-5.4",
    tools: "read,grep,find,ls,bash",
  },
});
```

### Update an agent

```typescript
subagent({
  action: "update",
  agent: "code-analysis.my-agent",
  config: {
    thinking: "high",
  },
});
```

### Delete an agent

```typescript
subagent({ action: "delete", agent: "code-analysis.my-agent" });
```

Use management actions when the system needs to create or edit subagents on
demand without dropping into raw file editing.

Management actions create or update user/project agent files. `config.name` is the local frontmatter name; optional `config.package` registers and looks up the runtime name as `{package}.{name}`. Use the dotted runtime name for `get`, `update`, `delete`, slash commands, and chain steps. For small builtin changes such as a model swap, prefer `subagents.agentOverrides` in settings.

## Creating and Editing Agents by File

A minimal agent file looks like this:

```markdown
---
name: my-agent
package: code-analysis
description: What this agent does
model: openai-codex/gpt-5.4
thinking: high
tools: read, grep, find, ls, bash
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Your system prompt here.
```

That is only a starting point. Omit `package` for the traditional unqualified runtime name. Common optional fields include:

- `defaultProgress`
- `defaultReads`
- `output`
- `fallbackModels`
- `maxSubagentDepth`

For many customizations, builtin overrides in settings are lower-friction than
copying a full builtin file.

## Prompt Template Integration

The package includes prompt shortcuts for common workflows: `/mesh-review`,
`/mesh-recon`, `/mesh-handoff`, `/mesh-context`, `/mesh-cleanup`, `/brainstorm`,
`/write-plan`, and `/gather-context-and-clarify`. Use them when the user wants
repeatable review, research, implementation-handoff context, design exploration,
plan authoring, focused context gathering, or cleanup-review patterns.
`/mesh-review autofix` and `/mesh-cleanup autofix` synthesize reviewer feedback
and then apply only the fixes worth doing now. Parent agents can also apply the
same recipes directly with `subagent(...)` when the user describes the workflow
in natural language instead of invoking a slash command.

Pi's prompt-template system loads bundled prompts from `package.json` `pi.prompts`
and user/project prompt directories. The prompt-template bridge can turn template
requests into `pi-subagents` tool runs, which is useful when a slash command
should always run through particular agents, context modes, outputs, or model
settings.

## Important Constraints

- **Forking requires a persisted parent session.** If the current session does not
  have a persisted session file, forked runs fail. Packaged implementation workers
  (`worker`) and `oracle` default to forked context,
  so use `context: "fresh"` explicitly when that is not available or not wanted.
- **Forked runs inherit parent history.** They are branched threads, not fresh
  filtered contexts. Use fresh context for adversarial reviewers unless the user explicitly asks for forked context.
- **Default subagent nesting depth is 2.** Deeper recursive delegation is blocked
  unless configured otherwise.
- **Attention signals are not lifecycle state.** `needs_attention` means no activity has been observed past the configured threshold. `paused` means the child turn was intentionally interrupted or is awaiting direction; it is not the same as `failed`.
- **Intercom asks are blocking.** A session can only maintain one pending outbound
  ask wait state at a time.
- **Keep conversational authority clear.** Advisory subagents should not silently
  become second decision-makers.

## Best Practices

### Keep writes single-threaded by default

A strong pattern is one main decision-maker plus advisory/research/review
subagents around it. Use `oracle` for advice and `worker` for the actual write path.

### Use fork for branched advisory or execution threads

Forked runs are useful when the child should reason in a separate thread while
still inheriting the parent’s accumulated context. They are especially useful for
`oracle`, which audits inherited decisions and drift. For adversarial code review,
prefer fresh-context reviewers that inspect the repo and diff directly unless the
user explicitly requests forked context.

### Prefer narrow tasks

Give subagents specific tasks rather than vague mandates.
`Review auth.ts for null-check gaps` works better than `Review everything`.

### Escalate decisions upward

If a subagent encounters an unapproved product, architecture, or scope choice,
it should coordinate back via `intercom` instead of deciding alone.

### Intervene only on clear control signals

Use subagent control proactively when a delegated run emits `needs_attention`, or when a human asks you to regain control. Do not interrupt just because a child has briefly produced no output. Silence can be normal during long tool calls, test runs, or model reasoning.

### Name sessions meaningfully

Use `/name` so intercom targeting stays stable.

## Common Workflows

### Recon → Plan → Implement

```typescript
subagent({
  chain: [
    { agent: "recon", task: "Map the auth flow and summarize relevant files" },
    { agent: "planner", task: "Plan the migration from {previous}" },
    { agent: "worker", task: "Implement the approved plan from {previous}" },
  ],
});
```

### Clarify → Plan → Implement → Review (self-orchestrated workflow)

When you are the orchestrating agent for a new feature or non-trivial change, factor in the packaged prompt workflows without literally invoking slash commands. Use the same patterns through tools and subagents.

Keep builtin agent defaults unless the user explicitly asks for a different model, thinking level, skills, output behavior, context mode, or other override. Do not add overrides just because you are orchestrating; the defaults encode the intended role behavior. In particular, `worker` and `oracle` default to forked context; `recon`, `planner`, `reviewer`, and `janitor` default to fresh context with curated reads where specified.

Choose the implementation worker deliberately: use `worker` with `lane: "easy"` for small, low-risk edits with a clear local pattern; plain `worker` for ordinary 2–3 file implementation; and `worker` with `lane: "hard"` for architecture-sensitive, schema/config/routing, tricky-test, or high-blast-radius work. If the task is specifically to add or repair tests without product behavior changes, use `worker` with a test-writing skill or prompt rather than a generic implementation worker.

When the user approves launching a subagent to carry out a plan or workflow, treat that as approval to generate a proper role-specific meta prompt for that subagent. Include the approved plan path or summary, clarified requirements, non-goals, relevant context, role boundaries, files or areas to inspect, acceptance criteria, expected output, and validation expectations. Do not pass vague instructions like “implement the plan fully” or “review this” by themselves.

- `/brainstorm` maps to: stay design-first with the `brainstorming` skill; launch `recon` if local context matters and give it a web-research prompt if external evidence would shape the choice; ask clarifying questions with `ask_user`; compare 2–3 approaches with tradeoffs before any implementation.
- `/write-plan` maps to: use the `writing-plans` skill; read the spec/intent and any referenced files; draft a step-by-step plan with file paths, signatures where they matter, explicit validation commands, and a placeholder scan.
- `/gather-context-and-clarify` maps to: run `recon` for justified local or external knowledge gaps, synthesize what is known, then ask the smallest set of remaining questions with `ask_user` before planning or implementation.
- `/mesh-review` maps to: launch fresh-context `reviewer` agents with distinct review angles; synthesize the feedback before applying anything.
- `/mesh-recon` maps to: combine local `recon` context with external-evidence `recon` passes when current docs, ecosystem behavior, API details, or local implications matter; add `deep` for lane artifacts plus `reviewer` synthesis.
- `/mesh-handoff` maps to: run external-reference plus local/strategy `recon` passes, then a synthesis `recon` that writes an implementation handoff plan and implementation-ready meta-prompt.
- `/mesh-context` maps to: run parallel `recon` passes for planning or implementation handoff context.
- `/mesh-cleanup` maps to: use review-only cleanup passes after implementation, especially for simplicity, verbosity, slop, and redundant tests.

For feature work, use this sequence as scaffolding for parent-agent behavior:

```text
clarify → planner → worker (+ optional lane) → parallel fresh-context reviewers → worker
```

The first implementation worker applies the approved plan. The parallel reviewers inspect the resulting diff from fresh context. The final fix worker applies synthesized review fixes in forked context. Do not stop after parallel review unless the user explicitly asked for review-only output or the review surfaced a decision that needs approval first.

Keep orchestration authority in the parent session. Child subagents should not launch more subagents, read this skill, or run their own orchestration loops. Spawned subagents do not receive the `pi-subagents` skill, parent-only status/control/slash messages, prior parent `subagent` tool-call/tool-result artifacts, or the `subagent` extension tool. Child context filtering also strips old hidden orchestration-instruction messages when they appear in inherited history. Every child also receives a boundary instruction that says the parent owns orchestration, the child must not propose or run subagents, and implementation children must call real edit/write tools instead of printing pseudo tool calls. Pass children concrete role-specific work instead.

1. Clarify first. This is mandatory. Gather local or external context with `recon`, then ask the user clarifying questions with `ask_user` until scope, acceptance criteria, constraints, and non-goals are clear.
2. Plan when useful. For complex work, call `planner` or write a plan doc yourself and get approval before implementation. For simple work, confirm shared understanding and explicitly note why planning is skipped.
3. Implement with one writer. After approval, launch `worker` with a proper meta prompt that includes clarified requirements, relevant context, plan path or summary, acceptance criteria, and validation expectations. Use `lane: "easy"` for small low-risk work and `lane: "hard"` for difficult work. `worker` defaults to forked context; pass `context: "fresh"` only when you intentionally want a fresh child.
4. Review after implementation. After the worker completes, launch parallel fresh-context `reviewer` agents for correctness/regressions, tests/validation, and simplicity/maintainability. Use `output: false` unless review artifacts are explicitly needed.
5. Synthesize, then run the fix worker. Separate blockers, fixes worth doing now, optional improvements, and feedback to ignore/defer, then launch a forked `worker` to apply fixes worth doing now when the workflow is implementation-authorized. If reviewers found scope/product/architecture choices that were not approved, ask the user first instead of applying them.
6. Validate and complete. After the fix worker returns, run or confirm focused validation, update docs/changelog when relevant, and summarize what changed and why.

Example implementation handoff after clarification and optional planning:

```typescript
subagent({
  agent: "worker",
  task: "Implement the approved feature.\n\nClarified requirements:\n- ...\n\nPlan: see ~/Documents/docs/...-plan.md\n\nValidation expected:\n- ...",
});
```

Example review pass after implementation:

```typescript
subagent({
  tasks: [
    {
      agent: "reviewer",
      task: "Review the current diff for correctness and regressions. Inspect changed files directly.",
      output: false,
    },
    {
      agent: "reviewer",
      task: "Review the current diff for tests and validation quality. Inspect changed files directly.",
      output: false,
    },
    {
      agent: "reviewer",
      task: "Review the current diff for simplicity and maintainability. Inspect changed files directly.",
      output: false,
    },
  ],
  concurrency: 3,
  context: "fresh",
});
```

Example fix worker after parallel reviews:

```typescript
subagent({
  agent: "worker",
  task: "Apply the synthesized reviewer feedback below. Only apply fixes worth doing now; preserve user-approved scope; ask before unapproved product or architecture changes. Run focused validation and summarize what changed.\n\nReviewer synthesis:\n...",
});
```

### Review loop

Do not treat review as the final step for implementation work. Use the implementation, fresh-reviewer, and fix-worker examples above: run reviewers, synthesize their findings, then launch a final `worker` for accepted fixes.

### Parallel non-conflicting analysis

```typescript
subagent({
  tasks: [
    { agent: "recon", task: "Audit frontend auth flow" },
    {
      agent: "recon",
      task: "Research current retry/backoff best practices and summarize source-backed guidance",
    },
  ],
});
```

### Saved chain

```text
/chain go -- implement this approved plan
```

Use saved `.chain.md` workflows when the user wants a repeatable multi-agent flow without rewriting the chain each time. The bundled `go` chain is the only current saved chain and runs recon → planner → worker → reviewer.

## Error Handling

**"Unknown agent"**

```typescript
subagent({ action: "list" });
// Check available agents and chains, then confirm scope/precedence.
```

**Setup, discovery, or intercom confusion**

```typescript
subagent({ action: "doctor" });
// Check runtime paths, async support, discovery counts, current session, and intercom bridge state.
```

**"Max subagent depth exceeded"**

```typescript
// Flatten the workflow or raise maxSubagentDepth in config.
```

**"Session manager did not return a session file"**

```typescript
// Persist the current session before using context: "fork".
```

**Intercom "Already waiting for a reply"**

```typescript
// Resolve the current outbound ask before starting another one.
```

**Parallel output-path conflict**

```typescript
// Give each parallel task a distinct output path, or disable output for tasks that do not need it.
```

**Worktree launch fails**

```typescript
// Ensure the git working tree is clean and task cwd overrides match the shared cwd.
```

**Child fails before starting**

```typescript
// Inspect `subagent({ action: "status", id: "..." })`, artifact metadata/output logs, and run doctor. Extension loader errors usually appear in child output logs.
```
