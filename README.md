# pi-subagents

> **Fork of [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)** — diverged with bug fixes, token-economy optimizations, and custom agents.

`pi-subagents` lets Pi delegate work to focused child agents. Use it for code review, context building, implementation, parallel audits, saved workflows, background jobs, and anything else that benefits from a second or third set of model eyes.

> **Contributing / hacking on this?** Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the request lifecycle and a "where do I change X?" file map.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Try this first](#try-this-first)
- [What happens](#what-happens)
- [Good first prompts](#good-first-prompts)
- [Common workflows](#common-workflows)
- [Builtin agents in plain English](#builtin-agents-in-plain-english)
- [Changing a builtin agent's model](#changing-a-builtin-agents-model)
- [Where running subagents show up](#where-running-subagents-show-up)
- [Recommended orchestration pattern (scaffolding)](#recommended-orchestration-pattern-scaffolding)
- [Optional shortcuts](#optional-shortcuts)
- [Optional pi-intercom companion](#optional-pi-intercom-companion)
- [Direct commands](#direct-commands)
  - [Per-step tasks](#per-step-tasks)
  - [Inline per-step config](#inline-per-step-config)
  - [Background and forked runs](#background-and-forked-runs)
- [Clarify and launch UI](#clarify-and-launch-ui)
- [Agents and chains](#agents-and-chains)
  - [Builtin overrides](#builtin-overrides)
  - [Prompt assembly](#prompt-assembly)
  - [Agent frontmatter](#agent-frontmatter)
  - [Tool and extension selection](#tool-and-extension-selection)
- [Chain files](#chain-files)
  - [Built-in chain templates](#built-in-chain-templates)
- [Chain variables](#chain-variables)
- [Structured output and named outputs](#structured-output-and-named-outputs)
- [Dynamic fanout (expand / collect)](#dynamic-fanout-expand--collect)
- [Skills](#skills)
  - [Bundled skill](#bundled-skill)
- [Programmatic tool usage](#programmatic-tool-usage)
  - [Execution examples](#execution-examples)
  - [Management actions](#management-actions)
  - [Parameter reference](#parameter-reference)
- [Worktree isolation](#worktree-isolation)
- [Configuration](#configuration)
- [Files, logs, and observability](#files-logs-and-observability)
- [Live progress](#live-progress)
- [Session sharing](#session-sharing)
- [Recursion guard](#recursion-guard)
- [Runaway stream guard](#runaway-stream-guard)
- [Events](#events)
- [Prompt-template integration](#prompt-template-integration)
- [Changes from upstream](#changes-from-upstream)
- [Runtime files](#runtime-files)

## Features

- **Six default builtin roles** — recon, planner, worker, reviewer, oracle, and janitor. Compatibility agents remain on disk but are disabled by default.
- **Chains** — sequential multi-step pipelines with `{task}`, `{previous}`, `{chain_dir}` template variables and fan-out/fan-in parallel groups
- **Structured output** — a chain step can require schema-valid JSON from its child (`outputSchema` + a `structured_output` tool) and expose it to later steps as `{outputs.name}` (foreground and async)
- **Dynamic fanout** — expand a prior step's structured array into N parallel tasks and `collect` the results into one named array (foreground)
- **Parallel execution** — concurrent agents with grouped output, optional worktree isolation
- **Background runs** — detached async execution with status polling, completion notifications, and resume
- **Forked context** — real branched sessions from the parent leaf, not injected summaries
- **Clarify UI** — TUI preview/edit flow for chains with model, thinking, skills, and output pickers
- **Intercom bridge** — optional `pi-intercom` companion lets children contact the parent for decisions
- **Prompt templates** — mesh-first reusable workflow shortcuts (`/mesh-review`, `/mesh-recon`, `/mesh-cleanup`, etc.)
- **Skills injection** — per-agent or per-step skill overrides with project-first discovery
- **Inline reads** — fresh-context children get pre-loaded files, saving a full context fork
- **Session sharing** — export runs to HTML and upload to GitHub Gist
- **Model fallback** — ordered backup models for provider failures (quota, auth, timeout)

## Installation

```bash
pi install npm:pi-subagents
```

That is the only required step. You can add optional pieces later.

## Try this first

You do not need to create agents, write config, or learn slash commands. After installing, ask Pi for delegation in plain language:

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan.
```

```text
Use recon to understand this code based on our discussion then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

That is enough to start.

## What happens

Pi is the parent session. A subagent is a focused child Pi session with its own job.

When you ask for a subagent, Pi starts the child, gives it the task, and brings the result back. Foreground runs stream in the conversation. Background runs keep working and can be checked later.

Installing the extension does not start an automatic reviewer in the background. It gives Pi a delegation tool. If you want every implementation reviewed, say that in your prompt or put it in your project instructions:

```text
When you finish implementing, run a reviewer subagent before summarizing.
```

## Good first prompts

These cover most day-to-day use:

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use oracle to help solve this hard bug. Have it inspect the code and propose the best next move before we edit anything.
```

```text
Run parallel reviewers on this diff. I want one focused on correctness, one on tests, and one on unnecessary complexity.
```

```text
Have worker implement this approved plan. Afterward, run parallel reviewers, summarize their feedback, and apply the fixes that make sense.
```

```text
Use recon to understand the auth flow, then have planner turn that into an implementation plan.
```

Those are ordinary Pi requests. Pi decides whether to call `subagent`, which agent to use, and whether a chain or parallel run makes sense.

## Common workflows

| Want                     | Ask naturally                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Get a second opinion     | “Ask oracle to review this plan and challenge assumptions.”                            |
| Solve a hard problem     | “Use oracle to investigate this bug before we edit.”                                   |
| Review a diff            | “Use reviewer to review this diff.”                                                    |
| Run parallel reviewers   | “Run reviewers for correctness, tests, and cleanup.”                                   |
| Implement then review    | “Implement this, then review it.”                                                      |
| Execute a plan carefully | “Have worker implement this approved plan, then run reviewers and apply the feedback.” |
| Gather context before planning | “Use recon to inspect the auth flow before planning.”                         |
| Run in the background    | “Run this in the background.”                                                          |
| Browse agents            | “Show me the available subagents.”                                                     |
| Use a saved workflow     | “Run `/mesh-review` on this branch.”                                                  |
| See running work         | “Show active async runs.”                                                              |
| Check setup              | “Check whether subagents are configured correctly.”                                    |

The extension ships with builtin agents you can use immediately.

## Builtin agents in plain English

| Agent             | Use it when you want...                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `recon` | Local or external context before planning: relevant files, entry points, data flow, risks, source-backed notes, and handoff material.       |
| `planner`         | A concrete implementation plan from existing context. It should read and plan, not edit code.                                               |
| `worker`          | Implementation work, including lane-based easy/hard routing and approved oracle handoffs. It edits files, validates, and escalates decisions. |
| `reviewer`        | Code review, synthesis, and small fix-back guidance. It checks the implementation against the task/plan, tests, edge cases, and simplicity. |
| `oracle`          | A second opinion before acting. It challenges assumptions, catches drift, and recommends the safest next move without editing.              |
| `janitor`         | Repository hygiene: dead code, stale docs, orphaned artifacts, naming issues, and structural cleanup. Use `--review` for audit-only.       |
|
| Compatibility agents | `scout`, `researcher`, `synthesizer`, `test-writer`, `worker-light`, `worker-heavy`, `oracle-fresh`, and `deslopper` are preserved but disabled by default; use the roles above plus `lane` or `context: "fresh"` instead. |

A simple rule of thumb: use `recon` before you understand the code or external facts, `planner` before a bigger change, `worker` to implement, `reviewer` to check or synthesize, `oracle` when the decision itself feels risky, and `janitor` for cleanup.

## Changing a builtin agent's model

Builtin agents inherit your current Pi default model by default. This keeps new installs from depending on a provider you may not have configured. If you want a role to use a specific model, set an override instead of copying the bundled agent file.

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent override, edit settings. This example pins the reviewer everywhere, adds a backup model for provider failures, and keeps the other builtins on your normal default model:

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

Use `~/.pi/agent/settings.json` for a user override or `.pi/settings.json` for a project override. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. If you want a totally different agent, create a user or project agent with the same name; for normal tweaks, prefer overrides.

## Where running subagents show up

Foreground runs stream progress in the conversation while they run.

Background runs keep working after control returns to you. Inspect active runs with `subagent({ action: "status" })`, or a specific run with `subagent({ action: "status", id: "..." })`.

They also show a compact async widget and send completion notifications. Parallel background runs show per-agent progress instead of fake chain steps. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones.

You can also ask naturally:

```text
Show me the current async runs.
```

If something feels misconfigured, run:

```text
/subagents-doctor
```

or ask:

```text
Check whether subagents and intercom are set up correctly.
```

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify → planner → worker → fresh reviewers → worker
```

Use the optional prompt shortcuts below when you want the pattern to be repeatable.

Packaged `worker` and `oracle` default to forked context when a launch omits `context`; planning and context roles default to fresh context. Pass `context: "fresh"` when you intentionally want a fresh child run.

Child-safety boundaries are enforced at runtime. Spawned child sessions do not register the `subagent` tool, do not receive the bundled `pi-subagents` skill, and receive explicit boundary instructions that they are not the parent orchestrator and must not propose or run subagents. Forked child context filtering also removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results.

## Optional shortcuts

The package includes reusable prompt templates for common workflows. You do not need them, but they are handy when you want the same shape every time:

| Prompt                        | Use it for                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/mesh-review`                | Launch fresh-context reviewers with distinct angles, then synthesize what to fix.                           |
| `/mesh-recon`                 | Quick parallel recon pass; add `deep` for artifact-backed lane synthesis.                        |
| `/mesh-handoff`               | Combine external research and `recon` passes into an implementation handoff plan and meta-prompt. |
| `/mesh-context`               | Run parallel `recon` passes for planning or implementation handoff context.                       |
| `/mesh-cleanup`               | Run review-only cleanup passes after implementation; add `autofix` to apply only fixes worth doing now.     |
| `/brainstorm`                 | Design-first exploration before any implementation, with clarifying questions and approach tradeoffs.       |
| `/write-plan`                 | Author an implementation plan from a spec/intent with explicit validation commands and a placeholder scan.  |
| `/gather-context-and-clarify` | Gather focused context, then ask the remaining clarification questions before planning or implementation.        |
## Optional pi-intercom companion

`pi-subagents` works without `pi-intercom`. Install `pi-intercom` only if you want child agents to talk back to the parent Pi session while they are running.

```bash
pi install npm:pi-intercom
```

Most users do not call `intercom` directly. After `pi-intercom` is installed, `pi-subagents` can automatically give child agents a private coordination channel back to the parent session. The bridge recognizes the normal `pi install npm:pi-intercom` package install as well as legacy local extension checkouts.

Use it for work where the child might need a decision instead of guessing:

```text
Run this implementation in the background. If the worker gets blocked or needs a product decision, have it ask me through intercom.
```

```text
Ask oracle to review this plan. If it sees a decision I need to make, have it ask me instead of assuming.
```

The child can use one dedicated coordination tool:

- `contact_supervisor`: the child contacts the parent/supervisor session that delegated the task. Use `reason: "need_decision"` for blocking decisions or clarification, and `reason: "progress_update"` for short non-blocking updates when a discovery changes the plan. Do not ask for clarification when the only conflict is review-only/no-edit versus progress-writing or artifact-writing instructions; no-edit wins.

Child-side routine completion handoffs are still not expected. With the intercom bridge active, parent-side `pi-subagents` sends grouped completion results through `pi-intercom`: one grouped message per foreground parent `subagent` run and one per completed async result file. Acknowledged foreground delivery returns a compact receipt with artifact/session paths; if unacknowledged, the normal full output is preserved. Grouped messages include child intercom targets and full child summaries.

If a child appears stalled, needs-attention notices can show up in the parent session with useful next actions, such as checking `subagent({ action: "status" })`, interrupting the run, or nudging the child.

If messages do not show up, run:

```text
/subagents-doctor
```

For normal use, you do not need to configure anything. Advanced users can tune the bridge with `intercomBridge` in the configuration section below.

At this point, you know enough to use the plugin. The rest of this README is reference material for exact command syntax, custom agents, saved chains, worktrees, and configuration.

## Direct commands

Skip this section until you want exact syntax.

| Command                                      | Description                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/run <agent> [task]`                        | Run one agent; omit the task for self-contained agents                                    |
| `/chain agent1 "task1" -> agent2 "task2"`    | Run agents in sequence                                                                    |
| `/parallel agent1 "task1" -> agent2 "task2"` | Run agents in parallel                                                                    |
| `/chain <chainName> -- <task>`               | Launch a saved `.chain.md` workflow (also supports inline `agent "task" -> agent` syntax) |
| `/subagents-doctor`                          | Show read-only setup diagnostics                                                          |

Commands validate agent names locally, support tab completion, and send results back into the conversation.

### Per-step tasks

Use `->` to separate steps and give each step its own task:

```text
/chain recon "scan the codebase" -> planner "create an implementation plan"
/parallel recon "find security issues" -> reviewer "check code style"
```

Both double and single quotes work. You can also use `--` as a delimiter:

```text
/chain recon -- scan code -> planner -- analyze auth
```

Steps without a task inherit behavior from the execution mode. Chain steps get `{previous}`, the prior step’s output. Parallel steps use the first available task as a fallback.

```text
/chain recon "analyze auth" -> planner -> worker
# recon gets "analyze auth"; planner gets recon output; worker gets planner output
```

For a shared task, list agents and place one `--` before the task:

```text
/chain recon planner -- analyze the auth system
/parallel recon reviewer -- check for security issues
```

### Inline per-step config

Append `[key=value,...]` to an agent name to override defaults for that step:

```text
/chain recon[output=context.md] "scan code" -> planner[reads=context.md] "analyze auth"
/run worker[lane=hard] summarize this codebase
/parallel reviewer[skills=code-review+security] "review backend" -> reviewer[model=openai/gpt-5-mini] "review frontend"
```

| Key          | Example                           | Description                                                                                                                                           |
| ------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `output`     | `output=context.md`               | Write results to a file. For `/chain` and `/parallel`, relative paths live under the chain directory; for `/run`, relative paths resolve against cwd. |
| `outputMode` | `outputMode=file-only`            | Return only a concise file reference for saved output instead of the full saved content. Requires `output`; default is `inline`.                      |
| `reads`      | `reads=a.md+b.md`                 | Read files before executing. `+` separates multiple paths.                                                                                            |
| `model`      | `model=anthropic/claude-sonnet-4` | Override model for this step.                                                                                                                         |
| `skills`     | `skills=planning+review`          | Override injected skills. `+` separates multiple skills.                                                                                              |
| `progress`   | `progress`                        | Enable progress tracking.                                                                                                                             |
| `lane`       | `lane=hard`                       | Resolve a named model/thinking lane from `subagents.modelLanes` before dispatch.                                                                  |

Set `output=false`, `reads=false`, or `skills=false` to disable that behavior explicitly. Do not use `output=false` for file-only returns; use `outputMode=file-only` with an `output` path.

### Background and forked runs

Add `--bg` to run in the background:

```text
/run recon "audit the codebase" --bg
/chain recon "analyze auth" -> planner "design refactor" -> worker --bg
/parallel recon "scan frontend" -> recon "scan backend" --bg
```

Add `--fork` to start each child from a real branched session created from the parent’s current leaf:

```text
/run reviewer "review this diff" --fork
/chain recon "analyze this branch" -> planner "plan next steps" --fork
/parallel recon "audit frontend" -> reviewer "audit backend" --fork
```

You can combine them in either order:

```text
/run reviewer "review this diff" --fork --bg
/run reviewer "review this diff" --bg --fork
```

Background runs are detached. If the parent agent has other independent work, it should keep working. If it has nothing useful to do until the background result arrives, it should end the turn instead of running sleep or status-polling loops. Pi will deliver the completion when the run finishes.

The `oracle` and `worker` builtins are designed for an explicit decision loop. A typical pattern is to ask `oracle` for diagnosis and a recommended execution prompt, then only run `worker` after the main agent approves that direction.

## Clarify and launch UI

Chains open a clarify UI by default so you can preview and edit the workflow before it runs. Single and parallel tool calls can opt into the same flow with `clarify: true`; slash commands launch directly.

Common clarify keys:

- `Enter` runs in the foreground, or in the background if background is toggled on
- `Esc` cancels or backs out
- `↑↓` moves between steps or tasks
- `e` edits the task/template
- `m` selects a model
- `t` selects thinking level
- `s` selects skills
- `b` toggles background execution
- `w` edits output/write behavior where supported
- `r` edits reads where supported
- `p` toggles progress tracking where supported
  Picker screens use `↑↓`, `Enter`, `Esc`, and type-to-filter. The full-screen editor supports word wrapping, paste, `Esc` to save, and `Ctrl+C` to discard.

## Agents and chains

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in the child Pi process.

Agent locations, lowest to highest priority:

| Scope   | Path                                      |
| ------- | ----------------------------------------- |
| Builtin | `~/.pi/agent/extensions/subagent/agents/` |
| User    | `~/.pi/agent/agents/**/*.md`              |
| Project | `.pi/agents/**/*.md`                      |

Project discovery also reads legacy `.agents/**/*.md` files. Nested subdirectories are discovered recursively. `.chain.md` files do not define agents. If both `.agents/` and `.pi/agents/` define the same parsed runtime agent name, `.pi/agents/` wins. Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Pi default model unless you set `subagents.agentOverrides.<name>.model`. `oracle` is an advisory reviewer that critiques direction and proposes an execution prompt without editing files. `worker` is the implementation agent for normal tasks and approved oracle handoffs.

For web-backed research, use `recon` with a clear web-research prompt and make sure the parent Pi session has web tools available. Common options include:

- [pi-web-access](https://github.com/nicobailon/pi-web-access) for `web_search`, `fetch_content`, and `get_search_content`.
- [`@counterposition/pi-web-search`](https://www.npmjs.com/package/@counterposition/pi-web-search) for `web_search` and `web_fetch`.

```bash
pi install npm:pi-web-access
# or
pi install npm:@counterposition/pi-web-search
```

### Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides.

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `subagents.disableBuiltins: true` in settings.

### Prompt assembly

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi’s whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field                         | Effect                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `systemPromptMode: append`    | Append the agent prompt to Pi’s normal base prompt.                                               |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`.                  |
| `inheritSkills: true`         | Let the child see Pi’s discovered skills catalog.                                                 |
| `defaultContext: fork`        | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box. Custom agents created without explicit frontmatter use conservative generic defaults (`systemPromptMode: replace`, no implicit project/skill inheritance).

### Agent frontmatter

A typical agent looks like this:

```yaml
---
name: helper
# Optional: registers this as code-analysis.helper while preserving name: helper
package: code-analysis
description: Focused project helper
tools: read, grep, find, ls, bash, mcp:chrome-devtools
extensions:
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, chrome-devtools
output: context.md
defaultReads: context.md
defaultProgress: true
interactive: true
maxSubagentDepth: 1
---
Your system prompt goes here.
```

`maxSubagentDepth: 1` above is an example of an individual agent tightening the inherited/global limit; the default global limit is documented in the configuration table below.

Important fields:

| Field                   | Notes                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package`               | Optional package identifier. A file with `name: helper` and `package: code-analysis` registers as `code-analysis.helper`; serialization keeps `name` and `package` separate. |
| `tools`                 | Builtin tool allowlist. `mcp:` entries select direct MCP tools when `pi-mcp-adapter` is installed.                                                                         |
| `extensions`            | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions.                                                          |
| `model`                 | Default model. Bare ids prefer the current provider when possible, then unique registry matches.                                                                           |
| `fallbackModels`        | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. Ordinary task failures do not trigger fallback.                      |
| `thinking`              | Appended as a `:level` suffix at runtime unless a suffix is already present.                                                                                               |
| `systemPromptMode`      | `replace` by default; `append` keeps Pi’s base prompt.                                                                                                                     |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks.                                                                                                                      |
| `inheritSkills`         | Keeps or strips Pi’s discovered skills catalog.                                                                                                                            |
| `defaultContext`        | Optional `fresh`, `lineage`, or `fork` launch context default for this agent.                                                                                                          |
| `skills`                | Injects specific skills directly, regardless of `inheritSkills`.                                                                                                           |
| `output`                | Default single-agent output file.                                                                                                                                          |
| `defaultReads`          | Files to read before running in chain/parallel behavior.                                                                                                                   |
| `defaultProgress`       | Maintain `progress.md`.                                                                                                                                                    |
| `interactive`           | Parsed for compatibility but not enforced in v1.                                                                                                                           |
| `maxSubagentDepth`      | Tightens nested delegation for this agent’s children.                                                                                                                      |

### Tool and extension selection

If `tools` is omitted, `pi-subagents` does not pass `--tools`, so the child gets Pi’s normal builtin tools. If `tools` is present, regular tool names become an explicit allowlist. `mcp:` entries are split out and forwarded as direct MCP selections. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: mcp:chrome-devtools`: normal builtins plus direct Chrome DevTools MCP tools.
- `tools: read, bash, mcp:chrome-devtools`: only `read` and `bash` as builtins, plus direct Chrome DevTools MCP tools.

Direct MCP tools require [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Subagents only receive direct MCP tools when `mcp:` entries are listed in their frontmatter; global `directTools: true` in `mcp.json` is not enough by itself. The generic `mcp` proxy tool can still be used for discovery when available. The adapter caches tool metadata at startup, so after connecting a new MCP server for the first time, restart Pi before relying on direct tools.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

## Chain files

Chains are reusable `.chain.md` workflows stored separately from agent files.

| Scope   | Path                               |
| ------- | ---------------------------------- |
| User    | `~/.pi/agent/chains/**/*.chain.md` |
| Project | `.pi/chains/**/*.chain.md`         |

Nested subdirectories are discovered recursively. If user and project scopes define the same parsed runtime chain name, the project chain wins. Chains support the same optional `package` frontmatter as agents; `name: review-flow` plus `package: code-analysis` runs as `code-analysis.review-flow`.

Example:

```md
---
name: context-plan
description: Gather context then plan implementation
---

## recon

output: context.md

Analyze the codebase for {task}

## planner

reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create an implementation plan based on {previous}
```

Each `## agent-name` section is a step. Config lines such as `output`, `outputMode`, `reads`, `model`, `skills`, and `progress` go immediately after the header. A blank line separates config from task text.

For `output`, `reads`, `skills`, and `progress`, chain behavior is three-state: omitted inherits from the agent, a value overrides, and `false` disables.

Create chains by writing `.chain.md` files directly or with the `subagent({ action: "create", config: ... })` management action. Run them with natural language or:

```text
/chain context-plan -- refactor authentication
```

### Built-in chain templates

| Chain | Steps                                                        | Description                                                                         |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `go`  | recon → planner → worker → reviewer | Full implementation pipeline: gather context, plan, implement, and review. |

The former `review` chain has been retired. Use `/mesh-review` for model-diverse review plus synthesis.

## Chain variables

Task templates support:

| Variable      | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `{task}`      | Original task from the first step.                                     |
| `{previous}`  | Output from the prior step, or aggregated output from a parallel step. |
| `{chain_dir}` | Path to the chain artifact directory.                                  |
| `{outputs.name}` | A prior step's captured output, by its `as` name (see Structured output). |

Parallel outputs are aggregated with clear separators before being passed to the next step:

```text
=== Parallel Task 1 (worker) ===
...

=== Parallel Task 2 (worker) ===
...
```

## Structured output and named outputs

A chain step (sequential, or a parallel task) can require its child to return **schema-valid structured output** instead of free-form prose. Set `outputSchema` to a JSON Schema object; the child must finish by calling the `structured_output` tool with a value that validates against it. The value is captured out-of-band (not parsed from prose) — a prose-only or invalid result fails the step.

Expose a step's result with `as`, then reference it from a later step with `{outputs.name}` (substituted with compact structured JSON when the step produced structured output, otherwise the step's text):

```ts
{
  chain: [
    {
      agent: "recon",
      task: "List the changed source files as JSON.",
      as: "changed",
      outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] },
    },
    { agent: "reviewer", task: "Review these files: {outputs.changed}" },
  ],
}
```

Bindings are validated before execution: `as` names must be unique valid identifiers, and `{outputs.name}` may only reference a step that has already produced its output. Structured output works in the **foreground** and in **async/background** runs, on chain steps (sequential steps and parallel tasks within a chain) — not top-level single dispatch. `outputSchema` and `as` are configured through the `subagent({ chain: [...] })` JSON form or a saved `.chain.js` chain; `.chain.md` files do not parse them.

## Dynamic fanout (`expand` / `collect`)

A chain step can expand an array from a prior step's structured output into N parallel subagent tasks, then collect the results back into a single named array. Use a single `parallel` **template** object (not an array) together with `expand` and `collect`:

```ts
{
  chain: [
    {
      agent: "recon",
      task: "Return JSON: a list of files to refactor.",
      as: "plan",
      outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] },
    },
    {
      expand: { from: { output: "plan", path: "/files" }, item: "file", maxItems: 20 },
      parallel: { agent: "worker", task: "Refactor {file}" },
      collect: { as: "results" },
    },
    { agent: "reviewer", task: "Summarize: {outputs.results}" },
  ],
}
```

- `expand.from` addresses the source array by a prior `as` name + a JSON Pointer `path`.
- `item` names the per-item template variable (`{item}`, `{item.field}`); `maxItems` caps the fanout (the `dynamicFanoutMaxItems` config knob sets the default); per-item keys are de-duplicated.
- `onEmpty` controls an empty source array: `skip` (default) stores an empty result array and continues the chain; `fail` aborts the step.
- `concurrency` and `failFast` mirror the static-parallel semantics for the materialized tasks.
- `collect.as` stores the per-item results (optionally validated with `collect.outputSchema`), referenceable as `{outputs.<as>}`. The substituted value is a **JSON array of per-item result objects** — each carries the expanded `item`, the `agent`, and that item's `text`/`structured` output — not a single scalar, so its size grows with the item count. Per-item `as` is **not** supported on a dynamic template; aggregate via `collect.as`.

Dynamic fanout **requires a prior step that produced a structured array** (via `as` + `outputSchema`) — structured output (above) is a hard prerequisite. It is available through direct `subagent({ chain: [...] })` JSON and saved `.chain.js` files, and works in the **foreground and in async/background** runs: the background runner materializes the per-item tasks at runtime from the prior step's structured output and collects them into `{outputs.<as>}` for downstream steps. Two async-only caveats today: materialized items run without per-item session files or intercom targets, so they can't be individually resumed/shared or contacted mid-run, and a `context: "fork"` dynamic template does not fork per item in the background.

## Skills

Skills are `SKILL.md` files injected into an agent’s system prompt.

Discovery uses project-first precedence:

1. `.pi/skills/{name}/SKILL.md`
2. Project packages and project settings packages via `package.json -> pi.skills`
3. Current task cwd package via `package.json -> pi.skills`
4. `.pi/settings.json -> skills`
5. `~/.pi/agent/skills/{name}/SKILL.md`
6. User packages and user settings packages via `package.json -> pi.skills`
7. `~/.pi/agent/settings.json -> skills`

Use agent defaults, override them at runtime, or disable them:

```ts
{ agent: "worker", task: "..." }
{ agent: "worker", task: "...", skill: "test-writer" }
{ agent: "worker", task: "...", skill: false }
```

For chains, `skill` at the top level is additive. A step-level `skill` overrides that step; `false` disables skills for that step.

Injected skills use this shape:

```xml
<skill name="safe-bash">
[skill content from SKILL.md, frontmatter stripped]
</skill>
```

Missing skills do not fail execution. The result summary shows a warning.

### Bundled skill

The package bundles a `pi-subagents` skill that is automatically available to the parent agent when the extension is installed. It is for the orchestrating parent only: child subagents never receive it, and their context is explicitly filtered to strip parent-only orchestration instructions.

What the bundled skill covers:

- **Delegation patterns**: when to launch which agent, whether to use single, parallel, chain, or async mode, and whether to use fresh or forked context
- **Prompt workflow recipes**: how to apply the packaged techniques directly with `subagent(...)` when the user describes the workflow in natural language instead of invoking a slash command. This includes parallel review, parallel research, parallel handoff-plan, brainstorm, write-plan, and parallel cleanup
- **Role-agent prompting guidance**: compact contract prompts instead of long scripts, what to include in role-specific meta prompts, and retrieval budgets for context-building research
- **Safety boundaries**: child agents must not run subagents, must not invent intercom targets, and must escalate unapproved decisions
- **Intercom conventions**: when to ask vs send, and how parent-side result delivery works with `pi-intercom`
- **Control and diagnostics**: attention signals, soft interrupts, status, and the `doctor` action

If you are writing an agent that orchestrates subagents, the bundled skill helps it behave correctly without guessing the patterns. If you are a human user, you do not need to read it directly; the README and prompt shortcuts encode the same workflows in user-facing form.

The package also bundles a `test-writer` skill (`skills/test-writer/SKILL.md`) for subagents tasked with writing tests. It guides the agent through mandatory test infrastructure discovery — finding the exact test runner command, loader shims, existing helpers, and mock patterns — before writing any test code. Use it by injecting the skill into `worker` for test-focused implementation.

## Programmatic tool usage

These are the parameters the LLM passes when it calls the `subagent` tool. Most users ask naturally or use slash commands instead.

### Execution examples

```ts
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "recon", task: "find todos", output: "reports/context.md", outputMode: "file-only" }
{ agent: "recon", task: "investigate", output: false }
{ agent: "worker", task: "write a large report", output: "reports/worker.md", outputMode: "file-only" }

// Forked context
{ agent: "worker", task: "continue this thread", context: "fork" }

// Parallel
{ tasks: [{ agent: "recon", task: "a" }, { agent: "reviewer", task: "b" }] }
{ tasks: [{ agent: "recon", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "recon", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }], context: "fork" }

// Chain
{ chain: [
  { agent: "recon", task: "Gather context for auth refactor" },
  { agent: "planner" },
  { agent: "worker" },
  { agent: "reviewer" }
]}

// Chain without TUI, suitable for background execution
{ chain: [...], clarify: false, async: true }

// Chain with fan-out/fan-in
{ chain: [
  { agent: "recon", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {previous}" },
    { agent: "worker", task: "Implement feature B from {previous}" }
  ], concurrency: 2, failFast: true },
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}

// Chain with structured output + named references
{ chain: [
  { agent: "recon", task: "List changed files as JSON", as: "files",
    outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] } },
  { agent: "worker", task: "Refactor each file in {outputs.files}" }
]}

// Dynamic fanout: expand a prior step's array into N parallel tasks (foreground)
{ chain: [
  { agent: "recon", task: "List modules as JSON", as: "mods",
    outputSchema: { type: "object", properties: { mods: { type: "array", items: { type: "string" } } }, required: ["mods"] } },
  { expand: { from: { output: "mods", path: "/mods" }, maxItems: 10 },
    parallel: { agent: "worker", task: "Document module {item}" },
    collect: { as: "docs" } },
  { agent: "reviewer", task: "Review module docs from {outputs.docs}" }
]}

// Worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

### Management actions

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents and chains at runtime.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "recon" }
{ action: "get", agent: "code-analysis.helper" }
{ action: "get", chainName: "review-pipeline" }

{ action: "create", config: {
  name: "Code Helper",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a focused codebase helper...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash, mcp:github/search_repositories",
  extensions: "",
  skills: "codebase-onboarding",
  thinking: "high",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

{ action: "create", config: {
  name: "review-pipeline",
  description: "Context then review",
  scope: "project",
  steps: [
    { agent: "recon", task: "Scan {task}", output: "context.md" },
    { agent: "reviewer", task: "Review {previous}", reads: ["context.md"] }
  ]
}}

{ action: "update", agent: "code-analysis.helper", config: { model: "openai/gpt-4o" } }
{ action: "update", chainName: "review-pipeline", config: { steps: [...] } }
{ action: "delete", agent: "helper" }
{ action: "delete", chainName: "review-pipeline" }
```

`create` uses `config.scope`, not `agentScope`. `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter. `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes. To clear optional string fields, including `package`, set them to `false` or `""`.

### Parameter reference

| Param             | Type                          | Default                  | Description                                                                                                                            |
| ----------------- | ----------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`           | string                        | -                        | Agent name for single mode, or target for management actions.                                                                          |
| `task`            | string                        | -                        | Task string for single mode.                                                                                                           |
| `action`          | string                        | -                        | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `resume`, or `doctor`.                                             |
| `chainName`       | string                        | -                        | Chain name for management actions.                                                                                                     |
| `config`          | object/string                 | -                        | Agent or chain config for create/update.                                                                                               |
| `output`          | `string \| false`             | agent default            | Override single-agent output file.                                                                                                     |
| `outputMode`      | `"inline" \| "file-only"`     | `inline`                 | Return saved output inline or as a concise saved-file reference. `file-only` requires an `output` path.                                |
| `skill`           | `string \| string[] \| false` | agent default            | Override skills or disable all.                                                                                                        |
| `model`           | string                        | agent default            | Override model.                                                                                                                        |
| `tasks`           | array                         | -                        | Top-level parallel tasks. Supports `agent`, `task`, `cwd`, `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, and `model`. |
| `concurrency`     | number                        | config or `4`            | Top-level parallel concurrency.                                                                                                        |
| `budget`          | number                        | config default           | Per-run output-token ceiling. Counts completed child output tokens only; when spent output reaches the ceiling, later chain/background steps are skipped as `budget-exhausted` while already-launched parallel children finish. |
| `worktree`        | boolean                       | false                    | Create isolated git worktrees for parallel tasks.                                                                                      |
| `chain`           | array                         | -                        | Sequential and parallel chain steps.                                                                                                   |
| `context`         | `fresh \| lineage \| fork`     | agent default or `fresh` | `fresh` starts a clean independent child session; `lineage` starts clean but links the child session under the parent tree; `fork` creates a branched child session with the inherited parent transcript. Packaged `worker` and `oracle` default to `fork`; `planner` and other planning roles default to `fresh`. |
| `chainDir`        | string                        | temp chain dir           | Persistent directory for chain artifacts.                                                                                              |
| `clarify`         | boolean                       | true for chains          | Show TUI preview/edit flow.                                                                                                            |
| `agentScope`      | `user \| project \| both`     | `both`                   | Agent discovery scope. Project wins on collisions.                                                                                     |
| `async`           | boolean                       | false                    | Background execution. Chains require `clarify: false`.                                                                                 |
| `cwd`             | string                        | runtime cwd              | Override working directory.                                                                                                            |
| `maxOutput`       | object                        | 200KB, 5000 lines        | Final output truncation limits.                                                                                                        |
| `artifacts`       | boolean                       | true                     | Write debug artifacts.                                                                                                                 |
| `includeProgress` | boolean                       | false                    | Include full progress in result.                                                                                                       |
| `share`           | boolean                       | false                    | Upload session export to GitHub Gist.                                                                                                  |
| `sessionDir`      | string                        | derived                  | Override session log directory.                                                                                                        |

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. It never silently downgrades to `fresh`. In multi-agent runs, if any requested agent has `defaultContext: fork` and the launch omits `context`, the whole invocation uses forked context; pass `context: "fresh"` when you intentionally want a fresh run.

`context: "lineage"` is the middle ground between `fresh` and `fork`: the child gets a blank model context, but its session header points at the parent session file so Pi can show the relationship in session-tree tools. Use it when you want traceable subagent branches without paying to copy the parent transcript. Lineage does **not** remove child Pi process startup latency — it is an organization/linking feature, not a performance one. V1 requires all children to run in the top-level cwd; use `fresh` or `fork` when per-task `cwd`/`worktree` isolation is required. The `fork-only` intercom mode does not activate for lineage children because they do not inherit the parent transcript.

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging. In chains, later `{previous}` steps receive the same compact reference when the prior step used file-only mode.

Sequential and parallel chain tasks accept `agent`, `task`, `cwd`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, and `thinking`. Parallel tasks also accept `count`. Parallel step groups accept `parallel`, `concurrency`, `failFast`, and `worktree`. Chain steps and parallel tasks additionally accept `as` (expose the result under a name) and `outputSchema` (require schema-valid structured output) — see Structured output. A dynamic-fanout step replaces `agent`/`task` with `expand` + a single `parallel` template + `collect` — see Dynamic fanout.

Status and control actions:

```ts
subagent({ action: "status" });
subagent({ action: "status", id: "<run-id>" });
subagent({ action: "interrupt", id: "<run-id>" });
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" });
subagent({
  action: "resume",
  id: "<run-id>",
  index: 1,
  message: "follow-up for child 2",
});
subagent({ action: "doctor" });
```

`resume` sends the follow-up directly when an async child is still reachable over intercom. After completion, it revives the child by starting a new async child from the stored child session file. Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.

## Worktree isolation

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child its own git worktree branched from `HEAD`.

```ts
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }

{ chain: [
  { agent: "recon", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {previous}" },
    { agent: "worker", task: "Implement feature B from {previous}" }
  ], worktree: true },
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}
```

Requirements:

- run inside a git repo
- working tree must be clean
- `node_modules/` is symlinked into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Worktrees and temp branches are cleaned up in `finally` blocks.

## Configuration

`pi-subagents` reads optional JSON config from `~/.pi/agent/extensions/subagent/config.json`.

| Setting                          | Type    | Default    | Description                                                                                                                                                                                                                                                   |
| -------------------------------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asyncByDefault`                 | boolean | `false`    | Use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.                                                                                     |
| `forceTopLevelAsync`             | boolean | `false`    | Force depth-0 single, parallel, and chain runs into background mode and bypass clarify UI. Nested calls keep their own inherited settings.                                                                                                                    |
| `parallel.maxTasks`              | number  | `8`        | Maximum parallel tasks.                                                                                                                                                                                                                                       |
| `parallel.concurrency`           | number  | `4`        | Maximum concurrent parallel tasks. Per-call `concurrency` takes precedence.                                                                                                                                                                                   |
| `defaultSessionDir`              | string  | derived    | Session directory. Precedence: `params.sessionDir` → `config.defaultSessionDir` → derived from parent session.                                                                                                                                                |
| `maxSubagentDepth`               | number  | `2`        | Nested delegation limit when no inherited `PI_SUBAGENT_MAX_DEPTH` is in effect. Per-agent `maxSubagentDepth` can tighten but not relax an inherited limit.                                                                                                    |
| `sessionTokenBudget`            | number  | none       | Default per-run output-token ceiling used when a call omits `budget`. Counts completed child output tokens only; exhausted budgets stop later chain/background dispatch and report `budget-exhausted` without killing in-flight children. |
| `intercomBridge.mode`            | string  | `"always"` | `"always"`, `"fork-only"` (inject only for forked runs), or `"off"`.                                                                                                                                                                                          |
| `intercomBridge.instructionFile` | string  | built-in   | Optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/subagent/`.                                                                                 |
| `worktreeSetupHook`              | string  | none       | Script to run once per created worktree. Paths must be absolute, `~/...`, or repo-relative. stdin is JSON with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, `baseCommit`. stdout must be JSON, e.g. `{ "syntheticPaths": [".venv"] }`. |
| `worktreeSetupHookTimeoutMs`     | number  | `30000`    | Timeout for the worktree setup hook.                                                                                                                                                                                                                          |
| `inlineReadMaxBytes`             | number  | `204800`   | Max bytes for inline-read content in fresh-context children. Range: `[1024, 8MB]`.                                                                                                                                                                            |
| `dynamicFanoutMaxItems`          | number  | none       | Default cap on dynamic-fanout expanded items when a step omits `expand.maxItems`. A dynamic step with no effective cap (neither here nor on the step) is rejected before execution.                                                                            |

Bridge activation requires `pi-intercom` to be installed and enabled, a targetable session name, and `pi-intercom` in any explicit agent `extensions` allowlist. The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked and `reason: "progress_update"` for meaningful updates.

## Files, logs, and observability

Each chain run creates a user-scoped temp directory like:

```text
<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/
```

It may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. Directories older than 24 hours are cleaned up on extension startup.

Debug artifacts live under `{sessionDir}/subagent-artifacts/` or a user-scoped temp artifact directory. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent’s current leaf. That is a real session fork, not an injected summary.

Async completions notify only the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to render completion notifications.

Async runs write:

```text
<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` powers the widget and `subagent({ action: "status" })` output. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, duration, activity freshness, and current-tool duration.

Press `Ctrl+O` to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done recon → running planner`. Chains with parallel steps show per-step cards instead.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "recon", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Subagents can call `subagent`, which can get expensive and hard to observe. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session → subagent → sub-subagent. Deeper calls are blocked with guidance to complete the current task directly.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually.

## Runaway stream guard

Each child process is spawned with `--mode json`, and its event stream is watched for runaway output. When any guard below trips, the child is aborted (SIGINT, then SIGTERM after 1s) and the step fails with a `runaway output aborted: ...` error that names the cause; async runs record it in `status.json` and `events.jsonl`.

- **Degenerate streaming loops.** A model can get stuck repeating a fragment forever — e.g. reissuing the trailing key-value pair of a tool call's JSON arguments (`, "timeout": 60000, "timeout": 60000, ...`) and never closing the object. A periodic-suffix scan over the normalized per-content-block delta tail detects this within seconds and aborts with the repeated fragment named. It is tolerant of cycling values and shifting chunk boundaries (numeric literals and whitespace are normalized), and tracks each content block independently so loops that interleave concurrent tool calls are still caught.
- **No-progress thinking floods.** A child that streams past 30 MB of raw stdout without ever emitting assistant text or a tool call (a thinking loop) is aborted.
- **Hard cap.** A backstop bounds total output even when the stream shows progress. It counts *delta-aware* bytes — the payload each `message_update` actually adds, not the full re-serialized snapshot — so verbose-but-honest runs are not killed by the quadratic amplification of snapshot streaming. A separate 1 GB raw-byte backstop bounds any other flood shape.

These guards are internal and not configurable; they sit below the per-step inactivity timeout and overall run wall-clock timeout, which govern liveness.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices and persisted for async runs. With `pi-intercom`, needs-attention notices and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.

## Prompt-template integration

`pi-subagents` works standalone through natural language, the `subagent` tool, slash commands, and the packaged prompt shortcuts listed near the top of this README. Pi loads bundled prompt templates from this package's `pi.prompts` manifest entry plus user/project prompt directories. The prompt-template bridge lets those templates request subagent runs with prescribed agents, context modes, outputs, and model settings.

Example:

```md
---
description: Take a screenshot
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---

Use url in the prompt to take screenshot: $@
```

Then `/take-screenshot https://example.com` switches to Sonnet, delegates to `browser-screenshoter` with `/tmp/screenshots` as cwd, and restores your model when done. Runtime overrides like `--cwd=<path>` and `--subagent=<name>` work too.

For additional reusable workflows on top of subagents, add custom prompt templates under `~/.pi/agent/prompts/`, project `.pi/prompts/`, or another package that declares `pi.prompts`.

## Changes from upstream

Bug fixes:

- **Fix 1 — Output recovery on non-zero exit**: When a child exits with an error but produced partial output, the recovered text is returned with an `[Subagent exited with error: …]` footer instead of bare `"terminated"`. No more losing useful output to a non-zero exit code.
- **Bug A — `defaultReads` dropped on fresh-context single-mode**: An agent's frontmatter `defaultReads` was silently ignored when called without explicit `reads` in single-mode fresh context. Now flows through correctly; only `reads: false` explicitly opts out.
- **Bug B — "Pre-loaded files" lying when a read fails**: Failed reads were wrapped in the `Pre-loaded files (do not Read these)` header, telling the child not to Read a file it manifestly should. Failed entries are now pulled out and emitted as a separate `[Read from: <failed paths>]` hint.
- **Bug C — Truncation marker mislabel**: Truncation footer said `bytes` but sliced characters (up to 4× off on multi-byte text). Now says `characters` and uses `Buffer.byteLength` for the cap comparison.
- **Bug D — `parseReadSpec` regex greedily eats colons in filenames**: A file named `foo:5-10.bak` was mis-parsed as path `foo` + range `5-10`. Now stat-checks the literal path first; only parses as a range when the literal doesn't exist.
- **Bug F — Tilde expansion in glob specs**: `reads: ["~/.pi/.../*.ts"]` failed because `~` wasn't expanded before `fs.globSync`. Fixed with the same tilde-expansion pattern as `resolveChainPath`.

Features:

- **Auto-inline reads on `context: "fresh"`**: Files listed in `reads` are pre-loaded into the child's first user message, saving the child a full context-fork (~261K tokens → ~13K tokens observed). This was partially upstream (parallel/chain paths); our fork extends it to single-agent paths and fixes the plumbing.
- **Glob support in `reads`**: `reads: ["src/**/*.ts"]` expands glob patterns with deterministic sorting and a 50-match cap. Literal files with glob characters (`weird[brackets].ts`) are handled via stat-fallback (same pattern as Bug D). Zero-match globs emit a `[Read from glob (no matches): ...]` hint.
- **Config-exposed `inlineReadMaxBytes`**: The 200KB inline-read cap is now configurable via `inlineReadMaxBytes` in extension config, with a `[1024, 8MB]` range guard.
- **Token-economy footer**: Fresh-context results append `[mode=fresh, in=…, out=…, cache_read=…, cache_write=…]` so savings are observable without digging into JSONL.
- **Recovery telemetry**: When Fix 1's output-recovery triggers, a structured `subagent_recovery` event (with `runId`, `agent`, `exitCode`, `recoveredChars`, `elapsedMs`) is emitted into the parent's session JSONL (`display: false`).
- **Compatibility agents preserved disabled-by-default**: Legacy roles such as `oracle-fresh` remain on disk for explicit opt-in, while the default visible roster stays focused on recon, planner, worker, reviewer, oracle, and janitor.
- **`planner` flipped to `defaultContext: fresh`**: The bundled planner now defaults to fresh context with curated `defaultReads`, routing every existing caller through the cheaper path without code changes.
- **`--no-context-files` for fresh children**: Fresh-context children now get `--no-context-files` in their spawn args, preventing `AGENTS.md`/`CLAUDE.md` from leaking into the child's system prompt. Forked children keep their normal context loading.

Optimizations:

- **Cache + deduplicate inline reads**: A process-scoped `Map<string, string>` keyed by `(absPath, mtimeMs, size)` caches `readFileSync` results. Same file across N parallel tasks = 1 read, N-1 cache hits. Automatic invalidation on file change via mtime+size.
- **Drop redundant `resolveStepBehavior` call**: The single-mode fresh-reads patch resolved output/skills/model/progress just to extract `reads`. Replaced with an inline fallback: `const reads = readsOverride ?? agentConfig.defaultReads ?? false`.

Ported from upstream (v0.39.0):

- **Structured output** (`outputSchema` + `{outputs.name}`) and **dynamic fanout** (`expand`/`collect`) were reimplemented from upstream — both in the foreground and in the async/background runner (async dynamic fanout landed in v0.40.0). Upstream's acceptance-gate and workflow-graph machinery were intentionally not ported. See the Structured output and Dynamic fanout sections.

Visible cleanup role:

- **`janitor`**: Repository hygiene agent with `contact_supervisor` escalation. Designed for dead code removal, stale docs, orphaned artifact audits, and structural cleanup. The old `deslopper` file remains as a disabled compatibility alias.
- Compatibility aliases can be re-enabled explicitly through builtin overrides when needed.

All current unit and integration tests pass in this checkout; see the latest changelog entry for current counts.

## Runtime files

The main runtime files are:

| File                                                                        | Purpose                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/extension/index.ts`                                                    | Extension registration, tool registration, message/render wiring.                                      |
| `src/agents/agents.ts`                                                      | Agent and chain discovery, frontmatter parsing.                                                        |
| `src/runs/foreground/subagent-executor.ts`                                  | Main execution routing for single, parallel, chain, management, status, interrupt, and doctor actions. |
| `src/runs/foreground/execution.ts`                                          | Core foreground `runSync` handling.                                                                    |
| `src/runs/background/subagent-runner.ts`                                    | Detached async runner.                                                                                 |
| `src/runs/background/async-execution.ts`                                    | Background launch support.                                                                             |
| `src/runs/background/async-status.ts`                                       | Status discovery and formatting for async runs.                                                        |
| `src/runs/foreground/chain-execution.ts` / `src/agents/chain-serializer.ts` | Chain orchestration and `.chain.md` parsing.                                                           |
| `src/shared/settings.ts`                                                    | Chain behavior, instructions, and config helpers.                                                      |
| `src/runs/shared/worktree.ts`                                               | Git worktree isolation.                                                                                |
| `src/runs/shared/usage.ts` / `exit-drain.ts` / `output-buffer.ts` / `stdio-parser.ts` | Shared runner primitives: usage accumulation, drain timer constants, recent-output ring buffer, JSON line processor. |
| `src/tui/subagent-hub.ts`                                                   | Subagent hub TUI for browsing agents and configuring model overrides before launch.                    |
| `src/intercom/intercom-bridge.ts`                                           | Runtime intercom bridge instructions and diagnostics.                                                  |
| `src/extension/schemas.ts` / `src/shared/types.ts`                          | Tool schemas, shared types, and event constants.                                                       |
| `src/runs/shared/structured-output.ts` / `chain-outputs.ts` / `dynamic-fanout.ts` | Structured-output capture and validation, `{outputs.name}` resolution, and dynamic-fanout materialization. |
| `test/unit/` / `test/integration/`                                          | Unit and loader-based integration tests.                                                               |
