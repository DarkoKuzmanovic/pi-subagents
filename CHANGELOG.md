# Changelog

## [Unreleased]

### Added

- **Automatic GitHub Releases on tag push.** A new `release.yml` workflow creates a GitHub Release from the tag's CHANGELOG section whenever a `v*` tag is pushed (generated notes as fallback). Idempotent: it skips when a Release already exists, so it coexists with agent- or manually-created releases. Closes the gap that left v0.43.0–v0.45.2 as bare tags with the repo advertising v0.42.2 as Latest.

### Fixed

- **CI typecheck and tests now pass in a truly isolated environment.** The 0.45.3 CI pipeline's first real run failed: the local `node:fs` typecheck shim lacked `chmodSync` (used by the settings permission-preservation fix), and `typebox` — an optional peer — was absent from the lockfile, so `npm ci` installed neither its types nor its runtime for the test suites. Both had been masked locally by the shared dev-tools `node_modules`. The shim gains `chmodSync`, and `typebox` is pinned as a devDependency.

## [0.45.3] - 2026-08-07

### Added

- **Optional CodeGraph guidance for packaged recon, worker, and reviewer roles.** The selected roles use one direct exploration tool when the target checkout is indexed, with sync-first helper and native-search fallbacks.

### Fixed

- **An emptied tool allowlist now fails closed instead of granting the full builtin toolset.** When `disallowedTools` removed every remaining tool, `buildPiArgs` omitted `--tools` entirely and the child defaulted to Pi's complete builtin set — the opposite of what the denylist asked for. An empty effective allowlist now emits `--no-builtin-tools`, and fanout authorization derives from the post-denylist set.
- **The installer can no longer silently divert a local install to upstream.** `install.mjs` hardcoded the upstream repository URL; it now derives the URL from `package.json` and verifies the remote's identity before updating.
- **CI runs a real typecheck and the test suites.** The workflow previously grepped `tsc` output through a pipeline that could mask failures; it now runs `npm run typecheck` and both test suites against a committed `package-lock.json` with TypeScript pinned to 5.9.3.
- **Malformed async result files are quarantined instead of crashing the watcher.** The result watcher validates result-file shape before delivery; files that parse as JSON but violate the result contract move to a `dead-letter/` subdirectory for inspection rather than being retried forever or crashing the poll loop.
- **Settings writes no longer widen a user-tightened file mode.** `writeSettingsFile`'s atomic replace created the temp file with umask-default permissions (usually 0644), resetting e.g. a 0600 `settings.json` on every write. The existing file's mode is now carried onto the replacement.
- **Direct MCP tool names are resolved against the pi-mcp-adapter 2.18.0 contract again.** The duplicated cache-hash identity now includes `socket`, the validated/interpolated `url`, and `includeTools`, and honours `!`/`!!` and `{env:VAR}` interpolation, so adapter-written cache entries validate instead of missing every lookup and dropping `mcp:` tools from the child `--tools` allowlist. Name selection also matches the adapter: disabled servers are skipped, per-server `toolPrefix` (including the `mcp` mode) is applied, dotted tool names are sanitized, `includeTools`/`excludeTools` match exactly or by glob across all adapter candidate names, and resource tools are named `read_<resource>`. Missing, stale, and malformed cache entries still fail closed per server.

## [0.45.2] - 2026-08-06

### Fixed

- **Scoped no-edit wording no longer disables the completion guard for real implementation work.** Phrases such as “no edits needed to tests” now remain scoped to their target instead of suppressing mutation checks for the whole dispatch.
- **Timeout-killed async chain steps can no longer bind garbage output or continue as successful.** Both sequential and parallel paths trust the durable `timed_out` state rather than the interrupt path's zero exit code; paused completions also render as paused instead of failed.
- **Fresh async children now receive the same context-file isolation as foreground children.** `--no-context-files` is threaded through detached sequential, parallel, and dynamic steps, while forked and resumed-lineage children keep their inherited context.
- **Named output bindings now stay usable when a declared output file is missing.** Foreground chains report the condition through the nonfatal `outputSaveError` channel, matching async binding behavior instead of mutating the step's hard error.
- **Parked acceptance gates are rejected instead of silently ignored.** The dead `gate` schema surface was removed and semantic validation catches permissive-schema callers with a clear M13.1-revert error.
- **Child diagnostics are bounded and crash-safe.** Foreground and background stderr retention now keeps a UTF-8-safe 64 KB tail with a 32 MB runaway cap, and JSONL writers handle asynchronous stream errors instead of crashing the host process.
- **Reloads and no-worktree parallel runs no longer leak or duplicate runtime state.** Fanout-child polling has explicit `session_start`/`session_shutdown` ownership; overlapping reloads hand off delivered-but-unwritten results and completed request IDs so result-write or unlink failures cannot redeliver controls. Progress plus parallel output artifacts use dedicated chain directories rather than the real checkout.
- **Async result delivery is retryable without deleting in-flight work.** Result files are guarded while delivery awaits acknowledgement, transient failures reschedule automatically, and repeatedly malformed JSON is quarantined after bounded retries.
- **Async resume validates persisted session files at the trust boundary without breaking completed forked runs.** Resume requires an absolute regular non-symlink `.jsonl`, canonicalizes it, and confines it exclusively to parent-authored launch-time roots and files; resume-time configuration and current-parent roots cannot expand trust. Persisted launch trust keeps real fork-context and ephemeral-parent sessions revivable without broadening trust. Runs created before 0.45.2 have no launch-time trust manifest and therefore fail closed instead of being revivable after upgrade.
- **Relative output paths cannot escape their declared base.** Lexical `..`, existing symlink ancestors, and dangling output symlinks are rejected for single, sequential, static-parallel, and dynamic-parallel outputs; documented absolute output paths remain an explicit opt-in. Async static and dynamic fanout check canonical namespaces before creating missing item directories and revalidate afterward. Worktree namespaces are materialized only after checkout, and every originally relative worktree output target is then revalidated before a child launches; unrelated child-CWD symlinks remain harmless.
- **The async integration suite no longer self-skips under `node --test`.** Jiti discovery now bypasses package export maps with a bounded `node_modules` ancestry walk, and the mock Pi harness resolves task arguments correctly when flags follow the positional task.

### Tests

- Added regressions for all post-0.45.1 BLOCKER and SHOULD-FIX findings plus the final fork-resume, reload-handoff, and static/dynamic/worktree-output fix-back cases. Final gates: 1,375 unit tests passed with 4 intentional skips; 464 integration tests passed with only the opt-in live-model smoke test skipped.

## [0.45.1] - 2026-08-05

### Fixed

- **Fresh-context children now actually get `--no-context-files`, matching what the README always claimed.** `skipContextFiles` was only ever set from `inlineReads === true` in chain paths, and nothing in the codebase set `inlineReads`, so fresh workers silently inherited the parent's `AGENTS.md`/`CLAUDE.md` (verified empirically: fresh children quoted global context verbatim). `shouldSkipContextFiles()` (`src/shared/fork-context.ts`) now derives the flag from the resolved `fresh`/`fork`/`lineage` context and is wired through single, parallel, and chain (sequential + parallel-step) dispatch paths; forked and lineage children keep inheriting context normally since they continue a real parent session. Async/background dispatch is unaffected by this fix (tracked separately). Regression coverage added at the `shouldSkipContextFiles` boundary, the `buildPiArgs` CLI-arg boundary, and via updated integration fixtures.
- **The no-edits completion guard no longer false-positives on read-only diagnostic dispatches phrased as negated edits.** A worker dispatched with a task like "edit nothing, quote a sentence from your context" completed correctly but was reported failed, because `EXPLICIT_NO_EDIT_PATTERNS` only recognized "do not edit"-style wording, not phrasing like "edit nothing", "make no edits", or "without making any changes". `src/runs/shared/completion-guard.ts` now recognizes these additional negated-mutation phrasings so equivalent read-only probes are no longer misreported as failed implementation runs.
- **Async dispatch no longer wedges for the rest of a session once the resolved `jiti` CLI path is deleted out from under it.** `resolveJitiCliPath`'s local→pi-bundled probe ladder was correct, but its result was cached once at module load and reused for the process's whole lifetime; if a session resolved to a local `node_modules/jiti` early and that package was later removed (observed repeatedly: a stray `node_modules/.cache/jiti` was left behind with no installed package), every subsequent async spawn used the stale path and failed with `Cannot find module '.../jiti-cli.mjs'`, even though the pi-bundled fallback was still resolvable. `isAsyncAvailable()` and `spawnRunner()` now call a `getJitiCliPath()` getter that re-validates the cached path's existence on every call and re-runs the full probe ladder on a miss, so async recovers within the same session instead of only across a process restart.
- **Integration suite no longer flakes on the `namespaces inherited default outputs` tests.** The long-standing "fanout ordering race" was misdiagnosed as nondeterministic index-directory assignment; the runtime was already deterministic. The real cause was in the test harness: `mock-pi` handed out queued responses first-come, so two concurrently running parallel children could swap responses and a test asserting on `parallel-N/0-*` would read its sibling's output. `MockPiResponse` now accepts `taskIncludes`, which reserves a response for a child whose rendered task text contains that substring; responses without it keep the previous first-come behaviour, so no existing test changes meaning. Reproduced in 2 of 22 pre-fix full-suite runs and 0 of 12 post-fix runs. Test-only change; no runtime behaviour is affected.
- **`SelectList.setFilter` now exists in the pi-tui test shim.** It was declared in `test/support/shims/pi-tui.d.ts` but missing from `test/support/ts-loader.mjs`, so any call would typecheck and then fail at test runtime. The implementation matches the installed component exactly — prefix match on `item.value`, selection reset to `0`, no `onSelectionChange` — and `SelectList` now reads selection, navigation, clamping and rendering through `filteredItems` like the real class. Auditing the whole shim against the installed `pi-tui` dist also surfaced `SettingsList.updateValue`, which is public on the real component but was undeclared and unimplemented here; it is now both.

### Added

- **`test/unit/pi-tui-shim-surface.test.ts`** exercises every member declared in the pi-tui shim behaviourally rather than by existence, so the next declared-but-missing method fails in one obvious place instead of hiding until a UI test calls it. Two deliberate simplifications are asserted rather than silently tolerated: the shim's `wrapTextWithAnsi` chunks by width where the real utility wraps on word boundaries, and `Text` accepts but ignores its padding arguments.
- **`test/unit/mock-pi-response-routing.test.ts`** covers keyed response routing directly: a keyed response reaches its own task regardless of which child starts first, and a non-matching task falls through to an unkeyed response instead of consuming a reserved one.

### Changed

- **`/multireview` (renamed from `/mesh-review`) dispatches via model lanes instead of hard-coded model IDs.** The prompt no longer names specific models (`openai-codex/gpt-5.5`, `deepseek/deepseek-v4-pro`, `minimax/MiniMax-M2.7-highspeed`), none of which still resolve against the configured providers. It now maps review angles to `subagents.modelLanes.reviewer` lane names (`deep` correctness + synthesis, `standard` depth, `grok-fast` simplicity) and instructs the orchestrator to fall back to a remaining lane when one is missing or unresolvable. Lane names are the stable interface; the models behind them are maintained in one place in settings, so a provider rename or retirement no longer breaks the workflow until someone updates the lane. Inline `model:` overrides remain available for deliberate one-off experiments. The prompt file was renamed `prompts/mesh-review.md` → `prompts/multireview.md`, so the slash command is now `/multireview`.

- **`/multirecon` (renamed from `/mesh-recon`) dispatches via model lanes instead of hard-coded model IDs.** The prompt no longer names specific models (`minimax/MiniMax-M2.7-highspeed`, `zai/glm-5.1`, `mimo/mimo-v2.5-pro`, `openai-codex/gpt-5.5`), none of which still resolve against the configured providers. Simple mode now maps the three recon angles (external evidence, local code, practical tradeoffs) to `subagents.modelLanes.recon` lane names (`sonnet`, `luna`, `m3`); deep mode maps its lanes (`luna`, `sonnet`, `haiku`, `m3`) and runs the synthesis step on the `reviewer` role's strongest lane (`deep`), matching multireview: fusing research briefs is a reasoning task, not a research task. Both modes carry the same fallback rule — missing or unresolvable lane → nearest remaining lane, called out in the summary. The prompt file was renamed `prompts/mesh-recon.md` → `prompts/multirecon.md`, so the slash command is now `/multirecon`.
## [0.45.0] - 2026-07-31

### Fixed

- **The `tasks[].lane` tool-schema description no longer advertises a hardcoded lane name.** It previously read `(for example 'easy' or 'hard')`, but lane names are user-configured in `subagents.modelLanes` and resolve per-agent, so a shipped literal is wrong on any host that renamed its lanes. Because `resolveModelLaneOverrides` throws `Unknown model lane '<name>' for agent '<agent>'` with no fallback, a model following the schema's own example could hard-fail the dispatch. The description now matches its three siblings, which never carried examples.

### Added

- **Interactive lane editor in `/subagents` (M2.2).** Pressing `l` from the main agent list opens a lane overlay for the selected role with a non-searchable `SelectList` of project and user lanes. The lane list supports `enter` for details, `n` for a new lane (name → model flow), `d` for delete with a Cancel-defaulted confirmation, `u` for an LIFO lane undo, and `esc` to return to the agent list. The lane detail view exposes `m` (model), `t` (thinking — shows only levels the current lane model supports plus `inherit`), and `r` (rename). Nested views keep `enter`, `esc`, and `ctrl+c` semantics; `ctrl+c` discards every staged lane change and override. Project lanes are labeled `effective · read-only` and show no mutation keys; a user lane shadowed by a same-named project lane is labeled `shadowed by project` and stays editable and deletable. The lane undo stack is separate from the existing override-reset undo.
- **Atomic, merge-preserving user-lane store (M2.1).** `src/agents/model-lanes.ts` now exports `applyUserModelLaneMutations(mutations)` for batched user-scope lane edits, alongside `MODEL_LANE_NAME_PATTERN` (`/^[a-z0-9][a-z0-9-]*$/`), `isValidModelLaneName`, and the `UserModelLaneMutation` (`upsert`/`remove`) union. The function reads the existing settings file once, validates the current `subagents.modelLanes` shape with the same parser reads use, applies every mutation to a raw in-memory copy, and writes once via `writeSettingsFile` (now exported from `src/agents/agents.ts`). The target path is resolved internally, so no caller can direct a lane write at project scope. Root fields, sibling `subagents` fields (including `agentOverrides`), sibling roles/lanes, and unrelated properties on a targeted lane are preserved. A malformed file is rejected without being overwritten.
- **Slash command reads user and project lanes, persists staged mutations once (M2.3).** `/subagents` reads user lanes from `getUserAgentSettingsPath()` and project lanes from `getProjectAgentSettingsPath(cwd)` before opening the overlay; if either read fails the overlay does not open and the offending path is named. After the overlay returns, lane mutations are applied once, user-scope only, through the store inside the existing persistence `try/catch`. The store re-reads settings at save time so unrelated edits made while the overlay was open are merged rather than replaced. `/subagents config`, `/subagents json`, and `/subagents edit` still short-circuit and seed the JSON fallback before any TUI lane reads.

### Changed

- **`MODEL_LANES_SKELETON` seeds `worker: { normal, hard }` instead of `worker: { easy, medium, hard }`.** The two-lane shape matches the current convention. Starter model IDs are unchanged: the former `medium` model becomes `normal` and `hard` is untouched, so the seed still assumes no provider auth beyond what it already did. Only affects fresh installs with no `subagents.modelLanes` at all; existing configs are never overwritten.

### Documentation

- **Lane editor added to README, the bundled `pi-subagents` skill, and the architecture index.** README: new `Model lanes and the /subagents lane editor` section under "Configuring agents" with the key map, project/user scope display, shadow labels, supported-thinking filtering, and the JSON fallback; the Configuration reference now lists `subagents.modelLanes` alongside the extension's separate `config.json`. SKILL: orchestrating models are told lane management is interactive via `/subagents`, the JSON fallback remains, and existing `worker.normal` / `worker.hard` examples are unchanged. ARCHITECTURE: directory map and the "Where do I change X?" index identify `model-lanes.ts` as read + write ownership, `subagent-hub.ts` as staged UI, and `slash-commands.ts` as the user + project lane read and deferred persistence.
### Tests
- **Lane-store unit coverage.** `test/unit/model-lanes.test.ts` covers parse/resolve/project-vs-user precedence, legacy free-form lane names, invalid-shape errors with agent/lane/file context, the `applyUserModelLaneMutations` batch (atomicity on the first failing mutation, rename-with-original-name semantics, preservation of unrelated root / `subagents` / lane properties), and the `modelLanes.<agent>.<lane>` shape contract the store relies on.
- **`/subagents config` seed coverage.** `test/unit/subagents-config.test.ts` proves `seedModelLanesIfMissing` seeds `worker.normal`/`worker.hard` only when the file is absent or `subagents.modelLanes` is missing, preserves unrelated `subagents` keys (e.g. existing `agentOverrides`), and is a no-op (`changed: false`) once a map is already present.
- **Lane-overlay unit + integration coverage.** `test/unit/subagent-hub.test.ts` exercises staged lane editing against `subagent-hub.ts` directly (create / rename / model / thinking / delete / undo drafts, supported-thinking filtering, project-row read-only behavior, `shadowed by project` labels, `ctrl+c` discard, main-list `esc` apply). `test/integration/subagent-hub.test.ts` drives the same flows through real key sequences on the actual TUI component.

## [0.44.2] - 2026-07-28

> Async OM outbox reconciliation is now idempotent when concurrent cleanup wins the unlink race.

### Fixed

- **Concurrent async OM outbox cleanup no longer emits false reconciliation failures.** After a receipt has been validated, an `ENOENT` from `unlinkSync` is treated as an already-completed prune. All other filesystem errors still follow the existing log-and-retain path for retry.

### Tests

- Added regressions proving concurrent `ENOENT` cleanup is recorded as pruned while non-`ENOENT` failures such as `EACCES` remain reported and retained.

## [0.44.1] - 2026-07-24

> The run wall-clock deadline now warns before it kills, and honours `timeoutAction` like the inactivity deadline always has.

### Added

- **Pre-deadline wrap-up nudge.** Under `escalate_then_kill` (the default) a `timed_out_escalating` control event now fires one `escalationGraceMs` *before* the run wall-clock deadline, naming the remaining time. A parent watching an async run can spend that window on `wrap-up` and keep the child's work, instead of receiving a corpse at the deadline. The nudge is emitted against every live step and latched, so it fires once per run.

### Changed

- **`timeoutAction` governs the run wall-clock deadline, not just step inactivity.** Its documented contract said "action on timeout" while the run deadline killed unconditionally. Now `notify` makes that deadline advisory — nothing is killed, queued work still dispatches, model fallback still proceeds, and a single `needs_attention` notice reports the overrun. **This removes the run-duration backstop entirely; stop such a run with the `interrupt` action.** `auto_kill` and `escalate_then_kill` continue to enforce it.
- **`timed_out_escalating` is now notified by default.** `control.notifyOn` defaults to `active_long_running`, `needs_attention`, and `timed_out_escalating`. Without this the new nudge would be filtered out before reaching anyone. Terminal `timed_out`/`timeout_killed` remain off by default — by then the outcome is already in the run result.

### Notes

- The deadline itself remains a **synchronous** hard stop: queued steps, parallel siblings, and model-fallback attempts are still refused the moment it fires. Warning *before* the deadline was chosen over a grace period *after* it precisely to preserve that — a post-deadline grace window would leave children running against a run already marked `failed`.
- Where no child is in flight (run entry, and between model-fallback attempts) there is nothing to wrap up, so those paths only distinguish enforce (`auto_kill`, `escalate_then_kill`) from don't (`notify`).
## [0.44.0] - 2026-07-24

> Pi-style revamp of the `/subagents` model-configuration overlay, built against the documented `pi-tui` API: a stabilized component tree, fuzzy model search, a dedicated thinking-level view, display polish, and safe reversible resets.

### Added

- **Fuzzy model search.** The model picker filters with pi-tui's `fuzzyFilter` (subsequence matching across `provider id fullId`) instead of substring `includes`, keeps deterministic source order on an empty query, and preserves selection by `fullId` as results change.
- **Thinking settings view.** `tab` opens a `SettingsList`-backed view to set a thinking level per agent. Unset/invalid levels resolve to a legal supported value, edits are dirty-tracked, and the model is pinned only when the agent already has one configured.
- **Safe reversible resets.** `X` opens a confirmation dialog (defaulting to Cancel) that stages removal of every persisted override; `x` resets a single agent; `u` undoes the most recent reset transaction (LIFO), restoring the exact pre-reset snapshot.

### Changed

- **Stable component tree.** The hub runs on a discriminated `HubView` state and rebuilds its `SelectList`s only on real data/theme/filter/view transitions (pi-tui's `SelectList` has no `setItems`), preserving selection by agent/model identity; plain up/down navigation no longer rebuilds.
- **Display polish.** Header reports `<n> agents · <m> modified`; rows carry `●` persisted / `✎` edited / `↺` reset markers with a footer legend; unset thinking renders dim `inherit` (distinct from `off`); the model picker annotates supported thinking levels and the active one; the empty-query model list sorts by provider with the preferred provider first.

### Fixed

- **Pure result builder.** `buildDirtyResult` returns a pruned copy of the reset set instead of mutating live state.
- **Type-safe thinking handling.** Replaced six `as ThinkingLevel` casts with an `isThinkingLevel` type guard.
- **Reset no-ops.** `x` is a no-op when the agent is already staged for reset; `X` is a no-op when no agent has a persisted override (no pointless "Reset 0" dialog).

## [0.43.2] - 2026-07-23

> Folds in the unreleased 0.43.1 bump (M12.4 review hardening) plus the subagent-hub override fixes.

### Fixed

- **Atomic settings writes.** `writeSettingsFile` now writes to a temp file and renames into place (with a Windows `EEXIST` remove-then-rename fallback), so a crash mid-write can no longer leave `settings.json` truncated or half-written.
- **Override merge instead of clobber.** `saveBuiltinAgentOverride` merges into the existing entry rather than replacing it, so saving a model/thinking override no longer wipes unrelated fields (`tools`, `skills`, `fallbackModels`, `memory`).
- **Surgical reset.** `removeBuiltinAgentOverride` strips only `model`/`thinking` keys and preserves the rest of the entry, deleting it only when empty.
- **Overrides apply to custom agents.** Settings overrides now reach user/project agents via `applySettingsOverridesToAgents`, not just builtins. Agents shadowing a builtin name are skipped to preserve the shadowing contract.
- **Scope-aware hub save.** The `/subagent models` hub saves to the scope that currently owns an override (project vs user) instead of always writing user scope, and wraps the save loop in try/catch with an error notification.
- **Hub dirty tracking.** The hub only persists agents the user actually changed (model pick or thinking cycle), so a no-op open+esc no longer rewrites every agent's override. Adds `x` to reset a single agent and reports `resetAgents` in the result.
- **Thinking seed + display.** The hub seeds `off` thinking correctly, shows `(host default)` for model-less agents, displays fallback counts, and uses the shared `splitKnownThinkingSuffix` (now exported from `model-info`).
- **Model search paste.** The hub search box accepts multi-character paste, not just single keystrokes.

### Hardened (M12.4)

- **Async config file modes.** Async config is written `0o600` and the `TEMP_ROOT` dir is `0o700`, matching the run-handle-store pattern to prevent token exposure on shared `/tmp`.
- **Recover state truthfulness.** The `recover` action derives run state via `inspectRun` (status.json / nested summary / in-memory) instead of hardcoding `state: live`, so completed runs are no longer reported as live and steerable.
- **Non-null assertion sweep.** Replaced all 24 `!.` dot-access sites with explicit narrowing.

## [0.43.0] - 2026-07-22

### Added — M12: Live run handles

Stable cross-process control and inspection of subagent runs while they are still live, plus durable recovery after an extension reload or parent crash.

- **Acknowledged live-control transport (M12.1).** A durable file-based route delivers `steer`, `follow-up`, and `wrap-up` control text from the parent to a live child Pi process. The child owns acknowledgement and reports the actual durable disposition — `accepted-by-pi` with `started-turn` / `queued-steer` / `queued-follow-up`, `rejected`, `submitted`, or `outcome-unknown` — never claiming the model acted, only that Pi accepted or queued the message. Owner epochs and monotonic per-owner sequences enforce FIFO with durable out-of-sequence and duplicate rejection; `requestId` idempotency reuses the original durable result instead of delivering twice. The post-send/pre-ack crash window is surfaced honestly as `outcome-unknown` and never blindly replayed.
- **Live-control actions on the subagent tool (M12.2).** `steer`, `follow-up`, and `wrap-up` are now first-class `subagent` actions. Target a run by `id` (unambiguous prefix works); parallel and chain runs require `index` to pick the exact child. `wrap-up` rides the steer path with a canonical directive rather than adding a wire-protocol kind. `steer` is never silently downgraded to `follow-up`.
- **Run-handle recovery, attach/detach, and compact inspection (M12.3).** Every foreground and async launch records a durable `RunHandleRecord` (fsynced, owner-only `0700`/`0600`) under `TEMP_ROOT_DIR/run-handles/`, deleted on completion/cleanup. After an extension reload, `recover` finds a run by id again; `inspect` returns a compact state summary for any live or completed run; `attach` verifies live-control capability (owner epoch + capability token) and distinguishes steering-capable from inspection-only; `detach` revokes an attachment idempotently. Foreground runs are only resolvable while in-memory (PID liveness is useless after reload — `process.pid` is the host) and `recover` reports this honestly. Nested descendants are rediscovered via their parent's route and the durable nested registry, not recorded as separate handles.

### Documentation

- README: new "Live run control: steer, follow-up, wrap-up" and "Recovery and inspection" sections; action parameter table extended with `recover`, `inspect`, `attach`, `detach`, and `attachmentId`.
- AGENTS: durable live-control disposition invariant; foreground non-recoverability after extension reload; run-handle and attachment persistence layer note.
- ROADMAP: M12 moved from Planned to Released.

### Tests

- M12.1: 129 focused unit/integration tests covering route versioning, owner/session epoch publication, monotonic sequencing, duplicate/gap rejection, same-live-epoch parent restart, stale-epoch child restart, directory/file permissions, malformed/oversized/wrong-capability input, idle-child delivery, internal protocol reprojection, foreground/async integration, FIFO/duplicate/out-of-sequence rejection, child epoch rotation, interrupt/abort, shutdown terminalization, and post-send/pre-ack ambiguity.
- M12.2: 25 unit + 5 integration tests covering steer/follow-up/wrap-up across foreground/async/nested, honest disposition reporting, duplicate requestId reuse, child exit mid-request, and post-send/pre-ack ambiguity.
- M12.3: 34 unit (store) + 24 unit (inspection) + 7 integration tests covering recover/inspect/attach/detach across foreground/async/nested, recovery across parent restart, live vs completed inspection, handle recorded at launch and deleted at completion, and legacy action smoke.

## [0.42.2] - 2026-07-20

### Fixed

- **Chain-default clarify precedence restored against asyncByDefault.** When `asyncByDefault: true` is configured, chain runs now require explicit `clarify: false` to enter background mode. Previously an implicit or inherited `asyncByDefault` could silently bypass the chain-default clarification flow, skipping the preview/edit TUI for chain workflows. Single and top-level parallel calls retain their existing rule (`clarify !== true` decides background).
- **Executor-level truth-table regression.** Added nine executor-routing cases covering chain, single, and top-level parallel calls across omitted/explicit `async` and `clarify`, config-supplied `asyncByDefault: true`, and chains containing parallel groups.

### Tests

- Added executor-level regressions for chain-default clarify precedence, config-supplied async defaults, unchanged single/top-level-parallel routing, and chain parallel-group behavior.
- Made detached background cases await their result files so late mock calls cannot leak into later integration tests.

### Documentation

- Replaced stale `pi install npm:pi-subagents` with GitHub-based installation (`pi install git:github.com/DarkoKuzmanovic/pi-subagents`) plus an optional immutable tag-pin example.
- Restructured README for progressive disclosure: quick start first, core concepts and common workflows next, advanced orchestration and reference later. Consolidated `pi-intercom` and web research under optional companions while retaining their valid npm installation commands.
- Added M11 to ROADMAP Released and marked the v0.42.2 design plan implemented.

## [0.42.1] - 2026-07-19

### Changed

- Tightened the bundled recon protocol for reliable artifact-first handoffs, added planner blast-radius and safety attributes, taught reviewers to consult captured quality-gate records, and clarified that Crew owns orchestration policy while the `pi-subagents` skill supplies mechanics.

### Fixed

- **The raw hard-cap backstop no longer false-kills fully-parsed JSON streams.** It measured *total* raw stdout bytes, so a production GLM run whose `--mode json` snapshot re-serialization amplified ~8 MB of real accounted content into 1,024 MB of cumulative raw bytes (121x amplification) was aborted even though every byte had been successfully parsed and credited. The backstop now measures *cumulative unaccounted (unparsed)* raw bytes (`rawBytes - creditedRawBytes`) instead, so fully-parsed amplified streams never count toward it while genuinely unaccounted raw floods—including unparsed bursts that repeatedly reset the rolling no-progress window—still trip it. The 1 GiB default threshold is unchanged; only what it measures changed.

- **Background run wall-clock deadlines now stop every dispatch path.** A distinct terminal timeout latch synchronously gates later chain steps, queued parallel items, and intra-step fallback-model retries at the absolute deadline instead of relying on the 1-second monitor tick. Running and pending work is recorded as failed, dynamic collection and downstream dispatch stop, explicit user interrupts remain paused, and timeout-killed children can no longer be rewritten or emitted as complete through the interrupt path's raw exit code `0`.
- **Background fallback metadata now matches foreground semantics.** `attemptedModels` strips known effective-thinking suffixes while the final `model` retains the suffix actually dispatched, keeping fallback history stable without losing the effective model identity.

### Tests

- Added a regression reproducing the captured GLM 121x/1 GiB false kill (survives now). Added focused coverage for the cumulative-unaccounted boundary (exactly-at survives, one byte over trips) and for repeated sub-threshold unparsed bursts separated by credited progress eventually tripping the cumulative cap.
- Added real detached-runner regressions that finish a child after a 300 ms run deadline but before the 1-second watchdog tick, proving synchronous cutoff for sequential, queued-parallel, and fallback-model dispatch. The tests also pin failed status/result/event semantics and the unsuffixed `attemptedModels` contract.

### Documentation

- Clarified the stream-budget guard comments and README to describe the raw hard cap as bounding cumulative unaccounted/unparsed raw bytes, not total raw stream volume.

## [0.42.0] - 2026-07-14

### Fixed

- **Snapshot amplification no longer false-kills coherent reasoning.** The no-progress watchdog's raw-byte trip was measuring a streaming artifact: pi's `--mode json` re-serializes the full growing message on every delta, so a fine-grained streamer inflates ~25 KB of real thought into tens of MB of raw stdout (~1,100x measured on captured tencent/hy3, umans-glm-5.2 and deepseek-v4-flash runs). Cheaper models that stream ~6-char deltas were aborted mid-review while capable models with coarser deltas ran clean on identical work. The primary no-progress guard now trips on **delta-aware accounted output** (8 MB since the last text/tool activity), which measures what the model actually generated. Every successfully-parsed event credits its raw footprint back to a separate **non-JSON stdout backstop** (lowered to 32 MB), so amplified JSON streams never reach it and it fires only on genuine non-JSON floods. Verbatim loops (degenerate-loop detector) and the 200 MB / 1 GB hard caps are unchanged.

### Tests

- Added unit coverage for the delta-aware accounted no-progress trip, the parsed-byte crediting mechanism (fully-parsed streams never reach the non-JSON backstop; unparsed stdout still does), and a regression reproducing the captured micro-delta false positive (survives now, aborted under the old 30 MB raw rule). Recalibrated the end-to-end runaway integration test to cross the accounted no-progress trip.

### Documentation

- Rewrote the stream-budget guard documentation and README to describe the delta-aware primary trip and the credited non-JSON backstop.

## [0.41.1] - 2026-07-13

### Fixed

- Completed single-pass chain template rendering across foreground parallel, dynamic-fanout, and detached async paths so substituted output and item values cannot trigger a later template expansion.
- Clarification-selected thinking levels now override prior effective thinking values, including `off`.
- Explicit async interrupts can resolve a persisted running async run after in-memory tracker reset.
- Timeout escalation notices now show the configured grace period and accurately report when no child intercom route exists.
- Legacy extension configuration ignores malformed optional fields instead of passing invalid values into dispatch paths.

### Tests

- Added regressions for Clarify thinking override and timeout-notice accuracy, plus retained call-path coverage for template integrity.

### Documentation

- Marked tracked historical progress and TODO records as non-active context.

## [0.41.0] - 2026-07-12

### Fixed

- **Later-turn thinking floods are bounded again.** The 30 MB no-progress watchdog now measures raw bytes since the most recent *current* text/tool event instead of permanently disabling itself after the first successful turn. Streaming updates inspect their delta rather than stale full-message snapshot content. Size-triggered errors now report raw bytes, delta-aware accounted bytes, amplification ratio, and bytes since meaningful progress.
- **Foreground wall-clock limits are run-wide.** Single retries, top-level parallel siblings, queued work, and chain steps now share one `control.runWallClockTimeoutMs` deadline, matching detached/background semantics even while active children continue emitting events. Queued children are not launched after that deadline.
- **`maxOutput` now matches its public contract.** The tool schema exposes `bytes`/`lines` as post-run inline-result truncation, and documentation explicitly distinguishes it from model-generation, per-child token, and runtime limits.
- **Interrupted children are no longer reported as `complete`.** Aborted/interrupted runs keep their real status across `status.json`, lifecycle events (no `subagent.step.completed` is emitted for a paused child), and run state, guarded on a run-level `interrupted` flag in both the parallel and sequential completion paths.
- **Budget accounting no longer corrupts the sequential baseline.** A dedicated step-token ledger separates the sequential baseline (steps sharing the root session file) from the display total (parallel tasks and standalone steps with their own session files), so parallel tasks can't distort the running total and standalone steps keep it stable.
- **Runaway kills have a SIGKILL backstop.** The runaway path escalates SIGINT -> SIGTERM -> SIGKILL (after `HARD_KILL_MS`), matching the final-drain escalation, so a child ignoring SIGTERM cannot linger.
- **The loop detector only aborts high-confidence loops.** A normalized-periodic tail is confirmed against the *raw* tail before tripping: verbatim/cycling loops (which repeat a bounded raw fragment) trip early, while a raw-aperiodic-but-normalized-periodic stream — a real incrementing table *or* a value-incrementing loop, provably indistinguishable by both shape *and* volume — is never killed by the detector and is bounded by the accounted hard cap instead. Real incrementing CSVs/tables of any size are no longer aborted.
- **Accounted-byte hard-cap is byte-accurate.** The clamp uses UTF-8 `Buffer.byteLength` instead of UTF-16 `String.length`, so multibyte deltas are not undercounted.
- **Model fallback engages on watchdog aborts.** `runaway output aborted:` and MiniMax's terminal `input_tokens` usage-stream error are treated as retryable on a *different* configured model; unrelated child TypeErrors remain ordinary task failures.
- **Chain template tokens can no longer inject each other.** The foreground sequential path renders `{outputs.X}` and `{previous}`/`{task}`/`{chain_dir}` in a single left-to-right pass, so neither an output's text nor a `{previous}` value can expand the other's tokens (both injection directions are closed). Output-reference matching also excludes `{` from the name class so malformed templates render in linear (not quadratic) time.
- **A malformed MCP server entry no longer drops every direct tool.** Null/non-object server definitions are skipped during direct-tool resolution instead of crashing into the catch-all that returned `[]`.
- **Stricter config validation.** `expand.onEmpty` must be `skip`/`fail` (a typo previously fell through to `skip`), non-string JSON pointers raise a `DynamicFanoutError` instead of a raw `TypeError`, and a blank/whitespace lane `model` is rejected rather than dispatched as a model name.
- **Degraded OM outbox writes are surfaced.** A non-committed (degraded) completion-outbox write now warns instead of being dropped silently; delivery semantics are unchanged.

### Tests

- Added unit and foreground integration regressions for progress followed by a later thinking-only flood, stale snapshot text, rolling progress resets, amplification diagnostics, single-child wall-clock termination, shared top-level/chain parallel deadlines, and `maxOutput` schema semantics.
- Added unit regressions for the loop-detector table false-positive, step-token ledger domains, model-fallback runaway/usage-crash retryability, `{outputs.X}` injection ordering, `expand.onEmpty`/JSON-pointer validation, and blank lane-model rejection.

## [0.40.1] - 2026-07-10

### Added

- **Pi 0.80.6 `max` thinking-level support.** Single, parallel, and chain dispatch schemas now accept `thinking: "max"`; child model suffix normalization, model-prompt role matching, model capability filtering, and clarification selectors handle `max` end to end. Like Pi core, `max` remains opt-in and appears only when a model's `thinkingLevelMap.max` is defined.

### Tests

- Added regression coverage for `max` schema exposure, suffix stripping, exact model-prompt matching, capability filtering, and selector visibility while preserving legacy `xhigh` fallback behavior.

## [0.40.0] - 2026-07-09

### Added

- **Dynamic fanout (`expand`/`collect`) now runs in async/background chains.** The v0.39.0 "foreground only" restriction is lifted. When a background chain reaches a dynamic-fanout step, the detached runner materializes the per-item tasks at runtime from the prior step's structured array, splices runtime flat-index slots into the status/session/escalation/intercom bookkeeping so downstream steps stay aligned, runs the items through the standard parallel executor, and collects them into `{outputs.<collect.as>}` for later steps. Verified end-to-end through the mock-`pi` runner harness (happy path + `onEmpty: skip`), including the downstream `{outputs}` consumer. Two async-only caveats: materialized items run without per-item session files or intercom targets (no individual resume/share/contact), so a `context: "fork"` dynamic template does not fork per item in the background.
- **`subagent.fanout.materialized` event** is appended to an async run's `events.jsonl` when a dynamic step expands, recording the collect name and item count.
- **Output-token budget ceilings for subagent runs.** Configure a JSON default with `sessionTokenBudget` or pass a per-call `budget` override. The budget counts child output tokens only, gates dispatch before launching the next chain/background step, marks remaining logical steps as `budget-exhausted`, preserves already-launched parallel children, reports overshoot, emits `subagent:budget-exhausted`, and appends a `[budget: spent/limit output tokens]` footer.

### Changed

- **Async chains containing a dynamic-fanout step are no longer rejected.** This supersedes the v0.39.0 guard and its "run this chain in the foreground" error. The runner defers the dynamic step's flat-slot allocation (a new `RunnerDynamicStep` carries a pre-resolved per-item template with a task sentinel) and splices materialized slots in at runtime.
- **Builtin `context-builder` role is renamed to `recon`.** The six-role roster now uses `recon`, `planner`, `worker`, `reviewer`, `oracle`, and `janitor`; compatibility agents remain disabled unless explicitly re-enabled.
- **Completed release-plan notes are archived under `docs/plans/`.** Stale 0.38/0.40/structured-output planning files moved out of the project root, and transient recon audit artifacts were removed.

### Fixed

- **Runaway child streams are now caught by shape, not just size.** The child `--mode json` stream watchdog gained a degenerate-loop detector and delta-aware accounting, fixing two failure modes seen in production:
  - **Degenerate streaming loops** (e.g. a model repeating the trailing key-value pair of a tool call's JSON arguments forever — `, "timeout": 60000, "timeout": 60000, ...` — and never closing the object) are detected within seconds via a periodic-suffix scan over the normalized per-content-block delta tail, and aborted with a precise error naming the repeated fragment. Previously such loops ran ~4.5 min until they hit the 200 MB byte cap and failed with a generic message. The detector is chunking- and value-cycle-tolerant (normalizes numeric literals and whitespace) and tracks each content block independently, so loops that interleave concurrent tool calls are still caught.
  - **False-positive kills of verbose-but-honest runs.** The 200 MB hard cap counted raw stdout bytes, but `message_update` events re-serialize the entire partial message on every delta, so stdout grows quadratically with message length — heavy honest runs were killed purely by snapshot amplification. The hard cap now counts delta-aware accounted bytes (delta payload + envelope overhead for streaming updates, full size otherwise), keeping it proportional to generated content. A 1 GB raw-byte backstop still bounds any flood shape, and the 30 MB no-progress (thinking-loop) guard is unchanged. Validated by replaying 18 captured production streams: both real loops trip early; all 16 honest runs stay well under cap (≤18 MB accounted).

- **Async dynamic-fanout parity with the foreground path** (from code review of the async fanout feature):
  - Read-only progress suppression is now recomputed against each resolved per-item task at materialization, matching the foreground path. Previously it was computed against the internal task sentinel, so async fanout emitted progress instructions for read-only per-item tasks that the foreground suppressed.
  - Parallel-group status bookkeeping is corrected after a runtime fanout splice: the `start` of every trailing pre-recorded parallel group is rebased by the materialized item count, and the fanout group is recorded at the dynamic step's logical index. This fixes mislabeled `step N/M` progress and prevents a trailing or final fanout group from being dropped from async status.
  - `parallel.lane` on a dynamic-fanout template is now resolved to a concrete `model`/`thinking` in both the foreground and async paths (previously silently ignored).
  - Dynamic materialize/collect failures (`onEmpty: "fail"`, `maxItems` exceeded, unknown/invalid source output, `collect.outputSchema` mismatch, and per-item hard failures) now set `statusPayload.error`, so an async run's `status.json` explains the failure instead of leaving the error empty. Per-item hard-failure errors name the failing item's `key`.
- **`subagent.fanout.materialized` is also emitted on the empty-source (`onEmpty: "skip"`) path** with `count: 0`, so consumers relying on it as the fanout marker still observe it. The materialize-failure event now references the dynamic step's logical index.
- **The dynamic-fanout task sentinel no longer contains NUL bytes**, so `src/runs/background/async-execution.ts` is a text file again and its diffs render normally.
- **The `expand.maxItems` tool-schema description** now names the real flat `dynamicFanoutMaxItems` config setting instead of a non-existent nested key.

- **Async parallel output files are now namespaced per child.** Relative inherited/default output paths for async static parallel and dynamic-fanout tasks resolve under per-task directories, preventing sibling children from racing on the same `context.md`/report path while preserving absolute output paths.

### Tests

- Added focused coverage for output-token budgets: accumulator unit tests, foreground fake-dispatcher enforcement, async runner result/status assertions for async-capable environments, and a local pure unit test for async skipped-step flat-index cursor behavior. Detached async integration tests still skip in local environments without `jiti`; the local gate covers those paths with typecheck plus pure helper/unit coverage.

## [0.39.0] - 2026-06-13

### Added

- **Structured output for chain steps (`outputSchema` + `{outputs.name}` references).** A chain step (sequential or a parallel task) may declare an `outputSchema` (a JSON Schema object); the child is then required to finish by calling a `structured_output` tool with a schema-valid value, and that value is captured out-of-band (temp `schema.json`/`output.json`, mode `0600`, env-passed to the child) rather than parsed from prose. Producing steps expose their result via `as: "name"`, and later steps reference it with `{outputs.name}` (substituted with compact structured JSON when present, else the step's text). Bindings are validated up front: unique safe `as` names, valid identifiers, and refs only available after the producing step. Cheap drivers that JSON-stringify the `value` argument are tolerated (parsed before validation). Works in the **foreground** and in the **async/background runner**, for chain steps (sequential steps and parallel tasks within a chain — not top-level single dispatch). Reimplemented from upstream `nicobailon/pi-subagents` (acceptance-gate and workflow-graph machinery deliberately not ported).
- **Dynamic fanout (`expand`/`collect`) for chains.** A chain step may expand an array from a prior step's structured output (`expand.from` via JSON Pointer) into N parallel subagent tasks from a single `parallel` template (item templating via `{item}`/`{item.field}`, `maxItems` caps, per-item key dedup), then `collect` the per-item results into an array exposed as `{outputs.<collect.as>}` (optionally validated against `collect.outputSchema`). Available through direct `subagent({chain:[...]})` JSON and saved `.chain.js`. Foreground only for now; a `dynamicFanoutMaxItems` config knob provides a default item cap.

### Changed

- **Async chains containing a dynamic-fanout step are rejected with a clear, actionable error** ("... not yet supported in async mode. Run this chain in the foreground ...") instead of failing obscurely. The async runner pre-bakes per-task scaffolding (session files, status slots, intercom targets, flat indices) from the static chain shape, which is incompatible with fanout's runtime-determined task count; full async dynamic fanout is tracked as a dedicated follow-up. Structured output is fully supported in async.
- **Type change (`ChainStep`):** the `ChainStep` union now includes `DynamicParallelStep` (`{ expand, parallel, collect }`). Consumers that exhaustively switch on `ChainStep`, or that cast a non-parallel step straight to `SequentialStep`, should adopt the `isDynamicParallelStep` guard to avoid mislabeling dynamic steps.

### Fixed

- **Structured output now works for subagents that declare a restricted `tools:` allowlist.** The `structured_output` tool is registered at child startup by the prompt-runtime extension, but the child's `--tools` allowlist was built only from the agent's declared builtin tools and filtered the extension tool out — so a schema-bound step on any agent with a `tools:` list (`worker`, `reviewer`, `context-builder`, `planner`, `oracle`, `janitor`) always failed with `Missing structured_output call`, in both foreground and async. `buildPiArgs` now appends `structured_output` to the allowlist whenever a schema is active; agents with no tool restriction are unaffected. Caught by live end-to-end testing.
- **`{outputs.name}` runtime resolution is total and prototype-safe.** `resolveOutputReferences` never throws on an unknown/invalid reference (it leaves the token literal, like `{previous}`/`{item}`), so an unresolved token in post-substitution text or a model-produced value can no longer crash a foreground chain or kill the detached async runner. Lookups use `Object.hasOwn`, so a reference named after an inherited `Object.prototype` member (`toString`, `constructor`, …) stays literal instead of resolving to `"undefined"`. `validateChainOutputBindings` remains the authoring-time gate.
- **Failed async steps no longer publish under their `as` name.** The async runner applies the same success predicate as the foreground path, so a non-zero exit or errored step cannot expose partial output to downstream `{outputs.name}` consumers.
- **Structured-output temp dirs are always cleaned up.** Runtime creation, the model-candidate retry loop, and the capture read are wrapped so a throw on any path removes the temp dir (foreground and async); the capture read is also bounded by a 5 MB cap.
- **Dynamic steps render correctly in the live-state TUI**, and dynamic-fanout error messages name the real flat `dynamicFanoutMaxItems` config field.

## [0.38.2] - 2026-06-12

### Added

- **`chain`/`tasks` params now tolerate JSON-stringified arrays (cheap-driver envelope defect).** Cheap drivers (Qwen Flash, Kimi-class) JSON-stringify nested tool arguments at arbitrary depth — the exact defect that hit `roux_record` and `ask_user` in production. The `subagent` tool's `chain`, `tasks`, and per-step `parallel` params are now schema-widened to accept strings, and a coercion seam (`coerceEnvelopeArrays` + `coerceJsonArrayParam`) parses stringified arrays (and stringified items inside them) back to literal form before execution, or refuses with a driver-readable corrective message naming the offending param/index.
- **Orphaned worktree residue from SIGKILL'd runs is now swept at session start.** `try/finally` cleanup never fires on SIGKILL, leaving `pi-parallel-*` branches and dangling `.git/worktrees/` records in the repo forever. A deferred, best-effort `sweepOrphanedWorktrees` now runs `git worktree prune` and deletes `pi-parallel-*` branches whose tmp worktree dir is gone (a live run always has its dir) or older than 24h. Fresh dirs and non-pi branches are never touched.

### Fixed

- **A result whose first delivery failed is no longer permanently dropped.** The result watcher marked a completion key as seen *before* emitting; if a subscriber threw, the retained result file hit the dedupe branch on retry and was unlinked without ever re-emitting. The key is now unmarked on delivery failure so retries actually re-deliver. Regression test proven failing against the old code.
- **Drain-kill stderr is preserved instead of silently dropped.** When a child delivered its clean final message but needed SIGTERM to exit (drain timeout), any stderr it produced was discarded. A bounded tail now surfaces as a non-fatal `drainWarning` on the result (rendered as a warning row), with routine pi idle chatter (`Done after N turn(s). Ready for input.`) filtered so normal drain-kills stay quiet. The run still completes successfully — stderr never becomes an error on this path.

## [0.38.1] - 2026-06-12

### Fixed

- **Transient child errors no longer fail recovered runs.** A mid-session provider blip (e.g. pi-ai's bare `terminated` errorMessage on an assistant message) used to stick in the run's `error` field even after the agent recovered, completed its task, and delivered output — reporting a fully successful run as failed (success-dressed-as-failure; reproduced in production with a parallel context-builder dispatch). Both runners (foreground `execution.ts`, background `subagent-runner.ts`) now clear a message-sourced error when a later clean assistant message supersedes it. Regression test proven against the old code.
- **`isTransportFailure`/`isRetryableModelFailure` now match pi-ai's bare `terminated` errorMessage** (anchored to the full string so control-kill prose like "process terminated after inactivity timeout" never matches). This lets output-aware finalization rescue runs whose declared output was produced before a terminated stream, and enables model-fallback retry on that failure.
- **Chain template substitution no longer corrupts tasks containing `$` patterns.** `{task}`/`{previous}`/`{chain_dir}` were substituted with plain string `String.replace`, which interprets `$&`, `` $` ``, `$'`, `$$` in the replacement value — so a previous step's output containing shell/awk/regex `$` constructs silently corrupted the next step's task. New `substituteTemplateVars` helper uses function replacements (literal semantics) everywhere.
- **`readStatus` cache now validates file size alongside mtime**, preventing stale status reads when a status file is replaced without an observable mtime change (coarse-timestamp filesystems).
- **Malformed `.chain.md` files are no longer silently dropped.** Chain definition parse failures now emit a warning naming the file and error instead of making the chain invisibly "not exist".

### Changed

- **Refreshed `/mesh-review` with the multi-model review contract.** The prompt now uses only enabled roles (`reviewer` for both review lanes and synthesis), requires evidence-backed reviewer sections, dedupes findings into BLOCKER/SHOULD FIX/NOTE/DISAGREEMENT/IGNORED buckets, and preserves explicit model disagreement handling without turning mesh review into a GitHub PR-posting workflow.

## [0.38.0] - 2026-06-10

### Added

- **Subagent TUI rows get a broader aesthetic refresh.** Live widgets and final result rows now use bracketed model tags (`[provider/model:thinking]`), clearer status/agent glyphs, pipeline connectors between chain spans, a `↺ fallback` badge for retried model attempts, and a status-colored `· background` suffix so active background work is easier to scan.
- **ANSI-styled widget truncation now preserves escape sequences without regex control-character lint exceptions.** The renderer uses a small SGR scanner so styled rows can be truncated while keeping color resets balanced.

## [0.37.0] - 2026-06-08

### Added

- **Dispatched model is now visible per agent.** Every agent row shows the resolved model id (with thinking suffix, exactly as dispatched) immediately after the agent name — e.g. `Agent 1/2: scout (deepseek/deepseek-v4-pro:high) · complete · …`. This appears on both the live background/parallel widget and the final tool-result rows (single, parallel, and chain), so lane/model overrides are auditable at a glance. The model is read from data already plumbed end-to-end (`AsyncJobStep.model`, `SingleResult.model`); only the four render row builders in `src/tui/render.ts` changed (new `renderModelTag` helper). Rows without a known model render unchanged.

## [0.36.1] - 2026-06-06

### Fixed

- **Forked subagents no longer 400 on strict providers.** When a parent orchestrator emits a malformed tool call (the model's JSON arguments or stray `<tool_call>` fragments land in the tool *name* field), that record was replayed verbatim by `fork`-context children. Providers that cap tool-call name length — e.g. Anthropic, where `tool_use.name` must be ≤ 200 chars — rejected the whole request with `400 invalid_request_error` before the child did any work. Forked session transcripts are now sanitized at the fork boundary: over-long or malformed tool-call names are rewritten to a safe, deterministic token (new `src/shared/tool-name-sanitizer.ts`, best-effort and non-fatal).
- **A transport error after a deliverable no longer hard-fails a run.** A single-step run whose agent produced its declared `output` (e.g. `planner` → `plan.md`) but then hit a transient transport error (`WebSocket error`, `socket hang up`, stream/connection terminated) was reported as `✗ failed` with its output discarded. Such runs are now finalized as complete with a `[transport-warning]` note and the produced output is resolved. Gated on a tight transport-only error match **and** the declared output file existing and having changed during the run, so genuine failures are never masked.
- Added WebSocket/transport patterns (`web socket`, `ws error|closed|disconnect`) to the retryable model-failure list so transient connection drops trigger model fallback instead of an immediate hard failure.

### Changed

- **Actionable `Unknown agent` errors.** Dispatch validation (single, parallel, chain, and async paths) now lists the available agent roles and, when the offending value looks like a model id (`openai/gpt-5.5`, `opus`, `claude-opus-4-8`), shows the correct `subagent({ agent: "worker", model: "..." })` shape instead of a bare `Unknown agent: X`. New helpers `looksLikeModelId` / `formatUnknownAgentError` in `agent-selection.ts`.

## [0.36.0] - 2026-06-06

### Added

- **Model lanes** (`subagents.modelLanes` settings key): route an agent through named model configurations (`easy`, `medium`, `hard`) with explicit `model`/`thinking` values. Lane is specified per-dispatch via the new `lane` parameter on single, chain, parallel, and async execution paths.
- **`/subagents config`** slash shortcut (also `/subagents json` and `/subagents edit`): ensures user settings exist, seeds a `subagents.modelLanes` skeleton when absent, and opens the JSON file in `$VISUAL`, `$EDITOR`, or `nano`. Existing settings and `agentOverrides` are preserved.
- **Six-role visible roster**: the builtin agent list is consolidated to six durable roles — `context-builder`, `planner`, `worker`, `reviewer`, `oracle`, `janitor`. Eight compatibility agents are disabled by default (files preserved for opt-in re-enable via `agentOverrides`).
- Disabled agent frontmatter support: `disabled: true` in an agent's YAML frontmatter now hides it from runtime discovery without deleting the file.
- Updated `go` chain: now runs `context-builder → planner → worker → reviewer` using only the six-role roster.
- Updated README and bundled skill documentation with six-role roster, compatibility agent migration paths, lane dispatch examples, and `/subagents config` usage. Root `AGENTS.md` already carried the six-role project guidance from earlier M1 setup.

### Changed

- `worker-light` and `worker-heavy` are now disabled by default. Use `worker` with `lane: "easy"` or `lane: "hard"` dispatch overrides instead.
- `scout`, `researcher`, and `synthesizer` are now disabled by default. Use `context-builder` (with appropriate prompts) and `reviewer` respectively.
- `test-writer` is now disabled by default. Use `worker` with a test-writing prompt or skill.
- `oracle-fresh` is now disabled by default. Use `oracle` with `context: "fresh"` and explicit `reads`.
- `deslopper` is now disabled by default. Use `janitor`.

## [0.35.4] - 2026-06-04

### Fixed

- `/subagents` thinking cycling now respects the selected model's supported thinking levels, so DeepSeek V4 Flash cycles `off` → `high` → `xhigh` instead of exposing unsupported `minimal`/`low`/`medium` levels.
- `/subagents` no-touch saves preserve an explicit separate `thinking` override over any inline model suffix, matching runtime thinking precedence.
- Updated active project guidance to use the renamed `worker-light` and `worker-heavy` builtins.

## [0.35.3] - 2026-06-03

### Fixed

- Foreground abort now reliably escalates to `SIGKILL` for children that ignore `SIGTERM`; the escalation timer is guarded on live process state (`processClosed`/`settled`/`detached`) and `unref()`ed instead of relying on `proc.killed`.
- Builtin agent overrides for `disallowedTools` and `memory` are now parsed, applied, and round-tripped instead of being silently ignored.
- Async model fallback no longer re-queues the primary model as a duplicate candidate before falling back.
- Narrowed the model-fallback retry matcher so ordinary tool/bash output containing "terminated" no longer triggers provider fallback; only provider/stream-style wording does.

### Changed

- `worker`, `worker-light`, and `worker-heavy` now expose the context-mode execution tools and share a unified child-facing tool set.
- Renamed builtin `worker-low`/`worker-high` to `worker-light`/`worker-heavy` to avoid confusing role names with model thinking levels.
- Cleaned duplicated agent frontmatter (`scout`, `researcher`, `synthesizer`) and removed the unused `maxTurns` field from `janitor`/`deslopper`.

### Removed

- Retired the scout/worker bakeoff benchmark kit (`prompts/*-bakeoff.md`, `docs/*-bakeoff/`, associated tests, and `package.json` `files` entries) and obsolete one-off scratch reports.

### Tests

- Refreshed the integration suite to match current runtime (model-selector/keybinding/chain/theme-stub expectations) — `test:integration` is green again.
- Added regression tests for `disallowedTools`/`memory` overrides and the narrowed model-fallback retry matcher.

## [0.35.2] - 2026-06-02

### Changed

- Retired the `/parallel-*` prompt-template family in favor of a mesh-first command system.
- Reworked `/mesh-recon` so simple recon is the default and `deep`/`--deep` selects the artifact-backed lane synthesis workflow.
- Added `/mesh-cleanup`, `/mesh-context`, and `/mesh-handoff` as the cleanup, context-building, and handoff-plan replacements for the retired parallel workflows.
- Updated README, AGENTS, and the bundled `pi-subagents` skill guidance to document the mesh command family.
- Corrected the bundled `pi-subagents` skill and README prompt inventories to remove stale `/reflect-chain` and old prompt-template extension references, and refreshed `/gather-context-and-clarify` to use `ask_user`.

## [0.35.1] - 2026-06-02

### Added

- Added `worker-low` and `worker-high` builtin agents so orchestrators and PMTI task packets can route low-complexity and high-complexity implementation work without runtime schema changes.
- Added a dedicated `test-writer` builtin agent for focused test implementation; the `go` chain now calls `test-writer` directly instead of using generic `delegate` with the test-writer skill.
- Added `janitor` as the primary repository hygiene agent, broadening the old dead-code cleanup role to include stale docs and orphaned artifact audits.

### Changed

- Replaced the vague builtin `delegate` agent with `test-writer`, and removed the old delegate-specific custom-agent default behavior.
- Reworked `deslopper` into a deprecated compatibility alias for `janitor`; new cleanup dispatches should use `janitor`.
- Refreshed README, AGENTS, and the bundled `pi-subagents` skill inventory, including removal of the stale `review` chain reference in favor of `/mesh-review`.

### Tests

- Added/updated agent frontmatter and management regression tests for the renamed builtins, worker variants, and generic custom-agent defaults.

## [0.35.0] - 2026-06-01

### Added

- Inline `thinking` level override for `subagent` tool dispatch, chain steps, and parallel tasks. The `thinking` field is accepted as an optional parameter on top-level single dispatch (`{ agent, task, thinking }`), chain step objects (`{ agent, task, thinking }`), and parallel task objects (`{ agent, task, thinking }`). Accepted values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

- Precedence: inline dispatch `thinking` > `agentOverrides.thinking` > agent file `thinking` > session default. Explicit `thinking: "off"` strips any pre-existing known model suffix (e.g., `provider/model:high` → `provider/model`) so inline thinking truly wins over baked suffixes.

- `src/shared/settings.ts` behavior-resolution surfaces (`StepOverrides`, `SequentialStep`, `ParallelTaskItem`, `ResolvedStepBehavior`, `resolveStepBehavior`) now carry `thinking` as a first-class field. Chain and parallel step thinking does not leak between steps — each step resolves independently.

- `/subagents` TUI hub displays effective thinking level per agent and supports cycling with Tab. Because `/subagents` is a configuration hub, selected thinking levels are persisted as agent overrides; when model and thinking are saved together, known model thinking suffixes are stripped to avoid competing representations.

- New helpers in `src/runs/shared/pi-args.ts`: `stripKnownThinkingSuffix(model)` strips a known thinking suffix; `applyEffectiveThinkingSuffix(model, thinking)` strips any existing known suffix before applying the effective level (including `off`).

- Runtime normalization at the child-session argument boundary: foreground and background paths use `applyEffectiveThinkingSuffix` to normalize model strings before spawning children, and inline thinking without an explicit model uses the current session model when available so it can override the session default.

### Changed

- `SubagentHubResult` interface now includes optional `thinkingOverrides?: Map<string, string>`.
- `SubagentParams` (TypeBox schema) includes optional `thinking` field for single-agent dispatch.
- `TaskItem`, `ParallelTaskSchema`, `ChainItem` schemas include optional `thinking` field.

### Tests

- Added 46 unit tests covering suffix helpers, current-model fallback, `buildPiArgs`, `resolveStepBehavior` / `resolveParallelBehaviors` propagation, hub override save construction, foreground propagation guardrails, and thinking precedence including `thinking: "off"` with pre-existing `:high` suffix.

## [0.34.4] - 2026-05-29

### Fixed

- Completion guard no longer flags analysis/proposal agents that have no way to edit files. `evaluateCompletionMutationGuard` now accepts the agent's resolved tool allowlist and treats an agent whose tools contain neither `edit` nor `write` as incapable of file changes, so it is never expected to mutate — fixing the long-standing false "completed without making edits for an implementation task" failure on `oracle`/`oracle-fresh` proposal-only runs (and any read-only custom agent). Agents with `edit`/`write` (worker, reviewer, planner, etc.) remain fully guarded, and the check is backward-compatible (when no tools are supplied, behavior is unchanged). Tools are threaded in from both the foreground (`execution.ts`, `agent.tools`) and async (`subagent-runner.ts`, `step.tools`) call sites.

### Tests

- Added a completion-guard unit test for the tool-aware exemption: a pure-implementation task is exempt for an `oracle`-shaped read-only allowlist, still triggers when `edit` is present (sanity), and remains guarded when tools are omitted (backward compat).

## [0.34.3] - 2026-05-29

### Fixed

- Stale-run reconciliation no longer salvages a dead-runner async run with **empty** per-step output. When the background runner exits before writing the consolidated result, `reconcileAsyncRun` now recovers each step's output from its persisted stream log (`<asyncDir>/output-<index>.log`, flat-indexed to match `status.steps`) instead of emitting `output: ""`. Applies to both the success-salvage (`buildSuccessRepair`) and failure-salvage (`buildFailedRepair`) paths, so a recovered run hands back the actual agent output rather than forcing a manual log read. Oversized logs are tail-capped to 8000 chars with a pointer to the full log file. Defense-in-depth complement to the 0.34.2 runner-crash fix — covers any future runner death (OOM, SIGKILL, unguarded throw), not just the `tokenUsageFromAttempts` crash.

### Tests

- Added a stale-run-reconciler test asserting recovered per-step output on a dead-PID, all-steps-complete run (verbatim under the cap; tail-capped with a recovery marker + full-log pointer when oversized).

## [0.34.2] - 2026-05-29

### Fixed

- Fix async runner crash that silently failed parallel background runs. `tokenUsageFromAttempts` was called in the parallel token-accounting block (`subagent-runner.ts`) but never defined or imported, throwing `ReferenceError: tokenUsageFromAttempts is not defined` and killing the detached runner **before it wrote a result file** — leaving the run to be marked failed (or reconstructed with empty output) by stale-run reconciliation, even though every child agent had completed. The sequential path masked the same broken reference inside a try/catch; the parallel path was unguarded, so it was fatal. Confirmed as the root cause of three runner-death incidents this cycle (runs `8d0ce5b7`, `deb83f54`, `2a652574`), exposed widely by `c567660` routing more chains through the async/parallel path.
  - Defined `tokenUsageFromAttempts(attempts)` in `src/runs/shared/usage.ts` (sums per-attempt `Usage` into a `TokenUsage`, returns null when no usage is present) and imported it into the runner.
  - Wrapped the parallel token-accounting block in try/catch so token bookkeeping can never fail an otherwise-successful run before the result is written, mirroring the sequential path.

### Changed

- Renamed the parallel recon/review workflow prompts: `/recon` → `/mesh-recon` (`prompts/mesh-recon.md`) and `/parallel-review` → `/mesh-review` (`prompts/mesh-review.md`); removed the superseded `prompts/recon.md`, `prompts/parallel-review.md`, and the `chains/review.chain.md` chain. Updated `README.md` and the packaged `pi-subagents` SKILL to reference the new command names.
- Refreshed the bundled agent definitions (`agents/*.md`): granted the cross-agent `intercom` tool fleet-wide (context-builder, oracle, oracle-fresh, planner, researcher, reviewer, scout, synthesizer, deslopper), tightened review/edit-gating guidance, and adjusted per-agent `thinking`/context defaults. Restored `deslopper`'s `tools` allowlist and de-duplicated its `inheritProjectContext` key (a prior edit had dropped the allowlist and left a conflicting duplicate, which failed the “bundled agents all have explicit tool allowlists” guard).

### Tests

- Added 5 `tokenUsageFromAttempts` unit tests (defined-and-callable regression guard, null on empty/usage-less attempts, summation, and partial-usage handling).

## [0.34.1] - 2026-05-29

### Fixed

- Fix completion-guard false-positive that marked read-only/analysis subagent runs as failed (`reason: "completion_guard"`, "completed without making edits for an implementation task") and discarded valid output. `expectsImplementationMutation()` now strips embedded data payloads (fenced code blocks, blockquoted lines, and everything after a payload label line like `TRANSCRIPT:`/`DIFF:`/`CONTEXT:`) before scanning for implementation intent, so implementation keywords inside the *data being processed* (e.g. a transcript to summarize) no longer trip the guard. Also added explicit analysis-only signals (`do not use tools`, `do not read files`, `output only the summary`) as non-mutating. The legit case — an implementation agent told to edit that returns text without editing — still triggers, because its keyword lives in the instruction, not a payload.

### Changed

- Renamed internal `findLineageUnsupportedCwdReason` → `findLineageUnsupportedReason` since it also rejects `worktree` overrides, not just `cwd`.

### Tests

- Added 4 lineage guardrail integration tests covering rejection of `tasks[].cwd`, sequential `chain[].cwd`, `chain[].parallel[].cwd`, and `chain[].parallel[].worktree` (previously only `worktree` at the top level was covered).
- Added 3 completion-guard unit tests: embedded-payload false-positive reproduction (incl. fenced/blockquoted/labeled payloads), analysis-only intent, and a regression guard confirming real implementation instructions still trigger.

## [0.34.0] - 2026-05-29

### Added

- Add `context: "lineage"` for clean subagent sessions linked to the parent session tree without copying the parent transcript. A lineage child starts with blank model context but its session header points at the parent session file (via `SessionManager.create(..., { parentSession })`), so the relationship is visible in session-tree tools. Supported through the `subagent` tool `context` parameter, agent `defaultContext`, slash entry, and the prompt-template bridge.
- Add `[lineage]` render badge (non-alarming `muted` color) alongside the existing `[fork]` badge, via a shared `renderContextBadge` helper in `src/tui/render.ts`.

### Notes

- Lineage is an organization/linking feature, not a startup-latency optimization: child Pi processes still pay normal startup cost.
- V1 rejects `context: "lineage"` combined with `worktree` or per-child `cwd` overrides so session headers cannot disagree with the child process cwd.
- The `fork-only` intercom mode intentionally does not activate for lineage children because they do not inherit the parent transcript.

## [0.33.7] - 2026-05-29

### Fixed

- Restored `ForegroundControl.nestedRoute?: NestedRouteInfo` field dropped during interface extraction; set by `subagent-executor.ts`, read by `nested-events.ts` and `run-id-resolver.ts`.
- Fixed `PublicNestedRunSummary` projection: removed raw `"steps"` from `Pick<>` (leaked internal `NestedStepSummary`), added `steps?: PublicNestedStepSummary[]` and `children?: PublicNestedRunSummary[]` matching `compactNestedRun()` output.
- Fixed async widget re-render gating in `async-job-tracker.ts`: added `widgetChanged` check on the terminal-state path (before `continue`) and after the try/catch (covering error path), and gated the final `rerenderWidget` on `widgetChanged && hasUI` — previously rendered unconditionally every poll cycle, making the 0.33.6 `widgetRenderKey` export a no-op.
## [0.33.6] - 2026-05-29

### Fixed

- Fixed `src/intercom/result-intercom.ts`: `NestedRunSummary` and `PublicNestedRunSummary` are now type-only imports (they are erased by `--experimental-strip-types`, so value-importing them broke module loading), and restored the missing `formatNestedResultLines(child.children)` call so nested subagents render under their parent in the intercom result message.
- Fixed `src/runs/background/run-id-resolver.ts`: ported the missing `findAsyncRunPrefixMatches` helper into `src/runs/background/async-resume.ts` (the consumer had been ported without its producer).
- Fixed `widgetRenderKey`: exported the full-state render key from `src/tui/render.ts` and consumed it in `src/runs/background/async-job-tracker.ts` (it had been reduced to a partial local stub), restoring upstream alignment and correct async-widget re-render detection.

## [0.33.5] - 2026-05-28

### Added

- Added `nestedChildren?: NestedRunSummary[]` population in async job tracker: every poll cycle calls `updateAsyncJobNestedProjection` to refresh from nested events, and `handleComplete` does a final refresh before cleanup decision.
- Added `nestedRoute` propagation from `AsyncStartedEvent.nestedRoute` into `AsyncJobState` on job start.
- Added `reconcileNestedAsyncDescendants` to stale-run reconciler: reconciles running/queued nested async runs and writes completion/updated events back to the nested event log.
- Added `hasLiveNestedDescendants` guard on async job cleanup: jobs with live nested children are not cleaned up until all descendants reach terminal state.

## [0.33.4] - 2026-05-28

### Added

- Added `nestedRoute?: NestedRouteInfo` and `nestedChildren?: NestedRunSummary[]` to `AsyncJobState` in `src/shared/types.ts`.
- Added `runId?: string` field to child entries in `AsyncResultFile` result schema (`src/runs/background/async-resume.ts`).
- Added `resumeByChildRunId(params: { asyncId: string; childRunId: string })` function to `src/runs/background/async-resume.ts` for targeting a specific child by its runId.
- Added fanout child extension: `src/extension/fanout-child.ts` — fanout-authorized subagent child entrypoint.
- Added nested events system: `src/runs/shared/nested-events.ts` — parent-child event relay for nested runs.
- Added nested path utilities: `src/runs/shared/nested-path.ts` — nested run path encoding/parsing.
- Added nested render helpers: `src/runs/shared/nested-render.ts` — TUI rendering for nested run status lines.
- Added run ID resolver: `src/runs/background/run-id-resolver.ts` — resolves subagent run IDs by pattern.
- Added `attachNestedChildrenToResultChildren` to `src/intercom/result-intercom.ts`.
- Added nested* test suite: `test/unit/nested-events.test.ts`, `test/unit/widget-nested-render.test.ts`, `test/unit/run-id-resolver.test.ts`.

### Changed

- `resumeByChildRunId` resolves child index from `result.results[].runId` in the parent job's result file (Phase 4 will extend to also search `nestedChildren`).

## [0.33.3] - 2026-05-28

### Added

- Added Nested* types: `NestedRunSummary`, `NestedRouteInfo`, `NestedRunMatch`, `NestedRunResolutionScope`, `NestedRunState`, `NestedOwnerState`, `NestedRunAddress`, `NestedStepSummary` to `src/shared/types.ts`.
- Added nested route env var constants to `src/runs/shared/pi-args.ts` (`PI_SUBAGENT_PARENT_*` series).
- Added parent route fields to `BuildPiArgsInput` for fanout support.

## [0.33.2] - 2026-05-28

### Added

- Added `/review-loop` slash command: parent-controlled worker→reviewer→worker loop with stop-on-clean or iteration cap.
- Added `/gather-context-and-clarify` slash command: subagent context gathering then clarifying questions before planning.
- Added `/parallel-context-build` slash command: parallel fresh-context `context-builder` agents for planning handoff.
## [0.33.1] - 2026-05-28

### Fixed

- Corrected the scout bakeoff Qwen candidate model id from `crofai/qwen03.5-9b` to `crofai/qwen3.5-9b`; the former failed provider lookup with `404 Model Not Known` during the SB-03 pilot.

## [0.33.0] - 2026-05-28

### Added

- Added the scout bakeoff benchmark kit: `/scout-bakeoff` prompt template plus `docs/scout-bakeoff/` model list, five read-only reconnaissance task briefs, scoring rubric, scorecard, and bound-task template for comparing scout models on precision, speed, and cost.

### Changed

- Included scout bakeoff docs in the packaged npm files so the prompt template can reference its rubric and task briefs after install.

## [0.32.0] - 2026-05-28

### Added

- Added the worker bakeoff benchmark kit: `/worker-bakeoff` prompt template plus `docs/worker-bakeoff/` model list, six implementation task briefs, scoring rubric, scorecard, and bound-task template for comparing worker models in isolated worktrees.

### Changed

- Included worker bakeoff docs in the packaged npm files so the prompt template can reference its rubric and task briefs after install.

## [0.31.1] - 2026-05-28

### Fixed

- Chain steps containing a parallel group crashed with `aggregateParallelOutputs is not a function`. `chain-execution.ts` imported `aggregateParallelOutputs` (and the `ParallelTaskResult` type) from `shared/settings.ts`, which does not export them — they live in `runs/shared/parallel-utils.ts`. Corrected the import source. The top-level `tasks:` parallel path was unaffected; only the parallel-within-chain path (e.g. the `/recon` workflow) was broken.

## [0.31.0] - 2026-05-28

### Added

- `synthesizer` agent (`agents/synthesizer.md`): a strong fan-in agent that fuses multiple parallel scout/researcher briefs into one decision-ready synthesis — preserves citations, surfaces conflicts instead of smoothing them over, and flags per-finding confidence. Designed as the reduce step after a parallel recon fan-out.
- `/recon` prompt (`prompts/recon.md`): partitioned multi-model parallel recon playbook. Fans out diverse-model `scout`/`researcher` lanes across distinct angles (model diversity over replication), each writing a tight evidence-dense brief to a file, then offloads the synthesis to the `synthesizer` agent so the orchestrator only ingests the digest. Complements `/parallel-research` (which keeps synthesis in the parent).

## [0.30.0] - 2026-05-28

### Added

- Added subagent hub TUI (`src/tui/subagent-hub.ts`) for browsing and configuring agent model overrides before launch.
- Added `go` chain template (`chains/go.chain.md`): scout → context-builder → worker → test-writer delegate → reviewer pipeline.
- Added `disallowedTools` denylist for built-in tools on agent frontmatter.
- Added persistent agent memory (project scope) with `MEMORY.md` index per agent.
- Added tests for skill preloading from agent frontmatter.
- Added `review` chain template (`chains/review.chain.md`): parallel model-diverse reviewers → synthesis pipeline.
- Added `test-writer` skill (`skills/test-writer/SKILL.md`) for guided test infrastructure discovery before writing tests.
- Added `/reflect-chain` prompt template for analyzing chain run artifacts and suggesting improvements.
- Added `/brainstorm` prompt template for design-first exploration with clarifying questions and approach tradeoffs (uses the `brainstorming` skill).
- Added `/write-plan` prompt template for authoring implementation plans an executor can pick up, with explicit validation commands and a self-review pass (uses the `writing-plans` skill).
- Merged `/run-chain` into `/chain` — saved chains are now invoked via `/chain <chainName> -- <task>`, inline chains via `/chain agent "task" -> agent`. Removed `/run-chain` slash command.
- Added `dead-code-cleanup.test.ts` verifying removed exports, consolidated functions, and non-optional state fields.
- Refactored `src/slash/slash-commands.ts`: extracted saved-chain and inline-chain handling into dedicated functions, improved session export with child-session snapshot persistence, and expanded inline per-step config parsing for `model` and `skill` keys.
- Added shared runner primitive modules (`src/runs/shared/`): `usage.ts` (`emptyUsage`, `sumUsage`), `exit-drain.ts` (drain timer constants and `DrainTimers` type), `output-buffer.ts` (`createRecentOutputBuffer` with trimming and shallow-copy snapshot), and `stdio-parser.ts` (`createLineProcessor` with `onJson`/`onRaw` dispatch). Includes 32 new unit tests.

### Changed

- Tightened `/reflect-chain` prompt: replaced inline `bash` blocks with instructions that use the structured `find`/`ls` tools, falling back to `bash` only when needed.
- Updated README and `skills/pi-subagents/SKILL.md` to drop the two removed prompts and document the two new ones.
- Updated `scout` agent with a mandatory Test Infrastructure output section for downstream agents.
- Extended chain execution with recovery telemetry for parallel mode and recovered output in chain summaries.
- Consolidated `findLatestSessionFile` into `src/shared/utils.ts`; removed duplicate copies from `session-tokens.ts` and `subagent-runner.ts`.
- Replaced `MAX_PARALLEL_CONCURRENCY` with canonical `MAX_CONCURRENCY` from `types.ts`; removed duplicate from `parallel-utils.ts`.
- Aliased `ControlEventType` to `ActivityState` in `types.ts`.
- Made `SubagentState.foregroundRuns` and `SubagentState.pendingForegroundControlNotices` non-optional; removed dead null-guards and `??=` fallbacks in `control-notices.ts` and `subagent-executor.ts`.
- Renamed `POLL_INTERVAL_MS` to `WATCHER_POLL_INTERVAL_MS` in `result-watcher.ts` for clarity.
- Updated `review` chain template model defaults to current providers (`gpt-5.5`, `kimi-k2.6`, `mimo-v2.5-pro`, `glm-5.1-precision`).
- Refactored `src/runs/foreground/execution.ts` and `src/runs/background/subagent-runner.ts` to consume shared primitive modules (`usage.ts`, `exit-drain.ts`, `output-buffer.ts`, `stdio-parser.ts`); removed duplicate local definitions of `emptyUsage`, `sumUsage`, drain timer constants, `appendRecentOutput`/`appendRecentStepOutput`, and inline JSON line parsing.
- Converted `executeAsyncSingle` from a ~125-line duplicate of `executeAsyncChain` into a ~35-line thin wrapper; `AsyncChainParams.resultMode` widened to `SubagentRunMode`. Zero caller changes.

### Removed

- Removed unused `getOutputTail`, `writePrompt` from `utils.ts`.
- Removed unused `fuzzyScore`, `fuzzyFilter`, `formatPath` from `render-helpers.ts`.
- Removed `MAX_PARALLEL_CONCURRENCY` export from `parallel-utils.ts`.
- Removed `/gather-context-and-clarify` prompt (referenced a nonexistent `interview` tool and was superseded by `/parallel-handoff-plan`).
- Removed `/parallel-context-build` prompt (heavy overlap with `/parallel-handoff-plan`, which is its strict superset).
- Removed dead `loadRunsForAgent` function from `run-history.ts`.
- Removed unreachable `aggregateParallelOutputs` fallback branch in `subagent-executor.ts`.
- Removed two unused re-exports from `settings.ts`.
- Unexported `splitKnownThinkingSuffix` in `model-info.ts` (internal utility, no external callers).

### Fixed

- Salvage completed async/parallel runs whose runner process dies before writing the aggregated result. The stale-run reconciler now reconstructs a successful result from `status.json` (when every step is terminal with exit code 0) instead of marking the whole run failed; runs with any failed/incomplete step still fail as before (`src/runs/background/stale-run-reconciler.ts`).
- Persist the run result file *before* session-sharing network I/O and post-processing in `subagent-runner.ts`, so a crash or external kill during those steps can no longer lose a completed run's output (the final write still enriches it with share links and the resolved session file).
- Install `uncaughtException`/`unhandledRejection` handlers in `subagent-runner.ts` so a runner crash is logged rather than vanishing silently.

- Fixed stray tab indentation on `getLastActivity` in `utils.ts`.
- Fixed broken imports in `subagent-runner.ts` (duplicate `aggregateParallelOutputs`, dangling `findLatestSessionFile` line).
- Refreshed `AGENTS.md` project structure, test support table, CodeGraph stats, and test conventions to match current codebase.
- Updated bundled `pi-subagents` skill to document the `/run-chain` → `/chain` merge and correct slash-command references.

## [0.24.0] - 2026-05-03

### Changed

- Consolidated async step activity and parallel-outcome formatting used by widgets and `subagent({ action: "status" })` output.
- Updated `/parallel-review` and `/parallel-cleanup` to end review synthesis with numbered follow-up choices, plus an `autofix` mode for automatically applying fixes worth doing now.
- Include async run output paths in `subagent({ action: "status" })` output so the remaining inspection path covers the logs previously surfaced by the removed overlay.

### Removed

- Removed the unnecessary `/agents` manager overlay, its `Ctrl+Shift+A` shortcut, and the `agentManager.newShortcut` setting to cut unnecessary UI surface area; agent and chain management remains available through tool actions, settings, and markdown files.
- Removed persistent save actions from the chain clarify UI: `S` no longer writes runtime overrides back to agent frontmatter, and `W` no longer saves `.chain.md` files. Clarify now only edits the imminent run.
- Removed the `/subagents-status` read-only overlay and its slash command; async runs remain inspectable through `subagent({ action: "status" })`, completion notifications, logs, and the async widget.
- Removed the standalone `src/tui/text-editor.ts`; chain clarify now keeps its small runtime editor logic local to the only remaining consumer.

## [0.23.1] - 2026-05-02

### Added

- Persist async per-child session metadata and remember recent foreground child session metadata so `resume` can revive multi-child async runs and foreground children by index.

### Fixed

- Keep foreground children alive when they call `contact_supervisor` for a blocking decision by treating it as intercom coordination during parent detach, matching the generic `intercom` handoff path.
- Pause foreground parallel and chain flows when a child detaches for intercom coordination instead of counting the child as a successful completed result and continuing the workflow, and suppress grouped completion receipts for detached chains.
- Tighten resume/revive safety by rejecting pending async children, detached foreground children that may still be live, ambiguous foreground/async id prefixes, and exact invalid resume matches that would otherwise be masked by a prefix match in the other namespace.
- Preserve child session metadata in stale-run repaired results and avoid advertising revive from top-level-only or missing child session files.
- Stop builtin `reviewer` runs from writing progress by default, clarify that review-only/no-edit instructions win over progress-writing or artifact-writing instructions, and suppress automatic progress injection for explicit no-edit tasks even when chain templates use `{task}`.
- Treat parsed provider errors as failed foreground and async subagent attempts even when the child process exits successfully, and baseline saved output files per fallback attempt.
- Preserve output-file read and inspect errors instead of silently overwriting or falling back when a changed saved-output path cannot be read.
- Show each active async widget row's lifecycle status (`running`, `complete`, `failed`, or `paused`) alongside activity and usage stats.
- Start new direct, slash, prompt-template, foreground, and async subagent launches in compact view while keeping `Ctrl+O` available for live detail.
- Label top-level async parallel completion notifications as parallel runs instead of leaking the internal chain-shaped runner plan.

## [0.23.0] - 2026-05-02

### Fixed

- Detect `pi-intercom` when installed through the documented `pi install npm:pi-intercom` package flow, instead of only checking the legacy local extension path.

### Changed

- Store and discover saved chain workflows from dedicated chain directories: user chains in `~/.pi/agent/chains/**/*.chain.md` and project chains in `.pi/chains/**/*.chain.md`.
- Retry foreground subagent fallback models when Pi reports a retryable provider error, such as 429/quota, even if the child process exits successfully.
- Align single-run async subagent widgets and `/subagents-status` rendering with foreground subagent result styling for parallel, chain, and grouped chain runs, including inline live detail when tool output expansion is enabled, while keeping multi-job async widgets compact.
- Render async subagent widgets through an adaptive component so active parallel agent rows fit without Pi's fixed string-widget truncation marker.
- Tell parent agents that async runs are detached and they should end the turn instead of running sleep/poll loops when no independent work remains.

## [0.22.0] - 2026-05-02

### Added

- Added child-only supervisor contact support for delegated subagents through `contact_supervisor`, with `need_decision` for blocking supervisor replies and `progress_update` for concise non-blocking updates.
- Pass supervisor intercom metadata into foreground, chain, parallel, and background child runs so the child-facing pi-intercom tool can resolve the delegating session automatically.

### Changed

- Builtin agents now inherit the user's configured default model instead of pinning `openai-codex/gpt-5.5`; use builtin overrides to pin a model for a role.
- Hide unsupported thinking levels in subagent clarify and agent-manager pickers when Pi exposes per-model thinking metadata.
- Updated builtin agent prompts, README, and bundled skill docs to prefer `contact_supervisor` for blocked decisions and avoid child-side routine completion handoffs.
- Teach reviewer agents that repo-local `progress.md` files are intentional scratch files that should remain untracked and covered by `.gitignore`.

### Fixed

- Added regression coverage for supervisor metadata propagation into child process environments.

## [0.21.5] - 2026-05-02

### Fixed

- Show top-level async parallel runs as `parallel` instead of `chain`, with foreground-style running/done wording in widgets and status output, and group running async chain detail by chain step.
- Scoped `/subagents-status` to async runs launched from the current pi session instead of showing prior or unrelated sessions.
- Declared the Pi TUI package as a direct dev dependency and added a manifest guard so CI installs do not rely on transitive optional peer dependencies for tests.
- Made prompt-runtime extension path assertions portable on Windows.

## [0.21.4] - 2026-05-01

### Added

- Added explicit frontmatter `package` identifiers for agents and saved chains, registering runtime names like `code-analysis.scout` while preserving separate `name` and `package` fields on save.
- Added recursive subdirectory discovery for user and project agent and chain definitions.
- Added `outputMode: "inline" | "file-only"` for saved subagent outputs. `inline` remains the default, while `file-only` returns a concise saved-file reference instead of injecting full saved output back into the parent context.

### Fixed

- Marked Pi runtime peer dependencies as optional so npm package installs do not auto-install duplicate Pi packages or emit unrelated transitive dependency warnings.

## [0.21.3] - 2026-04-30

### Fixed

- Debounce foreground `needs_attention` notices, make them non-triggering, and cancel them when the run finishes so stale chain-step alerts do not launch parent turns after completion.

## [0.21.2] - 2026-04-30

### Added

- Added a packaged `/parallel-context-build` prompt for parallel `context-builder` handoff passes.
- Added a packaged `/parallel-handoff-plan` prompt for external-reference research plus local `context-builder` passes that produce an implementation handoff meta-prompt.

### Changed

- Strengthened `context-builder` guidance so handoffs require reading all relevant files and doing needed tool-available research before summarizing.
- Expanded the bundled `pi-subagents` skill with tool-level recipes for the packaged prompt workflows, including context-build and handoff-plan patterns that parent agents can apply without slash commands.
- Updated `README.md` to explain the bundled `pi-subagents` skill, what it covers, and how it helps the orchestrating agent.

### Fixed

- Make active-long-running notices time-based by default, with turn and token thresholds available only as explicit opt-in budget guards.
- Stop async status listing from inventing `needs_attention` with default thresholds when the runner has not persisted a control state.
- Treat string `"false"` output settings as disabled output so parallel reviewers do not collide on a `/false` output path, including chain-parallel agent defaults.
- Wrap long `/subagents-status` detail output/event lines instead of truncating them with ellipses.
- Treat cleanup after a clean terminal assistant stop as success even when the final assistant text is empty, using a short grace period before terminating lingering child processes without surfacing scary final-drain warnings.
- Express flexible tool schema fields as `anyOf` unions without parent-level `type` arrays, avoiding schema shapes rejected by strict providers such as Moonshot/opencode-go.

## [0.21.1] - 2026-04-30

### Changed

- Changed the `/agents` new-agent shortcut from `Alt+N` to `Shift+Ctrl+N`, and added `agentManager.newShortcut` config for overriding it.

### Fixed

- Fall back to polling async result files when native result watching is unavailable due to `EMFILE` or `ENOSPC`.
- Treat forced final-drain termination after a valid final assistant output as cleanup success instead of failing the subagent run.
- Hide disabled builtin agents from `subagent({ action: "list" })` output so agent-facing choices match executable runtime discovery.
- Resolve intercom bridge default paths at runtime so tests and isolated environments that change `HOME` use the correct `pi-intercom` location.
- Made the tool-description source check tolerant of Windows line endings.

## [0.21.0] - 2026-04-29

### Changed

- Document the recommended parent-agent workflow as `clarify → planner → worker → fresh reviewers → worker` in the docs and bundled skill.
- Packaged `planner`, `worker`, and `oracle` now default to forked session context when the launch omits `context`; explicit `context: "fresh"` still overrides the agent default.
- Expanded builtin subagent guidance so agents with a safe pi-intercom target can hand results back with blocking `intercom ask`, documented the self-orchestrated clarify → plan → implement → review workflow, and added GPT-5.5-oriented subagent prompt guidance to the bundled skill and `context-builder`.

### Fixed

- Prevent child subagents from receiving parent orchestration tooling/history, and inject boundary instructions that forbid sub-delegation and pseudo tool calls.
- Added active-long-running and repeated mutating-tool failure notices so supervised/forked workers cannot burn turns silently while still appearing healthy.
- Fixed task editor wrapping so wide characters cannot push text past the right border.
- Mark implementation subagents as failed when they complete without any file mutation attempt.
- Applied the same no-mutation completion guard to async/background runner paths.
- Split terminal no-mutation guard notices from live idle notices so completed failures do not suggest status or interrupt commands.
- Clarified worker/intercom bridge instructions so blocked decisions use `intercom ask` and stay alive for the reply instead of completing with a question.
- Labeled the Agents widget as async/background work so running detached agents are easier to identify.
- Reworked parallel progress wording so parallel runs show running/done agent counts (and chain parallel groups show `step X/Y · parallel group` with agent fractions) instead of serial `step X/Y` counters.
- Expanded `/parallel-cleanup` guidance to flag redundant wrapper tests when one focused regression is enough.
- Fixed flexible schema validation for `reads` and `skill` overrides so `reads: false`, `skill: "review"`, and `skill: false` no longer trigger `element.reads.every is not a function` (issue #124).
- Hardened slash-result and async-widget animation timers so stale extension contexts after `/new` or reload stop their timers instead of crashing on `ctx.ui` access (issue #122).

## [0.20.1] - 2026-04-27

### Fixed

- Made the packaged `/parallel-cleanup` prompt self-contained instead of referencing local-only cleanup skills.

## [0.20.0] - 2026-04-27

### Added

- Added a packaged `/parallel-cleanup` prompt for focused cleanup review passes.

### Changed

- Consolidated the `oracle-executor` role into `worker`: `worker` now uses `openai-codex/gpt-5.3-codex` with high thinking and stricter approved-direction guardrails, while `researcher` and `context-builder` now use medium thinking.
- Updated the bundled `scout` agent model/thinking defaults.
- Hard-cut over grouped intercom bridge result delivery: with the bridge active, parent-side `pi-subagents` emits one grouped `subagent:result-intercom` message per foreground parent run (single, top-level parallel, or chain) and one per completed async result file. Acknowledged foreground delivery returns a compact receipt instead of duplicating full output in the normal tool result; unacknowledged delivery preserves the normal full output. Grouped messages include child intercom targets and full child summaries.

### Fixed

- Fixed status and manager row rendering so multiline or tabbed content cannot overflow table rows.

### Removed

- Removed the bundled `oracle-executor` agent and `/oracle-executor` prompt template in favor of using `worker` for approved oracle handoffs.

## [0.19.3] - 2026-04-27

### Changed

- Updated the packaged `/parallel-review` prompt so reviewer angles are generated dynamically from the user's intent, plan, implemented code, and current diff, with the listed angles framed as examples rather than fixed defaults.

## [0.19.2] - 2026-04-27

### Added

- Added packaged prompt templates for common subagent workflows: `/parallel-research`, `/gather-context-and-clarify`, and `/oracle-executor`.

### Changed

- Tightened the packaged `/parallel-review` prompt so fresh-context reviewers get distinct angles and return evidence-backed findings.
- Refreshed the packaged `pi-subagents` skill with doctor diagnostics, saved-chain launches, prompt shortcuts, builtin overrides, intercom bridge guidance, fresh-context review defaults, and parallel task behavior.
- Reworked the README around plain-language usage, good first prompts, packaged prompt shortcuts, builtin agent guidance, intercom setup, model overrides, and optional reference material.

## [0.19.1] - 2026-04-26

### Added

- Added `subagent({ action: "doctor" })` and `/subagents-doctor` for read-only subagent environment diagnostics.
- Added `/run-chain` to launch saved `.chain.md` workflows directly from slash commands with completion, shared task input, and `--bg`/`--fork` support.

## [0.19.0] - 2026-04-26

### Added

- Added top-level parallel task support for per-task `output`, `reads`, and `progress`, including `/parallel` inline forwarding and async preservation.
- Added `/agents` launch toggles for forked context, background execution, and worktree-isolated parallel runs.
- Added a read-only detail view to `/subagents-status` for inspecting selected async runs, including recent events, output tails, and useful run paths.
- Added a packaged `/parallel-review` prompt template for launching fresh-context adversarial review subagents.

### Fixed

- Parallel and chain child runs now detach cleanly when a child uses intercom, preventing incoming handoff messages from aborting the parent foreground run.

## [0.18.1] - 2026-04-25

### Changed

- Restyled live subagent rendering, async widgets, and background completion notifications with compact Claude-style visual grammar while preserving existing observability paths.
- Parallel subagent result rendering now labels parallel workers as `Agent N` instead of `Step N`, while chain rendering keeps step terminology.

### Fixed

- `/run` and single-agent tool calls now allow self-contained agents to run without a task string.
- The `subagent` tool description no longer advertises hardcoded builtin agent names and management list output now separates disabled builtins from executable agents.
- Flexible `subagent` tool schema fields now include explicit JSON Schema types so llama.cpp and local OpenAI-compatible providers accept them.
- Settings package sources now resolve explicit `git:` and `npm:` entries from project and user package caches.
- Slash-command subagent results are now export-friendly, including completed output and child session paths in visible export content.

## [0.18.0] - 2026-04-23

### Added

- Added subagent control notifications so `needs_attention` signals push structured parent events, persist async control events to `events.jsonl`, show visible transcript notices for the user and parent agent, include proactive `nudge`/`status`/`interrupt` commands when a child appears blocked, and show each visible notice at most once per child run and attention state.
- Added stable child intercom session names for controlled subagents so needs-attention pings can tell the orchestrator which agent needs attention and how to message it when intercom is available.

### Changed

- Replaced the unreleased `starting`/`active`/`quiet`/`stalled`/`paused` activity labels with factual activity reporting and a single `needs_attention` control signal, keeping `paused` as lifecycle state only.
- Added `subagent({ action: "status", id })` and `subagent({ action: "status" })` as the control-surface status checks, replacing the separate `subagent_status(...)` tool.
- Adjusted bundled agent defaults: most builtins now use `openai-codex/gpt-5.5`, while `scout` uses `openai-codex/gpt-5.4-mini`.
- Removed the incomplete e2e suite and stale `@marcfargas/pi-test-harness` dev dependency; `test:all` now runs the maintained unit and integration suites.

### Fixed

- Paused async runs now render `Background task paused` notifications instead of failed/completed copy, including after extension reloads with stale legacy listeners still present.
- Async status output no longer shows stale activity-age lines for paused or completed runs.

## [0.17.5] - 2026-04-23

### Added

- Added subagent control activity state for foreground and async runs, including `starting`/`active`/`quiet`/`stalled`/`paused` tracking, compact stalled/recovered/paused control events, and an in-tool `action: "interrupt"` soft interrupt that pauses the current child turn without adding another top-level tool.

### Changed

- Updated bundled agents to use `openai-codex/gpt-5.5` defaults, with `scout` on `openai-codex/gpt-5.5-mini` and `oracle-executor` on `openai-codex/gpt-5.5:xhigh`.

### Fixed

- Async/background status token reporting now falls back to in-memory model-attempt usage when detached runs do not produce session `.jsonl` files, which also preserves token totals across model fallback retries.
- Non-Windows subagent launches now use plain `pi` again instead of reusing the current CLI script path, avoiding runs that get confused by installed `dist/cli.js` entrypoints.

## [0.17.4] - 2026-04-22

### Added

- Bundled a `pi-subagents` skill that teaches agents how to use builtin subagents, slash-command vs tool workflows, management-mode agent creation/editing, fork/intercom coordination, clarify mode, worktrees, async status inspection, and chain templating.

### Changed

- Tightened the builtin `oracle` prompt so intercom-enabled forked reviews now prefer concise conversational handoffs during the review and send a short final recommendation via `pi-intercom` before returning the full structured result.
- Tightened `oracle-executor` so it explicitly frames itself as the single writer thread and escalates gaps in the approved direction instead of silently patching around them.

## [0.17.3] - 2026-04-22

### Added

- Added builtin `oracle` and `oracle-executor` agents for the `main -> oracle -> main decision -> oracle-executor` workflow, plus README guidance for invoking the oracle pair with forked context.

### Fixed

- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed

- Moved TypeBox from `peerDependencies` to a real `dependencies` entry so `pi install` production installs keep the schema package available at runtime.

## [0.17.2] - 2026-04-21

### Added

- Added `forceTopLevelAsync` so depth-0 delegated runs can be forced into background mode with `clarify: false`, while nested runs keep their existing behavior.

### Fixed

- Background completion notifications now render `(no output)` instead of a blank body when a completion summary is empty or whitespace-only.
- Async status and token reporting now rerender more reliably when cleanup state changes, read token usage from `message.usage`, and prefer the newest session file when multiple async session files exist.
- Async/background startup now fails fast for invalid resolved `cwd` values and spawn failures instead of reporting false launch success.
- Sync and async runner paths now drain stuck child processes in bounded time, covering both post-exit stdio holders and children that emit a final message but never exit.

## [0.17.1] - 2026-04-20

### Added

- Foreground subagent runs now make deeper live detail easier to discover. Running cards show an explicit `Ctrl+O` hint, lightweight live-state signals like recent activity, current-tool durations, and artifact output paths when available. Common array-heavy tool previews such as `web_search.queries` and `fetch_content.urls` are now summarized more clearly instead of collapsing into opaque fallback text.

### Changed

- Forked delegated runs now use stronger prompt-side guidance for `pi-intercom` coordination instead of runtime policing. The default fork preamble and intercom bridge instructions now explicitly treat inherited fork history as reference-only context, tell children not to continue the parent conversation in normal assistant text, and steer upstream questions or handoffs through `intercom` when needed.
- Documented an opt-in custom agent pattern for forked chat-back workflows so users can make that coordination contract explicit without changing builtin agents.
- Slash-run status text and `/subagents-status` summary output now use the same more explicit observability language, including clearer live-detail hints and surfaced output/session paths in the async status overlay.
- Builtin agent defaults now prefer `openai-codex` models for `planner`, `scout`, `researcher`, `context-builder`, and `worker`.

### Fixed

- Removed the short-lived foreground intercom enforcement/retry layer from delegated fork runs. Coordination behavior is now shaped by prompt and agent design only, avoiding hidden retries, heuristic output inspection, and failure paths based on guessed intent.

## [0.17.0] - 2026-04-16

### Added

- Builtin agents can now be disabled through `subagents.agentOverrides.<name>.disabled` or the bulk `subagents.disableBuiltins` setting, with `/agents` keeping disabled builtins visible so they can be re-enabled from the manager. This builds on PR `#81`. Thanks @danielcherubini.

### Fixed

- Builtin disable precedence is now coherent across user and project settings: project overrides beat user overrides, project bulk disable beats user re-enable attempts, and same-scope per-agent overrides can opt an agent out of bulk disable.
- `/agents` now blocks launching disabled builtins, shows their disabled state in list/detail views and management output, and avoids exposing the builtin-only `disabled` field when editing normal user/project agents.
- Multi-agent chain launches from `/agents` now collect a task before dispatching instead of emitting an empty task, and settings read failures now surface as read errors instead of being mislabeled as parse failures.

## [0.16.1] - 2026-04-16

### Changed

- Parallel subagent startup no longer applies any worker-start stagger in `mapConcurrent()`. `pi-subagents` now relies on Pi core's settings/auth lock retry behavior instead of carrying its own startup-delay workaround.

## [0.16.0] - 2026-04-16

### Added

- Top-level parallel `tasks` mode now supports a per-call `concurrency` override, matching the existing chain parallel-step concurrency control. This ships part of issue `#91`. Thanks @Gabrielgvl.

### Changed

- Top-level parallel defaults and limits can now be configured through `~/.pi/agent/extensions/subagent/config.json` under `parallel.maxTasks` and `parallel.concurrency`, while keeping the existing defaults of 8 tasks and concurrency 4 when unset. This completes issue `#91`. Thanks @Gabrielgvl.

### Fixed

- `context: "fork"` sync runs now create child sessions from a throwaway session-manager instance opened on the persisted parent session file, instead of mutating the live parent session manager. This keeps the parent session writing to its own file so the matching `toolResult(subagent)` no longer lands in a descendant session by accident. This fixes issue `#87`. Thanks @asmisha.
- Project agent and chain discovery now reads both `.agents/` and `.pi/agents/`, while preferring `.pi/agents/` when both locations define the same parsed name and keeping manager writes on the `.pi/agents/` path. This fixes issue `#88`. Thanks @desek.
- Ctrl+O expanded subagent results now actually show expanded content. Previously the `expanded` flag was received but ignored, so task text and tool-call args were identically truncated in both views. Now expanded mode shows the full task and longer (but still bounded) tool-call previews. Additionally, tool calls are no longer lost after foreground compaction: compact display summaries are preserved and shown in expanded view even after `messages` are stripped. This addresses issue `#90`. Thanks @asagajda.

## [0.15.0] - 2026-04-16

### Added

- Added `systemPromptMode` so subagents can replace Pi's base prompt with `--system-prompt` instead of always appending with `--append-system-prompt`, shipping the core of issue `#85` from @isvlasov.
- Added `inheritProjectContext` and `inheritSkills` so child runs can keep or strip inherited project instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) and Pi's discovered skills block.

### Changed

- Builtin subagents now default to `systemPromptMode: replace`, with builtin `delegate` staying on `append`.
- Builtin agents now inherit project-level instruction files by default unless the user overrides them.
- Builtin agent prompts were rewritten for the new prompt-assembly model, and builtin `reviewer` / `context-builder` tool lists now match their documented behaviors. This rounds out the prompt-assembly work merged in PR `#92`, which closed issue `#85`. Thanks @isvlasov.

### Fixed

- Cross-platform tests now avoid machine-specific Pi install paths, align homedir-sensitive settings discovery on Windows CI, and use deterministic async config-write failure fixtures.
- Request-level `cwd` handling is now consistent across management and execution paths. `subagent` requests that target a worktree or nested checkout now resolve project agents, project settings, and builtin agent overrides from the requested `cwd` instead of accidentally inheriting the parent session's repo. This fixes issue `#83`. Thanks @hakin19 for the report.
- Relative child `cwd` values now resolve from the already-selected request/shared `cwd` across sync runs, async/background runs, chain steps, and top-level parallel tasks. This fixes cases where values like `packages/app` were interpreted from the wrong base directory, which could break skill lookup, output paths, and child process spawning.
- Worktree parallel-mode validation now compares task-level `cwd` overrides after relative-path resolution, so equivalent paths like `.` no longer trigger false conflict errors against the shared worktree base.
- Internal TypeScript source imports in the touched runtime paths now consistently use `.ts` local specifiers, matching the repo's direct TypeScript runtime loading conventions and reducing drift between adjacent modules.

## [0.14.1] - 2026-04-14

### Fixed

- Completed foreground subagent results now return compact payloads instead of inlining full raw message histories and per-result progress objects, preventing long tool-heavy sync runs from overwhelming the parent agent return path.
- Prompt-template delegation now rebuilds minimal assistant messages from compact foreground results when raw message arrays are intentionally omitted.
- UI/status wording now uses plain text labels instead of glyph-heavy markers across foreground rendering, parallel summaries, save-result receipts, installer output, agent manager views, clarify screens, and the corresponding README/CHANGELOG examples.
- Added a realistic foreground integration repro for issue `#80` and cleaned up the touched tests to remove the remaining blunt `as any` fixture casts.

## [0.14.0] - 2026-04-14

### Added

- Builtin agents can now be customized through settings-backed field overrides in `~/.pi/agent/settings.json` and `.pi/settings.json` under `subagents.agentOverrides`, with `/agents` exposing a create/edit override flow instead of forcing full-file copies for model/thinking/tool/prompt tweaks.

### Fixed

- Shared temp paths are now scoped under a user-specific temp root across async result storage, async run state, chain directories, artifact fallback storage, and detached async config files, avoiding cross-user collisions on shared machines while still handling arbitrary-UID/container environments where `os.userInfo()` can throw.
- Async/background runs now launch child `pi` processes in JSON mode, stream child events into `events.jsonl` with step metadata while the run is active, keep `output-<n>.log` live with human-readable child output, and document that `subagent-log-<id>.md` is a completion artifact.
- Bare model IDs now prefer the active parent-session provider when that provider actually exposes the model, across sync, chain, parallel, async, and clarify flows. Ambiguous bare IDs still fall back to conservative resolution.
- Skill resolution now includes local package roots declared in project/user `settings.json -> packages`, checks the effective task `cwd` before the runtime cwd, and still falls back to the runtime cwd when a nested task inherits package-provided skills from the repo root.

## [0.13.4] - 2026-04-13

### Fixed

- Intercom orchestration now uses a runtime-only `subagent-chat-<id>` fallback target for unnamed sessions instead of persisting a generic session title, so `pi --resume` keeps showing transcript snippets while delegated intercom routing still works.
- GitHub Actions test workflow now uses `actions/checkout@v5` and `actions/setup-node@v5`, removing Node 20 action-runtime deprecation warnings ahead of the enforced Node 24 transition.
- Worktree cwd mapping now derives repo-relative prefixes from `git rev-parse --show-prefix` instead of `path.relative(realpath, realpath)`, fixing Windows 8.3/canonical-path mismatches that could map `agentCwd` back to the source repo instead of the created worktree.
- Async background runs now pass the parent process `argv[1]` through to the detached runner, so Windows child spawning keeps targeting the intended `pi` CLI entry point instead of accidentally treating the runner's `jiti` bootstrap script as `pi`.
- Intercom detach listeners now guard optional event-bus subscriptions with optional-call semantics, so delegated runs no longer fail when host event buses expose `emit` without `on`.
- Skill discovery no longer depends on runtime imports from `@earendil-works/pi-coding-agent`; it now resolves skills directly from configured filesystem paths, preventing `ERR_MODULE_NOT_FOUND` crashes in local/integration test environments.

## [0.13.3] - 2026-04-13

### Added

- Added `intercomBridge.instructionFile` so subagent intercom guidance can be overridden from a Markdown template with `{orchestratorTarget}` interpolation.

### Fixed

- Intercom-enabled delegated runs now detach only after the child actually starts the `intercom` tool, preserving clean sync behavior until coordination is needed.
- Graceful intercom coordination no longer leaves detached child runs vulnerable to later parent abort listeners, and reply confirmation follow-ups avoid unnecessary orchestrator aborts.
- Child process spawn failures now preserve the original error message instead of collapsing to a generic failure.

## [0.13.2] - 2026-04-13

### Changed

- `intercomBridge` now defaults to `always` so intercom coordination instructions are injected for both `fresh` and `fork` delegated runs when `pi-intercom` is available.

## [0.13.1] - 2026-04-13

### Added

- Added optional intercom orchestration bridge for delegated runs. When enabled via `intercomBridge` (default `fork-only`) and `pi-intercom` is available, child subagents get runtime coordination instructions for contacting the orchestrator session via `intercom`, and `intercom` is auto-added to the child tool allowlist when needed.
- Added unit coverage for intercom bridge activation, config handling, and extension allowlist behavior.

### Changed

- Normalized `subagent-executor.ts` relative imports to `.ts` specifiers to match direct TypeScript runtime loading.
- Documented `pi-intercom` installation and activation requirements in README.

### Fixed

- Tightened intercom extension allowlist matching to avoid false positives from similarly named extension paths.

## [0.13.0] - 2026-04-11

### Added

- Added native agent `fallbackModels` support. Agents can now declare ordered backup models, and single, chain, parallel, and async/background runs retry on provider/model-style failures such as quota, auth, timeout, or provider/model unavailability.

### Fixed

- Fallback attempts now preserve observability across sync and async execution: results, artifact metadata, async status, and run logs record attempted models and per-attempt outcomes instead of only the final pass.
- Child subagent runs now pass model selections through `--model` instead of `--models`, so live execution pins the intended model correctly and end-to-end fallback behavior matches the validated test path.

## [0.12.5] - 2026-04-09

### Fixed

- Slash-command result cards now finalize through the extension's own snapshot timing instead of relying on core to treat hidden custom messages as in-place updates. The final slash snapshot and hidden persisted message are written before the last status-clear redraw, so live `/run`, `/chain`, and `/parallel` cards update to their final state more reliably.
- Added focused slash-command regression coverage for the success/error ordering around visible placeholder messages, hidden final messages, and the final status-clear redraw.

## [0.12.4] - 2026-04-04

### Added

- Added configurable subagent recursion depth controls with global `maxSubagentDepth` config and per-agent `maxSubagentDepth` frontmatter overrides. Child delegation now honors stricter inherited limits while still allowing per-agent tightening.
- Added optional worktree setup hooks via extension config (`worktreeSetupHook`, `worktreeSetupHookTimeoutMs`). Hooks run once per created worktree, receive JSON over stdin, return JSON on stdout, and can declare synthetic helper paths (e.g. `.venv`, copied local config files) to exclude from patch capture.

### Fixed

- Added support for loading agents and skills from `.agents/` and `~/.agents/` directories.
- Switched internal source imports from `.js` to `.ts` so the extension can be loaded directly from TypeScript sources under the strip-types/transform-types runtime path.
- Declared pi runtime packages and `@sinclair/typebox` as peer dependencies so direct source-loading environments fail less often from missing package resolution.
- Single-output runs now preserve agent-written file contents instead of overwriting them with the final assistant receipt, and artifacts/truncation now follow the authoritative saved file content.
- Async/background runs now reuse the current Node executable and prefer the resolved current pi CLI path on all platforms, avoiding PATH drift from wrapped or version-pinned parent launches.

### Changed

- Added release documentation for TypeScript direct-runtime loading support and related package requirements.

## [0.12.2] - 2026-04-04

### Changed

- Bumped pi package devDependencies to `^0.65.0` (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) to stay aligned with current pi SDK/runtime.

## [0.12.1] - 2026-04-03

### Changed

- Updated session lifecycle handling for pi 0.65.0 by removing legacy post-transition resets and relying on `session_start` reinitialization, matching pi's removal of `session_switch` and `session_fork` extension events.

## [0.12.0] - 2026-03-31

### Added

- Added git worktree isolation for parallel execution via `worktree: true`. Applies to top-level parallel `tasks`, chain steps with `{ parallel: [...] }`, and async/background chain execution. Each parallel task gets its own temporary git worktree, and the aggregated output now includes per-task diff stats plus the directory path containing full patch files.
- Added `worktree.ts` to manage worktree lifecycle, diff capture, patch generation, and cleanup for isolated parallel runs.
- Added `count: N` shorthand for top-level parallel `tasks` and chain `parallel` entries so one authored task can expand into repeated identical runs without manual duplication.
- Added `subagent_status({ action: "list" })` to list active async runs with flattened step/member status summaries.
- Added `/subagents-status`, a read-only overlay for active async runs plus recent completed/failed runs with per-run step details. The overlay auto-refreshes while open and preserves the selected run when possible.
- Documented worktree isolation, async status surfaces, and the reorganized test layout in the README.

### Changed

- Consolidated tests under `test/unit`, `test/integration`, `test/e2e`, and `test/support`, replacing the old mixed root-level and `test/` layout. Test scripts now target those directories explicitly.
- Integration tests now use a tiny local file-based mock `pi` harness instead of relying on the external subprocess harness for normal subagent execution.
- Removed legacy extra session lifecycle resets and now rely on immutable-session `session_start` reinitialization, matching pi's removal of post-transition `session_switch`/`session_fork` events.

### Fixed

- Loader-based tests now resolve `.js` → `.ts` imports correctly when the repository path contains spaces or other URL-escaped characters. Added a focused regression test for the custom test loader.
- Worktree-isolated parallel runs now reject task-level `cwd` overrides that differ from the shared batch/step `cwd`, instead of silently ignoring them. Applies to foreground parallel runs, chain parallel steps, and async/background execution.
- Worktree diff capture now includes committed, modified, and newly created files without accidentally including the synthetic `node_modules` symlink used inside temporary worktrees.
- Worktree setup now cleans up already-created worktrees if a later worktree in the same batch fails to initialize.
- Prompt-template delegated parallel responses now preserve the aggregate worktree summary text instead of dropping it when rebuilding the final delegated output.
- Async status and result JSON files are now written atomically so readers do not observe partial JSON during background updates.
- `readStatus()` now returns `null` only for genuinely missing files and preserves real inspect/read/parse failures with context.
- Async status polling and result watching now log status/result/watcher failures instead of silently swallowing them, making background completion/debugging failures visible.
- Slash-command tests now match the current live snapshot contract instead of asserting the stale pre-finalized inline state.

## [0.11.12] - 2026-03-28

### Changed

- Tool history (`recentTools`) in execution progress is now chronological (oldest first) and uncapped, replacing the old newest-first order with a 5-entry cap. Affects all execution paths (tool, slash commands, chains, parallel, async, delegation). Both single-task and chain-step render paths in `render.ts` now consistently use `slice(-3)` for most-recent display.
- Removed 50ms throttle on execution progress updates. `onUpdate` now fires immediately on every tool start, tool end, message end, and tool result. Affects all execution paths.
- Delegation bridge now passes through full `recentOutputLines` arrays, `recentTools` history, and resolved `model` to prompt-template consumers, replacing the old stripped-down single-line updates.

## [0.11.11] - 2026-03-23

### Changed

- Updated for pi 0.62.0 compatibility. `Skill.source` replaced with `Skill.sourceInfo` for skill provenance, `Widget` type replaced with `Component`. Bumped devDependencies to `^0.62.0`.

## [0.11.10] - 2026-03-21

### Changed

- Trimmed tool schema and description to reduce per-turn token cost by ~166 tokens (13%). Removed `maxOutput` from the LLM-facing schema (still accepted internally), shortened `context` and `output` descriptions, removed redundant CHAIN DATA FLOW section from tool description, condensed MANAGEMENT bullet points.

## [0.11.9] - 2026-03-21

### Fixed

- `/agents` overlay launches (single, chain, parallel) and slash commands (`/run`, `/chain`, `/parallel`) now render an inline result card in chat instead of relaying through `sendUserMessage`.
- `/agents` overlay chain launches no longer bypass the executor for async fallback, fixing a path where async chain errors were silently swallowed.

### Changed

- All slash and overlay subagent execution now routes through an event bus request/response protocol (`slash-bridge.ts`), matching the pattern used by pi-prompt-template-model. This replaces both the old `sendUserMessage` relay and the direct `executeChain` call in the overlay handler.
- Slash launches show a live inline card immediately on start that streams current tool, recent tools, and output in real time, rather than appearing only after completion.
- `/parallel` now uses the native `tasks` parameter directly instead of wrapping through `{ chain: [{ parallel: tasks }] }`.

### Added

- `slash-bridge.ts` — event bus bridge for slash command execution. Manages AbortController lifecycle, cancel-before-start races, and progress streaming via `subagent:slash:*` events.
- `slash-live-state.ts` — request-id keyed snapshot store that drives live inline card rendering during execution and restores finalized results from session entries on reload.
- Clarified README Usage section to distinguish LLM tool parameters from user-facing slash commands.

## [0.11.8] - 2026-03-21

### Added

- Prompt-template delegation bridge now supports parallel task execution: accepts `tasks` array payloads, emits per-task `parallelResults` with individual error/success states, and streams per-task progress updates with `taskProgress` entries.

## [0.11.7] - 2026-03-20

### Changed

- Removed the cwd mismatch guard from the prompt-template delegation bridge, allowing delegated requests to specify a working directory different from the active session's cwd.

## [0.11.6] - 2026-03-20

### Added

- Added `delegate` builtin agent — a lightweight subagent with no model, output, or default reads. Inherits the parent session's model, making it the natural target for prompt-template delegated execution.

## [0.11.5] - 2026-03-20

### Added

- Added fork context preamble: tasks run with `context: "fork"` are now wrapped with a default preamble that anchors the subagent to its task, preventing it from continuing the parent conversation. The default is `DEFAULT_FORK_PREAMBLE` in `types.ts`. Internal/programmatic callers can use `wrapForkTask(task, false)` to disable it or pass a custom string (this is not exposed as a tool parameter).
- Added a prompt-template delegation bridge (`prompt-template-bridge.ts`) on the shared extension event bus. The subagent extension now listens for `prompt-template:subagent:request` and emits correlated `started`/`response`/`update` events, with cwd safety checks and race-safe cancellation handling.
- Added delegated progress streaming via `prompt-template:subagent:update`, mapped from subagent executor `onUpdate` progress payloads.

### Changed

- Session lifecycle reset now preserves the latest extension context for event-bus delegated runs.
- `[fork]` badge is now shown only on the result row, not duplicated on both the tool-call and result rows.

## [0.11.4] - 2026-03-19

### Added

- Added explicit execution context mode for tool calls: `context: "fresh" | "fork"` (default: `fresh`).
- Added true forked-context execution for single, parallel, and chain runs. In `fork` mode each child run now starts from a real branched session file created from the parent session's current leaf.
- Added `--fork` slash-command flag for `/run`, `/chain`, and `/parallel` to forward `context: "fork"`.
- Added regression coverage for fork execution/session wiring and fork badge rendering, including slash command forwarding tests.

### Changed

- Session argument wiring now supports `--session <file>` in addition to `--session-dir`, enabling exact leaf-preserving forks without summary injection.
- Async runner step payloads now carry per-step session files so background single/chain/parallel executions can also honor `context: "fork"`.
- Clarified docs for foreground vs background semantics so `--bg` behavior is explicit.

### Fixed

- `context: "fork"` now fails fast with explicit errors when parent session state is unavailable (missing persisted session, missing current leaf, or failed branch extraction), with no silent fallback to `fresh`.
- Fork-session creation errors are now surfaced as tool errors instead of bubbling as uncaught exceptions during execution.
- Session directory preparation now fails loudly with actionable errors (instead of silently swallowing mkdir failures).
- Async launch now fails with explicit errors when the async run directory cannot be created.
- Share logs now correctly include forked session files even when no session directory exists.
- Tool-call and result rendering now explicitly show `[fork]` when `context: "fork"` is used, including empty-result responses.
- `subagent_status` now surfaces async result-file read failures instead of returning a misleading missing-status message.

## [0.11.3] - 2026-03-17

### Changed

- Decomposed `index.ts` (1,450 → ~350 lines) into focused modules: `subagent-executor.ts`, `async-job-tracker.ts`, `result-watcher.ts`, `slash-commands.ts`. Shared mutable state centralized in `SubagentState` interface. Three identical session handlers collapsed into one.
- Extracted shared pi CLI arg-builder (`pi-args.ts`) from duplicated logic in `execution.ts` and `subagent-runner.ts`.
- Consolidated `mapConcurrent` (canonical in `parallel-utils.ts`, re-exported from `utils.ts`), `aggregateParallelOutputs` (canonical in `parallel-utils.ts` with optional header formatter, re-exported from `settings.ts`), and `parseFrontmatter` (extracted to `frontmatter.ts`).

## [0.11.2] - 2026-03-11

### Fixed

- `--no-skills` was missing from the async runner (`subagent-runner.ts`). PR #41 added skill scoping to the sync path but the async runner spawns pi through its own code path, so background subagents with explicit skills still got the full `<available_skills>` catalog injected.
- `defaultSessionDir` and `sessionDir` with `~` paths (e.g. `"~/.pi/agent/sessions/subagent/"`) were not expanded — `path.resolve("~/...")` treats `~` as a literal directory name. Added tilde expansion matching the existing pattern in `skills.ts`.
- Multiple subagent calls within a session would collide when `defaultSessionDir` was configured, since it wasn't appending a unique `runId`. Both `defaultSessionDir` and parent-session-derived paths now get `runId` appended.

### Removed

- Removed exported `resolveSessionRoot()` function and `SessionRootInput` interface. These were introduced by PR #46 but never called in production — the inline resolution logic diverged (always-on sessions, `runId` appended) making the function's contract misleading. Associated tests and dead code from PR #47 scaffolding also removed from `path-handling.test.ts`.

## [0.11.1] - 2026-03-08

### Changed

- **Session persistence**: Subagent sessions are now stored alongside the parent session file instead of in `/tmp`. If the parent session is `~/.pi/agent/sessions/abc123.jsonl`, subagent sessions go to `~/.pi/agent/sessions/abc123/{runId}/run-{N}/`. This enables tracking subagent performance over time, analyzing token usage patterns, and debugging past delegations. Falls back to a unique temp directory when no parent session exists (API/headless mode).

## [0.11.0] - 2026-02-23

### Added

- **Background mode toggle in clarify TUI**: Press `b` to toggle background/async execution for any mode (single, parallel, chain). Shows `[b]g:ON` in footer when enabled. Previously async execution required programmatic `clarify: false, async: true` — now users can interactively choose background mode after previewing/editing parameters.
- **`--bg` flag for slash commands**: `/run scout "task" --bg`, `/chain scout "task" -> planner --bg`, `/parallel scout "a" -> scout "b" --bg` now run in background without needing the TUI.

### Fixed

- Task edits in clarify TUI were lost when launching in background mode if no other behavior (model, output, reads) was modified. The async handoff now always applies the edited template.

## [0.10.0] - 2026-02-23

### Added

- **Async parallel chain support**: Chains with `{ parallel: [...] }` steps now work in async mode. Previously they were rejected with "Async mode doesn't support chains with parallel steps." The async runner now spawns concurrent pi processes for parallel step groups with configurable `concurrency` and `failFast` options. Inspired by PR #31 from @marcfargas.
- **Comprehensive test suite**: 85 integration tests and 12 E2E tests covering all execution modes (single, parallel, chain, async), error handling, template resolution, and tool validation. Uses `@marcfargas/pi-test-harness` for subprocess mocking and in-process session testing. Thanks @marcfargas for PR #32.
- GitHub Actions CI workflow running tests on both Ubuntu and Windows with Node.js 24.

### Changed

- **BREAKING:** `share` parameter now defaults to `false`. Previously, sessions were silently uploaded to GitHub Gists without user consent. Users who want session sharing must now explicitly pass `share: true`. Added documentation explaining what the feature does and its privacy implications.

### Fixed

- `mapConcurrent` with `limit=0` returned array of undefined values instead of processing items sequentially. Now clamps limit to at least 1.
- ANSI background color bleed in truncated text. The `truncLine` function now properly tracks and re-applies all active ANSI styles (bold, colors, etc.) before the ellipsis, preventing style leakage. Also uses `Intl.Segmenter` for correct Unicode/emoji handling. Thanks @monotykamary for identifying the issue.
- `detectSubagentError` no longer produces false positives when the agent recovers from tool errors. Previously, any error in the last tool result would override exitCode 0→1, even if the agent had already produced complete output. Now only errors AFTER the agent's final text response are flagged. Thanks @marcfargas for the fix and comprehensive test coverage.
- Parallel mode (`tasks: [...]`) now returns aggregated output from all tasks instead of just a success count. Previously only returned "3/3 succeeded" with actual task outputs lost.
- Session sharing fallback no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The fallback now resolves the main entry point and walks up to find the package root instead of trying to resolve `package.json` directly.
- Skills from globally-installed npm packages (via `pi install npm:...`) are now discoverable by subagents. Previously only scanned local `.pi/npm/node_modules/` paths, missing the global npm root where pi actually installs packages.
- **Windows compatibility**: Fixed `ENAMETOOLONG` errors when tasks exceed command-line length limits by writing long tasks to temp files using pi's `@file` syntax. Thanks @marcfargas.
- **Windows compatibility**: Suppressed flashing console windows when spawning async runner processes (`windowsHide: true`).
- **Windows compatibility**: Fixed pi CLI resolution in async runner by passing `piPackageRoot` through to `getPiSpawnCommand`.
- **Cross-platform paths**: Replaced `startsWith("/")` checks with `path.isAbsolute()` for correct Windows absolute path detection. Replaced template string path concatenation with `path.join()` for consistent path separators.
- **Resilience**: Added error handling and auto-restart for the results directory watcher. Previously, if the directory was deleted or became inaccessible, the watcher would die silently.
- **Resilience**: Added `ensureAccessibleDir` helper that verifies directory accessibility after creation and attempts recovery if the directory has broken ACLs (can happen on Windows with Azure AD/Entra ID after wake-from-sleep).

## [0.9.2] - 2026-02-19

### Fixed

- TUI crash on async subagent completion: "Rendered line exceeds terminal width." `render.ts` never truncated output to fit the terminal — widget lines (`agents.join(" -> ")`), chain visualizations, skills lists, and task previews could all exceed the terminal width. Added `truncLine` helper using pi-tui's `truncateToWidth`/`visibleWidth` and applied it to every `Text` widget and widget string. Task preview lengths are now dynamic based on terminal width instead of hardcoded.
- Agent Manager scope badge showed `[built]` instead of `[builtin]` in list and detail views. Widened scope column to fit.

## [0.9.1] - 2026-02-17

### Fixed

- Builtin agents were silently excluded from management listings, chain validation, and agent resolution. Added `allAgents()` helper that includes all three tiers (builtin, user, project) and applied it to `handleList`, `findAgents`, `availableNames`, and `unknownChainAgents`.
- `resolveTarget` now blocks mutation of builtin agents with a clear error message suggesting the user create a same-named override, instead of allowing `fs.unlinkSync` or `fs.writeFileSync` on extension files.
- Agent Manager TUI guards: delete and edit actions on builtin agents are blocked with an error status. Detail screen hides `[e]dit` from the footer for builtins. Scope badge shows `[builtin]` instead of falling through to `[proj]`.
- Cloning a builtin agent set the scope to `"builtin"` at runtime (violating the `"user" | "project"` type), causing wrong badge display and the clone inheriting builtin protections until session reload. Now maps to `"user"`.
- Agent Manager `loadEntries` suppresses builtins overridden by user/project agents, preventing duplicate entries in the TUI list.
- `BUILTIN_AGENTS_DIR` resolved via `import.meta.url` instead of hardcoded `~/.pi/agent/extensions/subagent/agents` path. Works regardless of where the extension is installed.
- `handleCreate` now warns when creating an agent that shadows a builtin (informational, not an error).

### Changed

- Simplified Agent Manager header from per-scope breakdown to total count (per-row badges already show scope).
- Reviewer builtin model changed from `openai/gpt-5.2` to `openai-codex/gpt-5.3-codex`.
- Removed `code-reviewer` builtin agent (redundant with `reviewer`).

## [0.9.0] - 2026-02-17

### Added

- **Builtin agents** — the extension now ships with a default set of agent definitions in `agents/`. These are loaded with lowest priority so user and project agents always override them. New users get a useful set of agents out of the box without manual setup.
  - `scout` — fast codebase recon (claude-haiku-4-5)
  - `planner` — implementation plans from context (claude-opus-4-6, thinking: high)
  - `worker` — general-purpose execution (claude-sonnet-4-6)
  - `reviewer` — validates implementation against plans (gpt-5.3-codex, thinking: high)
  - `context-builder` — analyzes requirements and codebase (claude-sonnet-4-6)
  - `researcher` — autonomous web research with search, evaluation, and synthesis (claude-sonnet-4-6)
- **`"builtin"` agent source** — new third tier in agent discovery. Priority: builtin < user < project. Builtin agents appear in listings with a `[builtin]` badge and cannot be modified or deleted through management actions (create a same-named user agent to override instead).

### Fixed

- Async subagent session sharing no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The runner tried `require.resolve("@earendil-works/pi-coding-agent/package.json")` to find pi's HTML export module, but pi's `exports` map doesn't include that subpath. The fix resolves the package root in the main pi process by walking up from `process.argv[1]` and passes it to the spawned runner through the config, bypassing `require.resolve` entirely. The Windows CLI resolution fallback in `getPiSpawnCommand` benefits from the same walk-up function.

## [0.8.5] - 2026-02-16

### Fixed

- Async subagent execution no longer fails with "jiti not found" on machines without a global `jiti` install. The jiti resolution now tries three strategies: vanilla `jiti`, the `@earendil-works/jiti` fork, and finally resolves `@earendil-works/jiti` from pi's own installation via `process.argv[1]`. Since pi always ships the fork as a dependency, async mode now works out of the box.
- Improved the "jiti not found" error message to explain what's needed and how to fix it.

## [0.8.4] - 2026-02-13

### Fixed

- JSONL artifact files no longer written by default — they duplicated pi's own session files and were the sole cause of `subagent-artifacts` directories growing to 10+ GB. Changed `includeJsonl` default from `true` to `false`. `_output.md` and `_meta.json` still capture the useful data.
- Artifact cleanup now covers session-based directories, not just the temp dir. Previously `cleanupOldArtifacts` only ran on `os.tmpdir()/pi-subagent-artifacts` at startup, while sync runs (the common path) wrote to `<session-dir>/subagent-artifacts/` which was never cleaned. Now scans all `~/.pi/agent/sessions/*/subagent-artifacts/` dirs on startup and cleans the current session's artifacts dir on session lifecycle events.
- JSONL writer now enforces a 50 MB size cap (`maxBytes` on `JsonlWriterDeps`) as defense-in-depth for users who opt into JSONL. Silently stops writing at the cap without pausing the source stream, so the progress tracker keeps working.

## [0.8.3] - 2026-02-11

### Added

- Agent `extensions` frontmatter support for extension sandboxing: absent field keeps default extension discovery, empty value disables all extensions, and comma-separated values create an explicit extension allowlist.

### Fixed

- Parallel chain aggregation now surfaces step failures and warnings in `{previous}` instead of silently passing empty output.
- Empty-output warnings are now context-aware: runs that intentionally write to explicit output paths are not flagged as warning-only successes in the renderer.
- Async execution now respects agent `extensions` sandbox settings, matching sync behavior.
- Single-mode `output` now resolves explicit paths correctly: absolute paths are used directly, and relative paths resolve against `cwd`.
- Single-mode output persistence is now caller-side in both sync and async execution, so output files are still written when agents run with read-only tools.
- Pi process spawning now uses a shared cross-platform helper in sync and async paths; on Windows it prefers direct Node + CLI invocation to avoid `ENOENT` and argument fragmentation.
- Sync JSONL artifact capture now streams lines directly to disk with backpressure handling, preventing unbounded memory growth in long or parallel runs.
- Execution now defaults `agentScope` to `both`, aligning run behavior with management `list` so project agents shown in discovery execute without explicit scope overrides.
- Async completion notifications now dedupe at source and notify layers, eliminating duplicate/triple "Background task completed" messages.
- Async notifications now standardize on canonical `subagent:started` and `subagent:complete` events (legacy enhanced event emissions removed).

### Changed

- Reworked `skills.ts` to resolve skills through Pi core skill loading with explicit project-first precedence and support for project/user package and settings skill paths.
- Skill discovery now normalizes and prioritizes collisions by source so project-scoped skills consistently win over user-scoped skills.
- Documentation now references `<tmpdir>` instead of hardcoded `/tmp` paths for cross-platform clarity.

## [0.8.2] - 2026-02-11

### Added

- Recursion depth guard (`PI_SUBAGENT_MAX_DEPTH`) to prevent runaway nested subagent spawning. Default max depth is 2 (main -> subagent -> sub-subagent). Deeper calls are blocked with guidance to the calling agent.

## [0.8.1] - 2026-02-10

### Added

- **`chainDir` param** for persistent chain artifacts — specify a directory to keep artifacts beyond the default 24-hour temp-directory cleanup. Relative paths are resolved to absolute via `path.resolve()` for safe use in `{chain_dir}` template substitutions.

## [0.8.0] - 2026-02-09

### Added

- **Management mode for `subagent` tool** via `action` field — the LLM can now discover, create, modify, and delete agent/chain definitions at runtime without manual file editing or restarts. Five actions:
  - `list` — discover agents and chains with scope + description
  - `get` — full detail for agent or chain, including path and system prompt/steps
  - `create` — create agent (`.md`) or chain (`.chain.md`) definitions from `config`; immediately usable
  - `update` — merge-update agent or chain fields, including rename with chain reference warnings
  - `delete` — remove agent or chain definitions with dangling reference warnings
- **New `agent-management.ts` module** with all management handlers, validation, and serialization helpers
- **New management params** in tool schema: `action`, `chainName`, `config`
- **Agent/chain CRUD safeguards**
  - Name sanitization (lowercase-hyphenated) for create/rename
  - Scope-aware uniqueness checks across agents and chains
  - File-path collision checks to prevent overwriting non-agent markdown files
  - Scope disambiguation for update/delete when names exist in both user and project scope
  - Not-found errors include available names for fast self-correction
  - Per-step validation warnings for model registry and skill availability
  - Validate-then-mutate ordering — all validation completes before any filesystem mutations
- **Config field mapping**: `tools` (comma-separated with `mcp:` prefix support), `reads` -> `defaultReads`, `progress` -> `defaultProgress`
- **Uniform field clearing** — all optional string fields accept both `false` and `""` to clear
- **JSON string parsing for `config` param** — handles `Type.Any()` delivering objects as JSON strings through the tool framework

## [0.7.0] - 2026-02-09

### Added

- **Agents Manager overlay** — browse, view, edit, create, and delete agent definitions from a TUI opened via `Ctrl+Shift+A` or the `/agents` command
  - List screen with search/filter, scope badges (user/project), chain badges
  - Detail screen showing resolved prompt, recent runs, all frontmatter fields
  - Edit screen with field-by-field editing, model picker, skill picker, thinking picker, full-screen prompt editor
  - Create from templates (Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain)
  - Delete with confirmation
  - Launch directly from overlay with task input and skip-clarify toggle (`Tab`)
- **Chain files** — `.chain.md` files define reusable multi-step chains with YAML-style frontmatter per step, stored alongside agent `.md` files
  - Chain serializer with round-trip parse/serialize fidelity
  - Three-state config semantics: `undefined` (inherit), value (override), `false` (disable)
  - Chain detail screen with flow visualization and dependency map
  - Chain edit screen (raw file editing)
  - Create new chains from the template picker or save from the chain-clarify TUI (`W`)
- **Save overrides from clarify TUI** — press `S` to persist model/output/reads/skills/progress overrides back to the agent's frontmatter file, or `W` (chain mode) to save the full chain configuration as a `.chain.md` file
- **Multi-select and parallel from overlay** — select agents with `Tab`, then `Ctrl+R` for sequential chain or `Ctrl+P` to open the parallel builder
  - Parallel builder: add same agent multiple times, set per-slot task overrides, shared task input
  - Progressive footer: 0 selected (default hints), 1 selected (`[ctrl+r] run [ctrl+p] parallel`), 2+ selected (`[ctrl+r] chain [ctrl+p] parallel`)
  - Selection count indicator in footer
- **Slash commands with per-step tasks** — `/run`, `/chain`, and `/parallel` execute subagents with full live progress rendering and tab-completion. Results are sent to the conversation for the LLM to discuss.
  - Per-step tasks with quotes: `/chain scout "scan code" -> planner "analyze auth"`
  - Per-step tasks for parallel: `/parallel scanner "find bugs" -> reviewer "check style"`
  - `--` delimiter also supported: `/chain scout -- scan code -> planner -- analyze auth`
  - Shared task (no `->`): `/chain scout planner -- shared task`
  - Tab completion for agent names, aware of task sections (quotes and `--`)
  - Inline per-step config: `/chain scout[output=ctx.md] "scan code" -> planner[reads=ctx.md] "analyze auth"`
  - Supported keys: `output`, `reads` (`+` separates files), `model`, `skills`, `progress`
  - Works on all three commands: `/run agent[key=val]`, `/chain`, `/parallel`
- **Run history** — per-agent JSONL recording of task, exit code, duration, timestamp
  - Recent runs shown on agent detail screen (last 5)
  - Lazy JSONL rotation (keeps last 1000 entries)
- **Thinking level as first-class agent field** — `thinking` frontmatter field (off, minimal, low, medium, high, xhigh) editable in the Agents Manager
  - Picker with arrow key navigation and level descriptions
  - At runtime, appended as `:level` suffix to the model string
  - Existing suffix detection prevents double-application
  - Displayed on agent detail screen

### Fixed

- **Parallel live progress** — top-level parallel execution (`tasks: [...]`) now shows live progress for all concurrent tasks. Each task's `onUpdate` updates its slot in a shared array and emits a merged view, so the renderer can display per-task status, current tools, recent output, and timing in real time. Previously only showed results after all tasks completed.
- **Slash commands frozen with no progress** — `/run`, `/chain`, and `/parallel` called `runSync`/`executeChain` directly, bypassing the tool framework. No `onUpdate` meant zero live progress, and `await`-ing execution blocked the command handler, making inputs unresponsive. Now all three route through `sendToolCall` → LLM → tool handler, getting full live progress rendering and responsive input for free.
- **`/run` model override silently dropped** — `/run scout[model=gpt-4o] task` now correctly passes the model through to the tool handler. Added `model` field to the tool schema for single-agent runs.
- **Quoted tasks with `--` inside split incorrectly** — the segment parser now checks for quoted strings before the `--` delimiter, so tasks like `scout "analyze login -- flow"` parse correctly instead of splitting on the embedded `--`.
- **Chain first-step validation in per-step mode** — `/chain scout -> planner "task"` now correctly errors instead of silently assigning planner's task to scout. The first step must have its own task when using `->` syntax.
- **Thinking level ignored in async mode** — `async-execution.ts` now applies thinking suffix to the model string before serializing to the runner, matching sync behavior
- **Step-level model override ignored in async mode** — `executeAsyncChain` now uses `step.model ?? agent.model` as the base for thinking suffix, matching the sync path in `chain-execution.ts`
- **mcpDirectTools not set in async mode** — `subagent-runner.ts` now sets `MCP_DIRECT_TOOLS` env var per step, matching the sync path in `execution.ts`
- **`{task}` double-corruption in saved chain launches** — stopped pre-replacing `{task}` in the overlay launch path; raw user task passed as top-level param to `executeChain()`, which uses `params.task` for `originalTask`
- **Agent serializer `skill` normalization** — `normalizedField` now maps `"skill"` to `"skills"` on the write path
- **Clarify toggle determinism** — all four ManagerResult paths (single, chain, saved chain, parallel) now use deterministic JSON with `clarify: !result.skipClarify`, eliminating silent breakage from natural language variants

### Changed

- Agents Manager single-agent and saved-chain launches default to quick run (skip clarify TUI) — the user already reviewed config in the overlay. Multi-agent ad-hoc chains default to showing the clarify TUI so users can configure per-step tasks, models, output files, and skills before execution. Toggle with `Tab` in the task-input screen.
- Extracted `applyThinkingSuffix(model, thinking)` helper from inline logic in `execution.ts`, shared with `async-execution.ts`
- Text editor: added word navigation (Alt+Left/Right, Ctrl+Left/Right), word delete (Alt+Backspace), paste support
- Agent discovery (`agents.ts`): loads `.chain.md` files via `loadChainsFromDir`, exposes `discoverAgentsAll` for overlay

## [0.6.0] - 2026-02-02

### Added

- **MCP direct tools for subagents** - Agents can request specific MCP tools as first-class tools via `mcp:` prefix in frontmatter: `tools: read, bash, mcp:chrome-devtools` or `tools: read, bash, mcp:github/search_repositories`. Requires pi-mcp-adapter.
- **`MCP_DIRECT_TOOLS` env var** - Subagent processes receive their direct tool config via environment variable. Agents without `mcp:` items get a `__none__` sentinel to prevent config leaking from the parent process.

## [0.5.3] - 2026-02-01

### Fixed

- Adapt execute signatures to pi v0.51.0: reorder signal, onUpdate, ctx parameters for subagent tool; add missing parameters to subagent_status tool

## [0.5.2] - 2026-01-28

### Improved

- **README: Added agent file locations** - New "Agents" section near top of README clearly documents:
  - User agents: `~/.pi/agent/agents/{name}.md`
  - Project agents: `.pi/agents/{name}.md` (searches up directory tree)
  - `agentScope` parameter explanation (`"user"`, `"project"`, `"both"`)
  - Complete frontmatter example with all fields
  - Note about system prompt being the markdown body after frontmatter

## [0.5.1] - 2026-01-27

### Fixed

- Google API compatibility: Use `Type.Any()` for mixed-type unions (`SkillOverride`, `output`, `reads`, `ChainItem`) to avoid unsupported `anyOf`/`const` JSON Schema patterns

## [0.5.0] - 2026-01-27

### Added

- **Skill support** - Agents can declare skills in frontmatter that get injected into system prompts
  - Agent frontmatter: `skill: tmux, chrome-devtools` (comma-separated)
  - Runtime override: `skill: "name"` or `skill: false` to disable all skills
  - Chain-level skills additive to agent skills, step-level override supported
  - Skills injected as XML: `<skill name="...">content</skill>` after agent system prompt
  - Missing skills warn but continue execution (warning shown in result summary)
- **TUI skill selector** - Press `[s]` to browse and select skills for any step
  - Multi-select with space bar
  - Fuzzy search by name or description
  - Shows skill source (project/user) and description
  - Project skills (`.pi/skills/`) override user skills (`~/.pi/agent/skills/`)
- **Skill display** - Skills shown in TUI, progress tracking, summary, artifacts, and async status
- **Parallel task skills** - Each parallel task can specify its own skills via `skill` parameter

### Fixed

- **Chain summary formatting** - Fixed extra blank line when no skills are present
- **Duplicate skill deduplication** - `skill: "foo,foo"` now correctly deduplicates to `["foo"]`
- **Consistent skill tracking in async mode** - Both chain and single modes now track only resolved skills

## [0.4.1] - 2026-01-26

### Changed

- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [0.4.0] - 2026-01-25

### Added

- **Clarify TUI for single and parallel modes** - Use `clarify: true` to preview/edit before execution
  - Single mode: Edit task, model, thinking level, output file
  - Parallel mode: Edit each task independently, model, thinking level
  - Navigate between parallel tasks with ↑↓
- **Mode-aware TUI headers** - Header shows "Agent: X" for single, "Parallel Tasks (N)" for parallel, "Chain: X → Y" for chains
- **Model override for single/parallel** - TUI model selection now works for all modes

### Fixed

- **MAX_PARALLEL error mode** - Now correctly returns `mode: 'parallel'` (was incorrectly `mode: 'single'`)
- **`output: true` handling** - Now correctly treats `true` as "use agent's default output" instead of creating a file literally named "true"

### Changed

- **Schema description** - `clarify` parameter now documents all modes: "default: true for chains, false for single/parallel"

## [0.3.3] - 2026-01-25

### Added

- **Thinking level selector in chain TUI** - Press `[t]` to set thinking level for any step
  - Options: off, minimal, low, medium, high, xhigh (ultrathink)
  - Appends to model as suffix (e.g., `anthropic/claude-sonnet-4-5:high`)
  - Pre-selects current thinking level if already set
- **Model selector in chain TUI** - Press `[m]` to select a different model for any step
  - Fuzzy search through all available models
  - Shows the current model with a `current` badge
  - Provider/model format (e.g., `anthropic/claude-haiku-4-5`)
  - Override indicator (✎) when model differs from agent default
- **Model visibility in chain execution** - Shows which model each step is using
  - Display format: `Step 1: scout (claude-haiku-4-5) | 3 tools, 16.8s`
  - Model shown in both running and completed steps
- **Auto-propagate output changes to reads** - When you change a step's output filename,
  downstream steps that read from it are automatically updated to use the new filename
  - Maintains chain dependencies without manual updates
  - Example: Change scout's output from `context.md` to `summary.md`, planner's reads updates automatically

### Changed

- **Progress is now chain-level** - `[p]` toggles progress for ALL steps at once
  - Progress setting shown at chain level (not per-step)
  - Chains share a single progress.md, so chain-wide toggle is more intuitive
- **Clearer output/writes labeling** - Renamed `output:` to `writes:` to clarify it's a file
  - Hotkey changed from `[o]` to `[w]` for consistency
- **{previous} data flow indicator** - Shows on the PRODUCING step (not receiving):
  - `↳ response → {previous}` appears after scout's reads line
  - Only shows when next step's template uses `{previous}`
  - Clearer mental model: output flows DOWN the chain
- Chain TUI footer updated: `[e]dit [m]odel [t]hinking [w]rites [r]eads [p]rogress`

### Fixed

- **Chain READ/WRITE instructions now prepended** - Instructions restructured:
  - `[Read from: /path/file.md]` and `[Write to: /path/file.md]` prepended BEFORE task
  - Overrides any hardcoded filenames in task text from parent agent
  - Previously: instructions were appended at end and could be overlooked
- **Output file validation** - After each step, validates expected file was created:
  - If missing, warns: "Agent wrote to different file(s): X instead of Y"
  - Helps diagnose when agents don't create expected outputs
- **Root cause: agents need `write` tool** - Agents without `write` in their tools list
  cannot create output files (they tried MCP workarounds which failed)
- **Thinking level suffixes now preserved** - Models with thinking levels (e.g., `claude-sonnet-4-5:high`)
  now correctly resolve to `anthropic/claude-sonnet-4-5:high` instead of losing the provider prefix

### Improved

- **Per-step progress indicators** - When progress is enabled, each step shows its role:
  - Step 1: `writes progress.md`
  - Step 2+: `reads progress.md`
  - Clear visualization of progress.md data flow through the chain
- **Comprehensive tool descriptions** - Better documentation of chain variables:
  - Tool description now explains `{task}`, `{previous}`, `{chain_dir}` in detail
  - Schema descriptions clarify what each variable means and when to use them
  - Helps agents construct proper chain queries for any use case

## [0.3.2] - 2026-01-25

### Performance

- **4x faster polling** - Reduced poll interval from 1000ms to 250ms (efficient with mtime caching)
- **Mtime-based caching** - status.json and output tail reads cached to avoid redundant I/O
- **Unified throttled updates** - All onUpdate calls consolidated under 50ms throttle
- **Widget change detection** - Hash-based change detection skips no-op re-renders
- **Array optimizations** - Use concat instead of spread for chain progress updates

### Fixed

- **Timer leaks** - Track and clear pendingTimer and cleanupTimers properly
- **Updates after close** - processClosed flag prevents updates after process terminates
- **Session cleanup** - Clear cleanup timers on session_start/switch/branch/shutdown

## [0.3.1] - 2026-01-24

### Changed

- **Major code refactor** - Split monolithic index.ts into focused modules:
  - `execution.ts` - Core runSync function for single agent execution
  - `chain-execution.ts` - Chain orchestration (sequential + parallel steps)
  - `async-execution.ts` - Async/background execution support
  - `render.ts` - TUI rendering (widget, tool result display)
  - `schemas.ts` - TypeBox parameter schemas
  - `formatters.ts` - Output formatting utilities
  - `utils.ts` - Shared utility functions
  - `types.ts` - Shared type definitions and constants

### Fixed

- **Expanded view visibility** - Running chains now properly show:
  - Task preview (truncated to 80 chars) for each step
  - Recent tools fallback when between tool calls
  - Increased recent output from 2 to 3 lines
- **Progress matching** - Added agent name fallback when index doesn't match
- **Type safety** - Added defensive `?? []` for `recentOutput` access on union types

## [0.3.0] - 2026-01-24

### Added

- **Full edit mode for chain TUI** - Press `e`, `o`, or `r` to enter a full-screen editor with:
  - Word wrapping for long text that spans multiple display lines
  - Scrolling viewport (12 lines visible) with scroll indicators (↑↓)
  - Full cursor navigation: Up/Down move by display line, Page Up/Down by viewport
  - Home/End go to start/end of current display line, Ctrl+Home/End for start/end of text
  - Auto-scroll to keep cursor visible
  - Esc saves, Ctrl+C discards changes

### Improved

- **Tool description now explicitly shows the three modes** (SINGLE, CHAIN, PARALLEL) with syntax - helps agents pick the right mode when user says "scout → planner"
- **Chain execution observability** - Now shows:
  - Chain visualization with status labels: `done scout → running planner` (`done`, `running`, `pending`, `failed`) - sequential chains only
  - Accurate step counter: "step 1/2" instead of misleading "1/1"
  - Current tool and recent output for running step

## [0.2.0] - 2026-01-24

### Changed

- **Rebranded to `pi-subagents`** (was `pi-async-subagents`)
- Now installable via `npx pi-subagents`

### Added

- Chain TUI now supports editing output paths, reads lists, and toggling progress per step
- New keybindings: `o` (output), `r` (reads), `p` (progress toggle)
- Output and reads support full file paths, not just relative to chain_dir
- Each step shows all editable fields: task, output, reads, progress

### Fixed

- Chain clarification TUI edit mode now properly re-renders after state changes (was unresponsive)
- Changed edit shortcut from Tab to 'e' (Tab can be problematic in terminals)
- Edit mode cursor now starts at beginning of first line for better UX
- Footer shows context-sensitive keybinding hints for navigation vs edit mode
- Edit mode is now single-line only (Enter disabled) - UI only displays first line, so multi-line was confusing
- Added Ctrl+C in edit mode to discard changes (Esc saves, Ctrl+C discards)
- Footer now shows "Done" instead of "Save" for clarity
- Absolute paths for output/reads now work correctly (were incorrectly prepended with chainDir)

### Added

- Parallel-in-chain execution with `{ parallel: [...] }` step syntax for fan-out/fan-in patterns
- Configurable concurrency and fail-fast options for parallel steps
- Output aggregation with clear separators (`=== Parallel Task N (agent) ===`) for `{previous}`
- Namespaced artifact directories for parallel tasks (`parallel-{step}/{index}-{agent}/`)
- Pre-created progress.md for parallel steps to avoid race conditions

### Changed

- TUI clarification skipped for chains with parallel steps (runs directly in sync mode)
- Async mode rejects chains with parallel steps with clear error message
- Chain completion now returns summary blurb with progress.md and artifacts paths instead of raw output

### Added

- Live progress display for sync subagents (single and chain modes)
- Shows current tool, recent output lines, token count, and duration during execution
- Ctrl+O hint during sync execution to expand full streaming view
- Throttled updates (150ms) for smoother progress display
- Updates on tool_execution_start/end events for more responsive feedback

### Fixed

- Async widget elapsed time now freezes when job completes instead of continuing to count up
- Progress data now correctly linked to results during execution (was showing "ok" instead of "...")

### Added

- Extension API support (registerTool) with `subagent` tool name
- Session logs (JSONL + HTML export) and optional share links via GitHub Gist
- `share` and `sessionDir` parameters for session retention control
- Async events: `subagent:started`/`subagent:complete` (legacy events still emitted)
- Share info surfaced in TUI and async notifications
- Async observability folder with `status.json`, `events.jsonl`, and `subagent-log-*.md`
- `subagent_status` tool for inspecting async run state
- Async TUI widget for background runs

### Changed

- Parallel mode auto-downgrades to sync when async:true is passed (with note in output)
- TUI now shows "parallel (no live progress)" label to set expectations
- Tools passed via agent config can include extension paths (forwarded via `--extension`)

### Fixed

- Chain mode now sums step durations instead of taking max (was showing incorrect total time)
- Async notifications no longer leak across pi sessions in different directories

## [0.1.0] - 2026-01-03

Initial release forked from async-subagent example.

### Added

- Output truncation with configurable byte/line limits
- Real-time progress tracking (tools, tokens, duration)
- Debug artifacts (input, output, JSONL, metadata)
- Session-tied artifact storage for sync mode
- Per-step duration tracking for chains
