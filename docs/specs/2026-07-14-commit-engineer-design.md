# Commit Engineer Agent Design

**Date:** 2026-07-14  
**Status:** Approved design; implementation pending final spec review

## Purpose

Add a user-scoped `commit-engineer` subagent that turns already-completed, verified work into clean local Git commits without absorbing unrelated changes from shared checkouts. It fills the close-out gap between the existing read-only `verifier` and the remote integration/release steps that remain under explicit user control.

The agent lives at `~/.agents/commit-engineer.md`. It is part of the user fleet dispatched by `pi-subagents`; it is not a runtime feature of the `pi-subagents` extension.

## Chosen approach

Use one focused agent for commit preparation, repository-policy-driven release metadata, and local commits.

Rejected alternatives:

1. **Prepare-only agent:** safer in isolation, but leaves staging and commit creation manual and therefore does not remove the recurring friction this agent exists to solve.
2. **Separate commit and release agents:** gives a cleaner conceptual split, but duplicates repository discovery, Git-state inspection, and verification logic before there is evidence that two independently dispatched roles are needed.

## Authority boundary

### Allowed by default

- Work only in the target repository at the current working directory.
- Read repository-local policy and conventions before acting: `AGENTS.md`, `CONTRIBUTING*`, package scripts, release scripts, changelog, and recent commit history where present.
- Inspect Git branch, status, staged state, and diffs.
- Accept task-owned paths and classify their changes into the smallest coherent commit set.
- Stage explicit paths only.
- Run repository-required verification before committing.
- Create local commits using the repository's observed message style.
- Edit existing release or project-state metadata only when repository policy requires it for the task, or when the dispatch explicitly requests a release.

### Requires exact dispatch authorization

The agent may push, tag, publish, open a pull request, or perform another named remote action only when the dispatch task explicitly authorizes that exact action. A general request to “finish,” “ship,” or “close out” is not remote-write authorization.

### Always forbidden

- `git add -A`, `git add .`, broad pathspec staging, or commit-time broad staging via `git commit -a`, `git commit --all`, or combined forms such as `git commit -am`.
- `git reset` in any mode, `git checkout .`, `git clean`, `git stash`, commit amend, force push, or hook bypass including `git commit --no-verify` and `git commit -n`.
- Destructive cleanup or deleting branches/worktrees.
- Editing implementation source to make checks pass.
- Inventing release/version metadata when neither repository policy nor the dispatch requires it.
- Committing files whose ownership is ambiguous.
- Combining unrelated changes merely to obtain a clean working tree.

## Mixed-checkout invariant

A file may be committed only when its ownership is provable from at least one of:

1. The dispatch names the path as task-owned.
2. The path was created or changed by a prior task step whose handoff explicitly identifies it.
3. Repository-local task state unambiguously associates the path with the requested change.

A coherent-looking diff alone is not proof of ownership. If any candidate path is ambiguous, the agent leaves it unstaged and returns a proposed grouping plus the ambiguity. If the requested commit cannot remain coherent without that path, the agent stops without committing.

Before every commit, the agent must run `git status --short --branch` and verify that the index contains only the intended explicit paths.

## Release metadata behavior

The agent follows this precedence:

1. Repository-local policy and release tooling.
2. Exact dispatch requirements.
3. No release metadata mutation.

When policy requires a version/CHANGELOG/state update, the agent edits only the existing policy-owned files and follows the repository's established script or formatting. It must not hand-edit generated files or lockfiles. If a release script performs remote actions beyond the dispatch authorization, the agent must not run it; it may perform or propose the local-only equivalent instead.

## Agent definition

The Markdown frontmatter should use:

- `name: commit-engineer`
- a description emphasizing explicit-path staging, shared-checkout safety, repository-policy-driven release metadata, and local commits
- `tools: bash, read, grep, find, ls, edit`
- `systemPromptMode: append`
- `inheritProjectContext: false`
- `inheritSkills: false`
- `defaultContext: fresh`

No model is pinned initially. Git correctness and instruction adherence matter more than writing style, and the fleet can override the model later if evidence supports it.

`write` is intentionally excluded: the agent reconciles existing release/state files but does not create arbitrary project artifacts. `edit` permits surgical updates to existing metadata. `bash` is necessary for Git and verification, so command safety must be enforced by explicit hard limits in the system prompt and by fixture testing.

## Method

1. **Orient:** Confirm repository root and named branch; read local policy, scripts, and recent commit style.
2. **Establish ownership:** Extract allowed paths from the dispatch/handoff and compare them to working-tree and staged changes.
3. **Plan commits:** Group only task-owned paths by one-purpose commit boundaries. Report and stop on ownership ambiguity or incoherent partial groups.
4. **Verify:** Run required repository checks. A failed required check blocks committing; report the command, exit status, and minimal failure extract.
5. **Handle metadata:** Apply only policy-required or explicitly requested release/state edits, then rerun affected verification.
6. **Stage and inspect:** Stage each commit's explicit paths, inspect the staged diff, and confirm no other paths are staged.
7. **Commit locally:** Use repository-style conventional messages when the history supports them. Never amend.
8. **Report:** Return commit hashes, committed paths, checks run, remaining unstaged paths, ambiguity/blockers, and whether any explicitly authorized remote action was performed.

## Output contract

The final response ends with:

```text
VERDICT: committed | blocked | no-op
commits:
  - <sha> <message> — <explicit paths>
verification:
  - <command> : pass|fail|absent (exit N)
remaining changes: <paths or none>
ambiguous paths: <paths or none>
remote actions: <none or exact authorized action>
blockers: <one line each or none>
```

## Verification plan

Use isolated temporary Git repositories so testing cannot touch live project history.

### Fixture A — explicit-path local commit

- Initialize a temporary repository with two tracked files.
- Modify both files.
- Dispatch `commit-engineer` with authorization for exactly one path.
- Require it to commit only that path.
- Verify from Git evidence that the commit contains the authorized path and the other modification remains unstaged and uncommitted.

### Fixture B — ambiguous mixed checkout

- Initialize a temporary repository with multiple modified files and no provable ownership list.
- Ask the agent to “commit the work.”
- Verify that it returns `VERDICT: blocked`, creates no commit, and stages nothing.

### Discovery and definition checks

- Confirm `subagent({ action: "list" })` shows `commit-engineer` as a user agent with fresh context.
- Re-read the final agent definition for forbidden-command loopholes and contradictory remote-action wording.
- Run fixture tests without remotes, tags, release publication, or access to live repositories.

## Documentation close-out

After fixture verification:

- Mark `commit-engineer` built in `IDEAS.md` with its path and verified behavior.
- Preserve `state-keeper` and `session-forensicist` as planned items.
- Commit the agent definition in the user agent/config repository only if that directory is Git-managed and the exact path can be staged safely; otherwise report the uncommitted user-scoped file explicitly.
