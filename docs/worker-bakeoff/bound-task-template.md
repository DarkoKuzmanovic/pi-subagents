# Bound Worker Bakeoff Task Template

Use this to turn one task class in `tasks/` into a concrete benchmark prompt.

```text
Benchmark task: <WB-ID> / <name>

Goal:
<one sentence>

Starting evidence:
<failing command, spec bullets, expected flow, or behavior gap>

Approved scope:
<files/symbols/behavior in scope>

Non-goals / forbidden changes:
<protected files, no broad refactors, no config rewrites>

Success criteria:
<what must be true>

Validation to run:
<exact commands>

Final response required:
- Summary of files changed.
- Verification commands and pass/fail output summary.
- Any blockers or assumptions.

If the task is ambiguous or would require touching forbidden files, stop and report the blocker instead of guessing.
```
