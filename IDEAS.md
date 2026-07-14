# Ideas backlog — the close-out agent suite

Brainstormed candidates. **Not committed** — a pool to pick and choose from.
When an idea is picked, check it off and note where it graduated.

These are **user-scoped subagents** (live in `~/.agents/`), crew-callable and
usable standalone. They are *not* pi-subagents extension features — they are the
fleet the extension dispatches. Parked here because this is where we work on the
roster. Crew already knows about the built ones via an awareness note in its
toolbelt (`skills/crew/SKILL.md`, "Close-out subagents") — optional offload, not
loop steps, because each costs a child dispatch against crew's ceilings.

Source: 2026-07-14 gap analysis over 521 sessions. The recurring friction was
that *doing* work is well-staffed (recon/planner/worker/reviewer/oracle) but
*finishing it cleanly* — verify, document, commit, keep state honest — was all
manual in-session. This suite fills that.

## The shared recipe (proven by verifier + docs-freshener)

Narrow scope · tools restricted to what the job needs (physical enforcement beats
prompting — e.g. no `bash` = no installs) · discipline baked into the system
prompt · `worktree: true` for anything that writes · a mandatory review/verify
gate · never trust the agent's own "done" without evidence.

## Built

- [x] **verifier** (`~/.agents/verifier.md`) — read-only QA gate. Discovers a
  repo's real build/lint/typecheck/test, runs them, returns a structured
  pass/fail verdict with minimal failure extracts. Tools: `bash,read,grep,find,ls`
  (no `edit`/`write` — it reports, never fixes). No pinned model (reliability >
  prose for a gate). Verified on pi-agy `npm run check`. — 2026-07-14
- [x] **docs-freshener** (`~/.agents/docs-freshener.md`) — reconciles
  README/AGENTS/docs against source, returns a reviewable diff. Tools exclude
  `bash` (physically blocks install/build over-reach); mandatory self-re-read
  kills invented links/versions. Pinned `minimax/MiniMax-M3` (writing quality is
  the whole job). Caveat: ~1/3 provider-abort rate — retry on abort. — 2026-07-14

- [x] **commit-engineer** (`~/.agents/commit-engineer.md`) — stages only
  explicitly authorized paths, blocks on pre-existing staged or ambiguous changes,
  runs repository-required checks, follows repository policy for release metadata,
  and creates local commits in the repo's observed style. Remote actions require
  exact dispatch authorization. Tools: `bash,read,grep,find,ls,edit` (no `write`).
  Verified in isolated Git fixtures: committed only `owned.txt` while preserving an
  unrelated modification, and refused an ownership-ambiguous checkout without
  staging or committing anything. — 2026-07-14

## Planned
- [ ] **state-keeper** — reconciles the *project-state* docs against each other
  and enforces one milestone-ID convention (the Mx / Sx / M2.1 drift). Sibling to
  docs-freshener: docs-freshener does docs↔code, state-keeper does state↔state +
  convention. Flags inconsistent milestone IDs across ROADMAP/DECISIONS/CHANGELOG/
  PLAN. Tools: `read,grep,find,ls,edit` (no `bash`). — effort:M
- [ ] **session-forensicist** — mines session history for handoff summaries,
  cross-session drift, and usage patterns at close-out (the analysis that
  produced this file was itself un-delegated). Lower priority; overlaps
  `inspect_session`. — effort:M
