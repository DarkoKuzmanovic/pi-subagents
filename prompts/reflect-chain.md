---
description: Analyze a chain run's artifacts and suggest improvements to chain templates, agents, and pi-subagents
argument-hint: "[run-id]"
---

Reflect on a chain run and produce actionable improvements.

## 1. Find the chain run

If a run ID was provided: `$1`
If no run ID, find the most recent non-test chain run by inspecting both stores:

- Persisted session artifacts: use the `find` tool with pattern `*_meta.json` under `~/.pi/agent/sessions/`, sorted by mtime, recent first.
- Ephemeral chain directories: use the `ls` tool on `/tmp/pi-subagents-*/chain-runs/`, recent first, filtering out `test-*` entries.

Fall back to `bash` only if the structured tools cannot satisfy the lookup.

Pick the most recent real run ID (8-char hex, not `test-*`).

## 2. Read all artifacts

For the selected run ID, list every artifact with the `find` tool: pattern `${RUN_ID}_*_meta.json` under `~/.pi/agent/sessions/`.

For each step, read:
- `*_meta.json` — timing, turns, cost, model, exit code
- `*_output.md` — what the agent actually produced (skim for quality, don't dump)
- `*_input.md` — what task was sent (check for prompt quality)

Also list the chain directory for progress and intermediate artifacts with `find` on `/tmp/pi-subagents-*/chain-runs/${RUN_ID}/`, `type: "file"`.

## 3. Analyze

Build a structured analysis covering:

### Timing & cost
| Step | Agent | Model | Duration | Turns | Input tokens | Output tokens | Cost |
For each step, extract from `_meta.json`. Flag any step that took >5 min or >50 turns.

### Knowledge rediscovery
Compare what each step discovered vs. what was available from prior steps. Flag cases where:
- A step re-ran commands that a prior step already ran
- A step hunted for test infrastructure that was (or should have been) in the handoff
- A step made assumptions that contradicted evidence from a prior step

### Prompt quality
For each step's `_input.md`, check:
- Was the task specific enough? Or vague ("implement the plan")?
- Did it include the right context references?
- Were constraints stated clearly (especially type signatures, valid enum values)?
- Was the validation command explicit?

### Mistakes & recovery
Count turns spent on:
- Wrong test runner commands
- TypeScript compilation errors
- Import errors from wrong paths
- Mismatched function signatures or invalid argument values
- Tests that fail because of misunderstood mock behavior

### Output quality
For each step's `_output.md`:
- Did it produce what was asked?
- Was the handoff material useful for the next step?
- Were there gaps the next step had to fill?

## 4. Suggest improvements

Produce concrete, implementable changes in three categories:

### Chain template changes
Read the current chain template that was used (check `~/.pi/agent/chains/` and `.pi/chains/` for `.chain.md` files). Suggest specific edits:
- Step ordering changes (merge/split/reorder)
- Prompt improvements for each step (exact wording)
- Skill additions (e.g., `skills: test-writer`)
- Output requirements (e.g., mandatory "Test Infrastructure" section)
- Missing handoff data between steps

### Agent definition changes
Read agent files in the `agents/` directory. Suggest edits to:
- System prompts (add specific instructions based on observed failures)
- Output format requirements
- Tool lists (add/remove tools based on what agents actually needed)
- `inheritSkills` or `skills` changes

### Extension code changes
Suggest improvements to pi-subagents source code in `src/`:
- Default thresholds (e.g., `needsAttentionAfterMs`)
- Chain execution behavior
- Artifact metadata (additional fields that would help future analysis)
- New features that would prevent the observed failure patterns

For each suggestion, provide:
- **What**: the specific change
- **Why**: which observed problem it fixes, with evidence from the artifacts
- **Impact**: estimated turn/time savings based on the analysis
- **Priority**: blocker (prevents chain from working), high (saves >5 min), medium (saves 1-5 min), low (nice-to-have)

## 5. Present for approval

Summarize findings as a table, then list the top changes by priority. Ask which ones to implement.
