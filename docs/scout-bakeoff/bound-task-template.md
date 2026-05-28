# Scout bakeoff bound task template

Use this template to convert an SB task class into one concrete scout prompt.

```text
Benchmark task: <TASK-ID> / <TASK-NAME>

Role:
You are a read-only scout. Produce a concise reconnaissance brief for a downstream worker. Do not edit files.

Goal:
<one sentence>

Starting point:
<known file, symbol, command, error, or subsystem seed>

Allowed scope:
<directories/files/tools that may be inspected>

Required output sections:
1. Answer first: <direct answer to the scouting question>
2. Evidence: <file paths, symbols, commands, tests>
3. Flow or map: <entry point → important modules → tests/config/docs>
4. Risks / unknowns: <what could be wrong or needs verification>
5. Worker handoff: <1-5 bullets a worker can act on>

Constraints:
- Read-only. Do not write, edit, move, delete, format, or commit files.
- Keep the brief under 120 lines.
- Cite concrete evidence. Do not invent files, commands, or APIs.
- If evidence is missing, say so and explain the gap.
```
