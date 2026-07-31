# pi-subagents — Architecture

A contributor-facing map of the codebase. It explains the **request lifecycle** and
**where things live**, so you can find the right file without grepping the whole tree.

> This is a map, not a spec. File responsibilities are stable; exact line numbers
> drift — verify against source before editing. Run `codegraph_explore` for the
> current verbatim source of any symbol named here.

---

## 1. The 30-second model

`pi-subagents` registers one tool (`subagent`) and a set of `/`-commands that let an
orchestrating Pi session **delegate work to child Pi processes**. A delegation can run:

- **single** — one agent, one task;
- **parallel** — many tasks (optionally fanned out, optionally in git worktrees);
- **chain** — a sequential pipeline with shared artifacts (`context.md`, `plan.md`, `progress.md`).

Each child is a real `pi` subprocess. The parent streams its stdout/stderr, tracks status,
recovers from transient failures, and renders progress in the TUI. Delegations run either
**foreground** (synchronous, the parent waits) or **background/async** (fire-and-forget,
status polled and reconciled).

---

## 2. Request lifecycle (a single dispatch)

```
subagent({...})                         tool entry        src/extension/index.ts
        │                                                  (default export registerSubagentExtension)
        ▼
executor.execute(id, params, …)         routing front gate src/runs/foreground/subagent-executor.ts
        │
        ├─ validateExecutionInput        exactly one mode: action | agent(single) | tasks(parallel) | chain
        │     └─ unknown agent? ─────────▶ formatUnknownAgentError   src/agents/agent-selection.ts
        │
        ├─ resolve agent + overrides      role → AgentConfig         src/agents/agents.ts
        │     model / lane / thinking                                src/agents/model-lanes.ts, src/shared/model-info.ts
        │
        ├─ resolve context (fresh|fork|lineage)                      src/shared/fork-context.ts
        │     └─ fork: branch parent session, THEN sanitize          src/shared/tool-name-sanitizer.ts
        │
        ▼
   dispatch by mode:
     single  ─▶ foreground   src/runs/foreground/execution.ts
     single  ─▶ background    src/runs/background/async-execution.ts        (when async)
     parallel ─▶              src/runs/background/parallel-groups.ts, src/runs/shared/parallel-utils.ts
     chain   ─▶               src/runs/foreground/chain-execution.ts (+ chain-clarify.ts TUI preview)
        │
        ▼
   runPiStreaming             spawn child pi, stream, accumulate          src/runs/background/subagent-runner.ts
     ├─ build argv                                                        src/runs/shared/pi-args.ts, pi-spawn.ts
     ├─ per-attempt success + model fallback                             src/runs/shared/model-fallback.ts
     ├─ output-aware finalization (resolve declared output file)          src/runs/shared/single-output.ts
     └─ artifacts / event log                                            src/shared/artifacts.ts, jsonl-writer.ts
        │
        ▼
   status, recovery, render
     async tracking + reconcile   src/runs/background/{async-job-tracker,run-status,stale-run-reconciler,result-watcher,notify}.ts
     TUI                          src/tui/render.ts, subagent-hub.ts  +  renderers in src/extension/index.ts
```

### Why fork vs fresh matters (a worked example)

The `worker` agent uses `defaultContext: fork`, which **replays the parent transcript**
into the child via `createBranchedSession`. If the parent transcript contains a malformed
tool call (e.g. an orchestrator model stuffed JSON into a tool *name*), a strict provider
will reject the whole child request with a 400. That is why forked transcripts are
**sanitized at the fork boundary** (`tool-name-sanitizer.ts`) before the child loads them.
`planner` uses `fresh` context and inherits no transcript, so it is immune to that class
of failure. When debugging "child failed but sibling succeeded", check the context mode first.

---

## 3. Directory map

| Directory | Responsibility | Start here |
|---|---|---|
| `src/extension/` | Extension entry point, `subagent` tool registration, schemas, config, doctor, fan-out child | `index.ts`, `schemas.ts` |
| `src/agents/` | Agent & chain **definitions**: discovery, selection/merge, CRUD, serializers, frontmatter, model lanes (read + user-scope write), skills | `agents.ts`, `agent-selection.ts`, `model-lanes.ts` |
| `src/runs/foreground/` | **Synchronous** dispatch: validation, routing, single, chains, chain TUI | `subagent-executor.ts` (the front gate) |
| `src/runs/background/` | **Async** dispatch + run lifecycle: child process, job tracking, status, recovery, notifications | `subagent-runner.ts`, `async-execution.ts` |
| `src/runs/shared/` | Cross-cutting **run** helpers used by both fg and bg | `model-fallback.ts`, `single-output.ts`, `pi-args.ts` |
| `src/shared/` | Generic utilities and types (not run-specific) | `types.ts`, `settings.ts`, `fork-context.ts` |
| `src/slash/` | `/`-command surface and bridges into the executor; reads user + project lanes for the `/subagents` overlay and persists staged lane mutations once after close | `slash-commands.ts` |
| `src/tui/` | Rendering: result widgets, hub, nested render; `subagent-hub.ts` stages lane draft/result state and exposes the lane overlays (lane list, detail, name, model, thinking, delete-confirm) without writing to disk | `render.ts`, `subagent-hub.ts` |
| `src/intercom/` | Cross-agent messaging / result delivery | `intercom-bridge.ts` |
| `src/types/` | Ambient type shims | `node-shims.d.ts` |
| `agents/` (repo root) | The builtin agent role markdown (`worker.md`, `planner.md`, …) | — |
| `chains/` (repo root) | Builtin chain templates (`go.chain.md`) | — |
| `docs/` | Contributor docs: this file, `plans/`, `specs/`, backlog | — |
| `test/{unit,integration}/` | Tests mirror `src/` 1:1 — `foo.ts` → `foo.test.ts` | — |

---

## 4. "Where do I change X?" index

| You want to change… | Go to |
|---|---|
| The `subagent` tool description / parameters | `src/extension/schemas.ts`, `src/extension/index.ts` |
| What happens for an **unknown agent** name | `src/agents/agent-selection.ts` (`formatUnknownAgentError`, `looksLikeModelId`) + call sites in `subagent-executor.ts`, `async-execution.ts`, `chain-execution.ts` |
| How a role resolves to a **model / thinking level / lane** | `src/agents/model-lanes.ts` (read + user-scope write; owns `applyUserModelLaneMutations`, `MODEL_LANE_NAME_PATTERN`, `isValidModelLaneName`, `UserModelLaneMutation`), `src/shared/model-info.ts`, `src/agents/agents.ts` (exports `writeSettingsFile`) |
| **fresh / fork / lineage** context behavior | `src/shared/fork-context.ts` (+ `tool-name-sanitizer.ts`) |
| How the **child `pi` process** is spawned / argv built | `src/runs/shared/pi-spawn.ts`, `pi-args.ts` |
| **Failure classification** (retryable vs transport vs hard) | `src/runs/shared/model-fallback.ts` (`isRetryableModelFailure`, `isTransportFailure`) |
| When a run with a produced output is **finalized as success** | `src/runs/background/subagent-runner.ts` + `src/runs/shared/single-output.ts` |
| **Async** run state, polling, stale recovery | `src/runs/background/{async-job-tracker,run-status,stale-run-reconciler,result-watcher}.ts` |
| **Chain** execution / the clarify TUI | `src/runs/foreground/{chain-execution,chain-clarify}.ts`, `src/agents/chain-serializer.ts` |
| **Parallel** fan-out / worktrees | `src/runs/background/parallel-groups.ts`, `src/runs/shared/{parallel-utils,worktree}.ts` |
| **Settings / config** shape and resolution | `src/shared/settings.ts`, `src/extension/config.ts` |
| **TUI** rendering of results / widget | `src/tui/render.ts`, `src/extension/index.ts` (message renderers); lane overlays (list, detail, name, model, thinking, delete-confirm) and staged lane draft/result state live in `src/tui/subagent-hub.ts` |
| **Slash commands** | `src/slash/slash-commands.ts` (reads user + project lanes for the `/subagents` overlay, persists staged lane mutations once after it closes), `slash-bridge.ts` |
| Builtin **agent roles** (prompts, tools, defaults) | `agents/*.md` (markdown frontmatter, not TS) |

---

## 5. Conventions

- **Imports use `.ts` extensions** (`allowImportingTsExtensions`); the package ships TypeScript
  source directly (`noEmit`). There is no build artifact to import from.
- **Tests mirror source paths** and live in `test/unit` (pure logic) and `test/integration`
  (executor/dispatch/render). Add to the existing mirrored file rather than creating a duplicate.
- Run gates: `npm run typecheck` and `npm test`. Tests are excluded from typecheck
  (`tsconfig.json` → `exclude: ["test"]`).
- Builtin **agents are markdown** in `agents/`, loaded at runtime; only roles whose frontmatter
  is enabled appear in `subagent({ action: "list" })`.
