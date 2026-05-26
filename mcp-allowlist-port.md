# MCP Direct-Tool Allowlist Port

## Status: Complete ✓

## Files changed

| File | Change |
|------|--------|
| `src/runs/shared/mcp-direct-tool-allowlist.ts` | NEW — verbatim copy from upstream (365 LOC), byte-for-byte match verified |
| `src/runs/shared/pi-args.ts` | Added `import { resolveMcpDirectToolNames }`, added `cwd?: string` to interface, added `resolveMcpDirectToolNames` call in builtin tools section (+5 lines) |
| `src/runs/foreground/execution.ts` | Added `cwd: options.cwd ?? runtimeCwd` to `buildPiArgs()` call in `runSingleAttempt()` (+1 line) |
| `src/runs/background/subagent-runner.ts` | Added `cwd: step.cwd ?? ctx.cwd` to `buildPiArgs()` call in `runSingleStep()` (+1 line) |
| `src/shared/utils.ts` | Added `export function getAgentDir()` — required by the allowlist module (+7 lines) |
| `test/unit/pi-args.test.ts` | Added MCP test fixtures + 9 test cases ported from upstream (+266 lines) |

## Validation

- **Typecheck errors:** 380 baseline → 389 after (all 9 new errors are `@types/node` shim noise in the new file — `node:crypto`, `node:fs`, `node:os`, `node:path`, `process`)
- **Unit tests:** 20/20 pass in `pi-args.test.ts`; 494/496 pass in full suite (2 pre-existing failures unrelated)
- **Byte-for-byte match:** `diff <(git show upstream/main:src/runs/shared/mcp-direct-tool-allowlist.ts) src/runs/shared/mcp-direct-tool-allowlist.ts` — no output (identical)

## Notes

- `getAgentDir()` was added to `utils.ts` because upstream has it but our fork didn't. It resolves `PI_CODING_AGENT_DIR` env var or falls back to `~/.pi/agent`.
- The upstream "does not let direct MCP tools authorize child fanout" test was skipped because it depends on `SUBAGENT_FANOUT_CHILD_ENV` which we don't have (fanout feature not ported).
- Changes are staged but NOT committed per instructions.
