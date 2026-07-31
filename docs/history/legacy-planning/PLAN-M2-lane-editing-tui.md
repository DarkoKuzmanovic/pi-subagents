# PLAN — M2 lane-editing TUI

## Goal
Ship M2 as a first-class `/subagents` TUI for staged, user-scope lane creation, rename, model/thinking edits, and deletion without changing lane dispatch semantics or replacing the JSON control plane.

## Attributes
- Language/framework: ESM TypeScript Pi extension using `ExtensionAPI`, `ctx.ui.custom`, `@earendil-works/pi-tui`, and Node's built-in test runner
- Blast radius: medium — user-settings lane storage, the existing `/subagents` overlay and slash handler, focused tests, documentation, and release metadata; no runtime dispatch files or schema semantics change
- Safety sensitivity: high — `~/.pi/agent/settings.json` is a protected configuration boundary and malformed or unrelated settings must never be clobbered

## Scope Decision
- **Tier:** Standard
- **Risk:** contained protected — the TUI is additive, but its deferred result mutates user settings. Project settings remain read-only, and lane resolution/precedence/fallback remain untouched.
- **Delivery:** local, four outcome waves. Workers do not commit; the orchestrator owns staging, the deep review, versioning, roadmap graduation, and close-out.
- **Evidence:** focused store and component tests per outcome; slash-command integration coverage; unchanged lane-resolution integration tests; then `typecheck`, full unit, and full integration gates run separately. One fresh deep combined review is mandatory because the user-settings writer is protected.

### Boundaries

**In scope**
- User-scope `subagents.modelLanes` create, rename, model/thinking edit, and delete.
- Read-only display of project lanes, including project-over-user shadowing.
- Staged/deferred persistence after the overlay closes.
- Existing `/subagents config|json|edit` as the transparent JSON fallback.

**Out of scope**
- Dispatch, lane resolution, project-over-user precedence, unknown-lane errors, fallback behavior, schemas, and task routing.
- Project-scope writes, new lane fields, automatic lane selection, or replacement of the JSON editor shortcut.
- Reintroducing `easy/medium/hard`; fresh skeleton examples remain `worker.normal` and `worker.hard`.

## Resolved Design Decisions

- **(a) Unsupported thinking levels:** Omit unsupported canonical levels, matching the existing thinking view; include an `inherit` choice for removing a lane override, show an existing unsupported value as a warning without dirtying it, and apply the existing `off`-else-first-supported clamp only when the model changes.
- **(b) Shadowed lanes:** Render separate project and user rows for the same lane name: project is labeled `effective · read-only`, while user is labeled `shadowed by project`; the shadowed user row remains editable/deletable, with an explanation that project resolution still wins.
- **(c) Deletion confirmation:** Reuse the two-option `SelectList` confirmation and default selection to Cancel; typing the lane name adds disproportionate friction for a reversible, staged deletion.
- **(d) Keybindings:** Main: `l` lanes. Lane list (non-searchable `SelectList`): `enter` details, `n` new, `d` delete, `u` lane undo, `esc` agents. User lane detail: `m` model, `t` thinking, `r` rename, `esc` lanes. Name/model/thinking/confirmation views retain `enter`, `esc`, and `ctrl+c` semantics. Footers must show exactly the active view's bindings.
- **(e) Undo:** Use a separate `laneUndoStack` and lane snapshot transaction type. Main-view `u` continues to undo only override resets; lane-list `u` undoes only the latest staged lane add/edit/rename/delete.
- **(f) First lane:** Allow `n` for every selected discovered role even when it has no user or project lane map; creation materializes that agent's first user-scope lane only after a valid name and model are selected.

### Legacy lane-name behavior

`readModelLanesFromSettingsFile` must continue accepting existing free-form keys. A legacy non-conforming user lane is marked `legacy name`, and users can open it, change model/thinking under the same key, or delete it. It is never silently renamed. Choosing Rename requires a new, unique name matching `/^[a-z0-9][a-z0-9-]*$/`; Escape leaves the legacy key unchanged. New lanes and changed rename targets use the same exact validation and show rejection inline while preserving the draft.

## Tasks

1. **M2.1 — Add an atomic, merge-preserving user lane mutation API**
   - **Problem:** `src/agents/model-lanes.ts` can read and resolve lanes but cannot write them. The only lane writer is the JSON-shortcut seeder, so the TUI has no safe persistence boundary.
   - **Files:** `src/agents/agents.ts`, `src/agents/model-lanes.ts`, `test/unit/model-lanes.test.ts`
   - **Changes:**
     - Export the existing `writeSettingsFile` primitive from `src/agents/agents.ts`; retain its mkdir, temporary-file rename, Windows `EEXIST` fallback, cleanup, and trailing-newline behavior.
     - In `src/agents/model-lanes.ts`, add the shared lane-name predicate for `/^[a-z0-9][a-z0-9-]*$/`, but do **not** apply it in the reader.
     - Add a user-only batch mutation contract, for example `UserModelLaneMutation` plus `applyUserModelLaneMutations(mutations)`. The function must resolve `getUserAgentSettingsPath()` internally so callers cannot select project scope.
     - Represent upserts with `agentName`, `laneName`, optional `originalLaneName`, and a model/thinking patch where `null` removes that field. `originalLaneName` lets an existing legacy key be edited in place or renamed while preserving the raw lane object's unrelated properties.
     - Read the current file once with `readSettingsFileStrict`, validate the complete existing `subagents.modelLanes` shape with the same parser used by reads, apply all mutations in memory, then call `writeSettingsFile` once. Preserve all root fields, all other `subagents` fields (especially `agentOverrides`), other roles/lanes, and unrelated properties on a targeted existing lane.
     - Validate non-blank model strings and canonical thinking levels at runtime. Validate every create target and changed rename target with the lane-name predicate; allow an unchanged invalid `originalLaneName` only when that exact lane already exists. Reject duplicate create/rename targets rather than overwriting them.
     - Removal accepts existing legacy names. Remove an empty agent lane map, but retain `subagents.modelLanes: {}` when the final user lane is deleted so `/subagents config` does not reseed lanes the user intentionally removed.
     - Leave `resolveModelLane`, `resolveModelLaneOverrides`, and all consumers unchanged.
   - **Tests:** Extend `test/unit/model-lanes.test.ts` with explicit cases for:
     - create in an existing file and create the first lane for an agent;
     - edit model and thinking; clear optional thinking; atomic rename;
     - remove one lane and the final lane while retaining an intentional empty `modelLanes` object;
     - preservation of root settings, sibling `subagents` fields, `agentOverrides`, sibling roles/lanes, and unrelated properties on an edited lane;
     - missing settings file, nested parent-directory creation, trailing newline, and one final replacement with no leftover temp file (also assert replacement rather than in-place truncation, e.g. changed inode on POSIX);
     - malformed JSON/root, malformed `subagents`, `modelLanes`, agent map, and lane definition, with original bytes unchanged after rejection;
     - invalid blank/non-string model, invalid thinking, invalid new lane name, invalid rename target, and duplicate target;
     - a legacy non-conforming name that still reads, edits in place, deletes, and renames to a valid target, while invalid creation remains rejected;
     - a newly written lane resolving through `resolveModelLane`/`resolveModelLaneOverrides`, with existing project precedence and unknown-lane behavior unchanged.
   - **Acceptance:** All listed store cases pass without touching project settings or runtime resolution code.
   - **Verify:** Run the focused file with the project loader, then `npm run typecheck` and `npm run test:unit`.
   - **Estimate:** Medium size, high risk (protected settings boundary).
   - **Dispatch:** One `worker` on the hard lane; sequential and first. Follow with the mandatory deep combined review either immediately or in the final combined review, but do not let UI code depend on an unreviewed changing mutation contract.

2. **M2.2 — Extend the hub with staged lane views and lane-specific undo**
   - **Problem:** `SubagentHubComponent` only edits role-default model/thinking overrides. It has no lane data, lane view states, or lane result shape.
   - **File:** `src/tui/subagent-hub.ts`
   - **Tests:** `test/unit/subagent-hub.test.ts`, `test/integration/subagent-hub.test.ts`
   - **Changes:**
     - Extend `HubView` with lane list, lane detail, lane-name input, lane model picker, lane thinking picker, and lane-delete confirmation states. Keep the existing main/model/thinking/reset-confirm paths and bindings intact.
     - Add an optional final constructor argument such as `laneConfig?: { user: ModelLaneMap; project: ModelLaneMap }` after `done`, preserving all existing constructor call sites and tests that do not supply lane data.
     - Clone user lane data into stable draft records carrying `id`, `originalName`, current `name`, and current model/thinking. Keep project data in a separate immutable map. Build final `UserModelLaneMutation[]` by comparing stable drafts to their originals so add-then-delete becomes a no-op, edits/renames retain `originalLaneName`, and untouched lanes never enter the result.
     - Add `laneMutations?: UserModelLaneMutation[]` to `SubagentHubResult`. Merge it into `buildDirtyResult`; `ctrl+c` must return no override resets and no lane mutations, while Escape from main returns both staged domains.
     - Intercept lowercase `l` in main before `agentSelectList.handleInput`. Build the lane list with non-searchable `SelectList`, preserving selection by stable row identity across rebuilds. `n`, `d`, and lane-list `u` must be intercepted before list delegation.
     - Display the union of project and user lanes for the selected role. Use distinct scope-qualified row identities so same-name rows coexist; label project rows `effective · read-only` and matching user rows `shadowed by project`. Project details show model/thinking/source and never expose mutation keys. Attempts to delete a project row show an inline read-only message.
     - Implement add as name input → searchable model picker. Do not create a staged lane until both a valid unique name and model selection complete; Escape from either step cancels without a mutation. This path must work when the role has no lane map yet.
     - User detail uses `m` for the shared searchable model picker, `t` for a one-row non-searchable `SettingsList` with `inherit` plus supported levels, and `r` for name input. Preserve empty/partial legacy lane definitions. Model changes must call the same clamp helper as the existing agent model picker rather than duplicating capability logic.
     - Existing valid-but-model-unsupported thinking displays as a warning until explicitly changed. Thinking choices omit unsupported levels. A model change clamps to `off` when supported or the first supported level, exactly matching the current model-picker behavior.
     - Add a dedicated `LaneTransaction`/snapshot stack. Push one transaction for every completed add, model edit, thinking edit, rename, or confirmed delete. Lane-list `u` restores the exact prior lane draft state LIFO; do not mix it with `ResetTransaction` or alter main-view reset undo.
     - Reuse the existing delete-confirm `SelectList` pattern and default to Cancel. Invalid/duplicate names remain in the name-entry view with an inline error; no silent normalization.
     - Update each footer with only its active keys. Main adds `l lanes`; lane list shows `enter/n/d` and conditional `u`; detail shows `m/t/r`; all nested views show `esc back` and `ctrl+c cancel`. Preserve final width truncation.
   - **Tests:**
     - In `test/unit/subagent-hub.test.ts`, cover draft/result mechanics: select a role, enter lanes, add/edit/rename/remove state, add-then-remove no-op, first lane for an empty role, separate lane undo, main reset undo unchanged, Escape cancellation at name/model/thinking/delete steps, `ctrl+c` discarding all staged lane changes, invalid and duplicate inline name errors, and legacy invalid-name edit/delete/valid-rename behavior.
     - In `test/integration/subagent-hub.test.ts`, drive real keys and rendered text for `l` entry, role/lane selection, user/project rows, same-name project-effective plus user-shadowed labels, read-only project details, model/thinking pickers, omitted unsupported levels, model-change clamp, delete dialog default/cancel/confirm, result emission on main Escape, and width bounds at 60/84/100 columns.
     - Keep new tests typed without adding `any` or non-null assertions; use narrow test accessors like the existing `componentState` seam.
   - **Acceptance:** The component can stage every required lane action, visibly distinguishes project precedence, and leaves all existing hub behavior unchanged before any file write occurs.
   - **Verify:** Run the two focused hub files with their existing unit/integration loader commands, then `npm run typecheck`.
   - **Estimate:** Large size, medium-high risk (state machine and regression-dense TUI).
   - **Dispatch:** One hard-lane `worker`, sequential after M2.1. Do not parallelize multiple writers against `src/tui/subagent-hub.ts` or its two mirrored test files.

3. **M2.3 — Wire scope reads and deferred persistence into `/subagents`**
   - **Problem:** The slash handler currently passes only discovered agents into the overlay and persists only role-default overrides after close.
   - **Files:** `src/slash/slash-commands.ts`, `test/integration/slash-commands.test.ts`
   - **Changes:**
     - Before opening the overlay, read user lanes from `getUserAgentSettingsPath()` and project lanes from `getProjectAgentSettingsPath(cwd)` with `readModelLanesFromSettingsFile`. Catch malformed/read errors, notify with the path and actionable reason, and do not open the overlay or write anything.
     - Pass both maps through the optional `laneConfig` constructor argument. Do not flatten them; the component needs scope identity and collisions.
     - Keep lane edits staged in memory. After the overlay returns, call `applyUserModelLaneMutations` once when `result.laneMutations` is non-empty, inside the existing persistence `try/catch`. Read fresh settings at save time through the store so unrelated changes made while the overlay was open are merged rather than replaced.
     - Persist no lanes on `undefined`, `ctrl+c`, or an empty mutation list. Never select a project settings path for lane writes.
     - Keep `saveBuiltinAgentOverride`/`removeBuiltinAgentOverride` behavior and scope logic unchanged. Update the success/error notification wording to cover both overrides and lanes without claiming success after an exception.
     - Leave the `CONFIG_KEYWORDS` branch first and unchanged so `/subagents config`, `/subagents json`, and `/subagents edit` still seed/open the user JSON before any TUI lane reads.
   - **Tests:** Extend `test/integration/slash-commands.test.ts` to prove:
     - the no-argument command passes separate user/project maps, including a collision, to the overlay;
     - returned lane mutations persist only after `custom()` resolves and write only the isolated user settings file;
     - empty/undefined/cancel results do not write;
     - malformed user or project lane shape prevents overlay construction and preserves file bytes;
     - a store exception produces an error notification and no success notification;
     - existing role-override save/reset behavior still works;
     - `/subagents config`, `json`, and `edit` remain short-circuited JSON controls and continue seeding `worker.normal`/`worker.hard` only when `modelLanes` is absent.
   - **Acceptance:** TUI and JSON changes are mutually visible on the next open, while project lanes remain display-only and all writes use the staged/deferred path.
   - **Verify:** Run focused slash, hub, model-lane, and subagents-config tests. Then run unchanged lane dispatch coverage in `test/integration/parallel-execution.test.ts`, `test/integration/async-execution.test.ts`, and `test/integration/async-dynamic-fanout.test.ts` to prove the writer feeds existing resolution without runtime changes.
   - **Estimate:** Medium size, high risk (command-to-settings integration).
   - **Dispatch:** One hard-lane `worker`, sequential after M2.1 and M2.2. M2.4 documentation drafting may begin in parallel only after this behavior contract is stable; release metadata waits for all gates.

4. **M2.4 — Document, version, review, and graduate M2**
   - **Problem:** The user-facing editor and `subagents.modelLanes` settings shape are absent from the main documentation, and M2 is still Planned.
   - **Files:** `README.md`, `skills/pi-subagents/SKILL.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `ROADMAP.md`, `package.json`, generated `package-lock.json`
   - **Changes / docs checklist:**
     - [x] `README.md` — add `/subagents` lane-editor usage and key map; document user writes, read-only project rows, shadow labels/precedence, TUI-only name rule, supported-thinking filtering/clamp, and `/subagents config|json|edit` fallback. Add `subagents.modelLanes` to the Configuration reference without mixing it with the extension's separate `config.json` table.
     - [x] `skills/pi-subagents/SKILL.md` — tell human operators to use `/subagents` for lane management, retain the direct JSON fallback, and keep current `worker.normal`/`worker.hard` examples.
     - [x] `docs/ARCHITECTURE.md` — update the directory map and “Where do I change X?” index to identify `model-lanes.ts` as read/write ownership and `subagent-hub.ts` plus `slash-commands.ts` as staged UI/persistence coordination.
     - [x] `CHANGELOG.md` — add `[Unreleased]` entries under Added/Changed/Tests/Documentation describing the lane editor, safe user-only store, read-only project shadow display, legacy-name compatibility, and JSON fallback.
     - [x] `package.json` / `package-lock.json` — after gates pass, bump `0.44.2` to `0.45.0` with `npm version 0.45.0 --no-git-tag-version`; do not hand-edit the generated lockfile.
     - [x] `ROADMAP.md` — M2 moved from Planned to Released as v0.45.0 after the live-TTY smoke check passed; M13 not moved and no milestones renumbered.
     - [x] Root `PLAN.md` close-out — release close-out complete; this plan is archived to `docs/history/legacy-planning/PLAN-M2-lane-editing-tui.md`. The orchestrator records completed outcomes/gates during execution and archives the transient plan only after release close-out; workers do not create another planning ledger.
   - **Tests / evidence:** Ensure docs use `normal/hard`, describe that existing free-form lane names keep working, and do not imply project writes or dispatch fallback. Confirm package and lockfile versions match.
   - **Acceptance:** Documentation accurately covers both UI and JSON control planes, release metadata is internally consistent, and roadmap state changes only after implementation evidence is green.
   - **Verify:** Run `npm run typecheck`, `npm run test:unit`, and `npm run test:integration` as three separate commands; do not rely on `test:all`, because a unit failure would hide integration status. Perform a cancel-only real `/subagents` smoke check for bindings/rendering without changing live settings. Then run one fresh deep combined review focused on user-settings integrity, legacy names, project read-only enforcement, shadowing truthfulness, staged cancellation, and existing hub/dispatch regressions. Fix blockers and rerun affected focused checks plus all three final gates.
   - **Estimate:** Medium size, medium risk (documentation/release consistency; code risk is review-only).

---

## M2 close-out record — COMPLETE (2026-07-31, released as v0.45.0)

**Outcomes:** M2.1–M2.4 complete. All acceptance gates satisfied, including the live-TTY smoke check.

**Final gates (orchestrator-run, three separate commands as required):**

- `npm run typecheck` — exit 0
- `npm run test:unit` — 1339 tests, 1335 pass, 0 fail, 4 pre-existing skips (baseline before M2: 1271)
- `npm run test:integration` — 444 pass, 1 fail on both runs

**Integration failure is pre-existing and NOT M2.** A different test fails each run, always in the
`namespaces inherited default outputs` family (parallel children racing over which materialized index
directory they claim). Proven by bisect: a pristine `HEAD` worktree containing zero M2 code fails the
same family 2-of-2 full-suite runs. Isolated runs pass everywhere, so the race only manifests under
full-suite concurrency. Logged in `IDEAS.md` as separate debt; deliberately not bundled into M2.

**Review:** three independent models (`anthropic/claude-opus-5` — self-review, authorship disclosed;
`openai-codex/gpt-5.6-sol`; `kimi-coding/k3`), plus an earlier `umans/umans-glm-5.2` pass on the M2.1
contract. Two blockers found and fixed:

1. **Rename cycles were unsaveable** and discarded all staged lane work (reachable via an intermediate
   name, e.g. swapping `normal`/`hard`). Flagged by only one of three reviewers; the other two,
   including the author, called the path unreachable. Confirmed at source before acting. Fixed in the
   store with a rename-source pre-scan; all prior rejections preserved.
2. **A vanished in-place lane was silently resurrected model-less**, because the staleness guard
   skipped when `originalLaneName === laneName`. Found by the author reviewing its own code.

Also fixed: prototype-unsafe key writes at four sites (including the reader and the agent-key level),
where a legacy `__proto__` lane corrupted on load as well as save; per-agent lane undo; silent
whitespace normalization on lane names; a main-header count that hid staged lane writes; and four
documentation defects (broken table, wrong persistence boundary, non-existent bundled lanes, inverted
clamp semantics).

**Independent verification:** `test/unit/model-lanes-cycle-guard.test.ts` is an orchestrator-authored
adversarial probe kept deliberately outside the implementing worker's file scope, on the principle
that an implementation which widened a rejection would likely have relaxed its own test to match. It
pins the permitted cycles and every rejection that must survive, asserts the specific error message
(not merely that something threw), and asserts byte-identical files with no stray temp file on every
rejection path. 11/11 pass.

**Test-shim honesty:** `SelectList.handleInput` was a no-op in `test/support/ts-loader.mjs`, so
deleting the lane list's `onSelectionChange` wiring left the entire suite green while production would
delete the WRONG lane. The shim now implements the real component's semantics (verified against the
installed `pi-tui` dist, not guessed), and the new regression was proven load-bearing by removing the
wiring, observing red in both suites, and restoring with an md5 check.

**Deferred by explicit user decision (2026-07-31), not by oversight:**

- Stale lane deletes keep rejecting the whole batch rather than becoming idempotent.
- Lane undo stays strict top-of-stack rather than per-role scan-and-splice.

**Live-TTY smoke check: PERFORMED AND PASSED (user-verified, 2026-07-31).** The cancel-only real
`/subagents` check for bindings and rendering was run by the user in an interactive terminal, which
this automated run could not drive, and the editor was confirmed working. This was the last
outstanding acceptance item and the sole reason graduation was previously held; with it green, M2 was
moved to Released. Note for future close-outs: the shim-level key coverage added during M2 is a proxy
for this check, not a substitute — real theme callbacks, true terminal width behavior, and actual key
delivery are only exercised by a live terminal.

**Known residual risks (carried forward to `ROADMAP.md` → Debt, so they survive this plan's archival):**
the `setFilter` shim gap (declared in `test/support/shims/pi-tui.d.ts`, still unimplemented — would
typecheck and fail at runtime if ever called); 139 broader-form non-null assertions repo-wide; and the
pre-existing fanout ordering race described above.
   - **Dispatch:** Documentation files can be handled by one normal-lane worker in parallel with late M2.3 verification once behavior is frozen. Version bump, roadmap graduation, final review, and plan close-out remain sequential orchestrator work.

## Must Not Regress

- Existing hub main behavior: `enter` model picker, `tab` thinking view, fuzzy model search/paste, selection preservation, model-thinking clamp, `x` single reset, `X` bulk confirmation defaulting to Cancel, main `u` LIFO reset undo, dirty-only Escape result, `ctrl+c` discard, markers, and width bounds.
- `/subagents config|json|edit`: user-settings path, conditional `worker.normal`/`worker.hard` seeding, editor launch, malformed-shape refusal, and no TUI dependency.
- Lane dispatch resolution: project scope wins over user, user fallback remains, inline model/thinking overrides still win over the lane value, and unknown lanes still throw with no fallback across foreground, static parallel, async, and dynamic fan-out paths.
- Existing settings integrity: unrelated root/subagent fields and `agentOverrides` survive lane writes; malformed files are never replaced with a clean skeleton.
- Project settings remain read-only from the lane TUI; no eager writes occur while the overlay is open.
- Existing free-form lane names continue to read and resolve even though TUI create/rename targets are restricted.

## Files to Modify
- `src/agents/agents.ts` - export the existing atomic settings writer for the lane store
- `src/agents/model-lanes.ts` - lane-name predicate, batch user mutation contract, validation, and merge-preserving persistence
- `src/tui/subagent-hub.ts` - lane views, staged drafts/results, project shadow display, keybindings, and lane undo
- `src/slash/slash-commands.ts` - scope-aware lane reads and deferred user-only persistence
- `test/unit/model-lanes.test.ts` - complete store and legacy-name acceptance matrix
- `test/unit/subagent-hub.test.ts` - lane draft/result and cancellation state tests
- `test/integration/subagent-hub.test.ts` - rendered/key-driven lane workflow tests
- `test/integration/slash-commands.test.ts` - command plumbing, persistence, malformed-config, and shortcut regressions
- `README.md` - user workflow and settings reference
- `skills/pi-subagents/SKILL.md` - operator guidance and JSON fallback
- `docs/ARCHITECTURE.md` - ownership/directory map updates
- `CHANGELOG.md` - M2 Unreleased/release notes
- `ROADMAP.md` - move M2 to Released at ship time
- `package.json` - v0.45.0 minor version
- `package-lock.json` - generated version synchronization via npm

## New Files
- None. Extend the existing 1:1 source/test files; do not create duplicate TUI/store test suites or a second planning ledger.

## Dependencies
- M2.1 is the foundation and must land with tests before any UI persistence depends on it.
- M2.2 depends on M2.1's mutation/result types but can remain component-only and staged.
- M2.3 depends on both M2.1 and M2.2 and is the first outcome that connects staged UI results to disk.
- M2.4 documentation drafting depends on the stable M2.2/M2.3 interaction contract. Versioning, roadmap graduation, deep review, and close-out depend on every code outcome and final gate being green.
- Parallelism is limited to disjoint documentation work during late M2.3 verification; source outcomes are sequential because they share contracts and the hub/slash persistence path.

## Risks
1. **Legacy-name lockout:** applying the new regex in the read parser or all upserts would make existing lanes uneditable. Keep validation operation-aware and test edit/delete under an invalid existing key.
2. **Misleading shadow display:** collapsing same-name rows could imply a user edit changes effective dispatch. Use separate scope-qualified rows and explicit `effective`/`shadowed` labels.
3. **Settings clobber:** reconstructing `subagents` or a lane from parsed types can drop unrelated fields. Mutate a fresh strict raw object, preserve targeted raw properties, and write once atomically.
4. **Partial cross-domain save:** lane mutations and existing agent overrides are separate persistence calls, so a later failure can leave one domain saved. Keep lane batches atomic, report exact failure without false success, and do not claim the overall save is transactional.
5. **Draft/rename identity bugs:** name-keyed state can turn rename/undo/add-delete into duplicate or destructive operations. Use stable draft IDs plus `originalName` and derive minimal final mutations.
6. **Thinking incompatibility:** showing every canonical level or failing to clamp on model changes can persist an unsupported pair. Reuse the existing capability helper and clamp path; test reasoning and non-reasoning models.
7. **Key consumption:** printable shortcuts disappear if the lane list becomes searchable. Keep it as non-searchable `SelectList` and intercept `l/n/d/u` before delegating input.
8. **Harness/terminal drift:** component shims cannot prove real terminal focus or overlay lifecycle. Preserve documented APIs, run width/key integration tests, and perform a cancel-only real TUI smoke check.

## Rollback
- **Before commit (or for an uncommitted outcome):** after checking shared-checkout ownership, the orchestrator can restore only M2-owned paths with `git restore -- <explicit paths above>`; never use `git restore .`, `git reset`, `git clean`, or stash.
- **After commit:** identify the pre-M2 commit and use `git revert <M2-commit(s)>`, or restore the explicit M2 file list from that commit in a new corrective commit. Do not rewrite shared history.
- **Version-only rollback before release:** run `npm version 0.44.2 --no-git-tag-version` to synchronize `package.json` and generated `package-lock.json`, then restore the Unreleased changelog/roadmap text explicitly.
- **Configuration impact:** M2 has no migration and tests/manual persistence checks use isolated homes. Reverting code does not undo user-authored lane changes already saved through the editor; restore those deliberately through `/subagents config` from the user's prior settings copy. Project settings require no rollback because M2 never writes them.
