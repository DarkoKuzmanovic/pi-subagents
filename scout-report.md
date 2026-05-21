# Fork vs Upstream Recon Report

**Repo:** `/home/quzma/.pi/agent/extensions/pi-subagents`  
**HEAD:** `2e3bfba` (DarkoKuzmanovic/pi-subagents, main)  
**Upstream:** `upstream/main` (nicobailon/pi-subagents, main)  
**Merge Base:** `3ee17de`  
**Date:** 2026-05-22

---

## Critical Fixes Triage

| Commit | Title | Status | Cherry-pick Clean? | Notes |
|--------|-------|--------|-------------------|-------|
| `30f7c0b` | fix: honor pi coding agent dir | **CONFLICTS** | ❌ No | Conflicts in `agents.ts`, `intercom-bridge.ts`, `run-history.ts`. Our tree has MemoryScope + intercom features that diverge. |
| `42ae7f1` | fix: respect read-only completion guards | **APPLIES** | ❌ No | Bug exists (missing `declaresOnlyReadOnlyTools` check). Conflicts in `agents.ts`, `agent-serializer.ts` due to our agent features. |
| `c13713e` | fix: normalize string false output overrides | **APPLIES** | ✅ Yes | Clean apply. We're missing `"false"`/`"true"` string normalization in `single-output.ts:16`. |
| `9a83168` | fix: ignore empty final assistant output | **APPLIES** | ✅ Yes | Clean apply. Missing error message skip + `text.trim().length > 0` check in `utils.ts:getFinalOutput()`. |
| `6d5e264` | fix: ignore recovered child errors | **CONFLICTS** | ❌ No | Conflicts in `execution.ts`. Our foreground execution has timeout/recovery telemetry that diverges. |
| `7782b8c` | fix: avoid timer-driven subagent spinner redraws | **CONFLICTS** | ❌ No | Conflicts in `render.ts`, `extension/index.ts`. Our hub TUI + inactivity timeout significantly diverge. |
| `f096c1a` | fix: space turn count indicator | **APPLIES** | ✅ Yes | Clean apply. One-char fix: `⟳${turns}` → `⟳ ${turns}` in `render.ts:836`. |
| `d8735fb` | fix: hide nested child windows on windows | **APPLIES** | ✅ Yes | Clean apply. Missing `windowsHide: true` in `subagent-runner.ts:222` spawn options. |
| `c16ab0e` | fix: ship pi tui as runtime dependency | **NOT_APPLICABLE** | ❌ No | We intentionally keep `@earendil-works/pi-tui` as explicit dependency. Different strategy. |
| `635112d` | fix: show async single detail hint | **CONFLICTS** | ❌ No | Conflicts in `render.ts`, `package.json`. Our render.ts diverges; we show details differently. |

---

## MCP Allowlist Port Plan

### Module Summary

`src/runs/shared/mcp-direct-tool-allowlist.ts` (365 lines) provides MCP direct tool resolution from config files. Exports:
- `resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd: string): string[]` — Resolves MCP direct tool names from `~/.config/mcp/mcp.json` and project `.mcp.json`, with caching and env interpolation
- `computeMcpServerHash(definition: ServerEntry): string` — Stable hash for MCP server definitions

The module reads MCP configs from multiple sources (user, project, cwd), expands imports, interpolates environment variables, and caches results with 7-day TTL.

### Call Sites Requiring Changes

| File | Function | Change Required |
|------|----------|-----------------|
| `src/runs/shared/pi-args.ts` | `buildPiArgs()` | Import `resolveMcpDirectToolNames`; add `cwd?: string` to `BuildPiArgsInput`; resolve MCP tools and merge into `builtinTools` array; set `MCP_DIRECT_TOOLS` env var |
| `src/runs/foreground/execution.ts` | `runSingleAttempt()` | Pass `cwd: options.cwd ?? runtimeCwd` to `buildPiArgs()` |
| `src/runs/background/subagent-runner.ts` | `runSingleStep()` | Pass `cwd: step.cwd ?? ctx.cwd` to `buildPiArgs()` |
| `src/runs/shared/mcp-direct-tool-allowlist.ts` | — | **New file** — copy from upstream |

### Conflicts/Drift

- **`pi-args.ts`**: Our version lacks `cwd` parameter and `mcpDirectTools` handling entirely. No direct conflict, but requires surgical insertion.
- **`execution.ts`**: Our version has timeout/recovery telemetry (`recovery-telemetry.ts` integration) that upstream lacks. The `cwd` addition is compatible but needs careful placement.
- **`subagent-runner.ts`**: Similar — our version has intercom bridge + timeout features. The `cwd` parameter addition is compatible.

### Port Complexity Estimate

**MODERATE** — Requires:
1. Copy new 365-line module (trivial)
2. Add `cwd` parameter to `BuildPiArgsInput` interface (trivial)
3. Insert MCP tool resolution logic into `buildPiArgs()` (moderate — must not break existing tool filtering)
4. Add `cwd` passthrough in 2 call sites (trivial)
5. Resolve minor conflict in `execution.ts` due to our recovery telemetry

Estimated effort: 1-2 hours including testing.

---

## Recommendations

### Priority Order for Porting Fixes

1. **`f096c1a`** (space turn count) — **Port first**. One-character fix, zero risk, immediate UX improvement.
2. **`d8735fb`** (windowsHide) — **Port second**. Single-line Windows compatibility fix, no conflicts.
3. **`9a83168`** (ignore empty assistant output) — **Port third**. Bug fix in `getFinalOutput()`, clean apply, prevents spurious empty outputs.
4. **`c13713e`** (normalize string false output) — **Port fourth**. Bug fix in `single-output.ts`, clean apply, prevents `"false"` string being treated as valid output path.
5. **`42ae7f1`** (read-only completion guards) — **Port fifth** (requires manual merge). Important for MCP direct tools integration, but conflicts with our agent features. Needs careful review.
6. **MCP Allowlist (`3c7fd86`)** — **Port as single worker task**. Moderate complexity but self-contained. Should be ported together with `42ae7f1` since they're related (completion guard uses MCP allowlist).

### Decomposition Strategy

**MCP Allowlist port should be a single worker task** with explicit instructions:
- Copy `mcp-direct-tool-allowlist.ts` from upstream
- Add `cwd` parameter to `BuildPiArgsInput` in `pi-args.ts`
- Insert MCP tool resolution before `builtinTools` push in `buildPiArgs()`
- Add `cwd` passthrough in `execution.ts:runSingleAttempt()` and `subagent-runner.ts:runSingleStep()`
- Run `npm run typecheck` and `npm test` to verify

**Do NOT decompose further** — the changes are tightly coupled and a single agent can handle them in one pass.

### Deferred / Skip

- **`30f7c0b`** (pi coding agent dir) — Defer. Conflicts with our MemoryScope + intercom features. Requires architectural decision.
- **`6d5e264`** (recovered child errors) — Defer. Conflicts with our recovery telemetry. Need to reconcile error handling strategies.
- **`7782b8c`** (timer-driven spinners) — Defer. Major conflicts with hub TUI. Our render.ts has diverged significantly.
- **`635112d`** (async single detail hint) — Defer. Conflicts with our render logic. Review whether we need this UX.
- **`c16ab0e`** (pi-tui dependency) — **Skip**. We intentionally use different dependency strategy.

---

## Summary

**Clean ports (4):** `f096c1a`, `d8735fb`, `9a83168`, `c13713e` — ~10 lines total, zero risk.  
**Requires manual merge (1):** `42ae7f1` — completion guard fix, needed for MCP allowlist.  
**MCP Allowlist (1):** `3c7fd86` — moderate effort, single worker task.  
**Conflicts/Defer (4):** `30f7c0b`, `6d5e264`, `7782b8c`, `635112d` — diverged features require reconciliation.  
**Skip (1):** `c16ab0e` — intentional dependency strategy difference.

**Recommended next step:** Port the 4 clean fixes first (low risk, high confidence), then dispatch a worker to port the MCP allowlist + completion guard fix together.
