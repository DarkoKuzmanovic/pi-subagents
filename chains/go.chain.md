---
name: go
description: Scout codebase → build implementation plan → worker implements → test writer adds tests → reviewer validates
---

## scout
output: scout-context.md
progress: true

Map the codebase areas relevant to: {task}

Include:
- File paths and function signatures for every relevant function/type/interface
- Call sites showing how each piece is used
- Existing test patterns: helpers, fixtures, mocking approaches, describe/it structure
- Dependencies and constraints that affect the change
- Line ranges for key code blocks the worker will need to edit

**Test infrastructure (mandatory):**
- Exact test runner command (copy-paste ready, e.g. `npx tsx --test --import ./test/support/register-loader.mjs`)
- Test file naming and location conventions
- Key helpers and factories in test/support/
- Known quirks: loader shims, stubbed modules, TypeScript compatibility (strip-types vs transform-types vs tsx)
- The closest existing test file to use as a reference pattern

Be thorough — the worker will implement based solely on your context.

## context-builder
output: implementation-plan.md
progress: true

Read the scout context from {previous}.

Write a specific implementation plan for: {task}

The plan must include:
- Exact files to edit with line ranges
- What to change in each file (specific code, not vague descriptions)
- Order of changes (dependencies first)
- Test file locations and what tests to add
- Validation command to run after changes (use the exact test runner command from the scout context — do not guess)

**Constraint verification:** Before finalizing the plan, verify every function signature, type, and enum value you reference against the scout context. If the scout says a function accepts `"user" | "project"`, do not write `"both"` in the plan.

Write this as a contract a worker agent can follow without judgment calls.

## worker
progress: true

Execute the implementation plan from {previous}. Follow it precisely.

Rules:
- Make each edit surgically — change only what the plan specifies
- Run the project's test command after each file change (use the exact command from the plan — do not hunt for it)
- If a test fails, fix it before moving to the next file
- If the plan is ambiguous on a point, pick the simpler interpretation
- Do not refactor adjacent code or add improvements not in the plan

**End your response with a "Test Infrastructure" section** that documents:
- The exact test runner command you used
- Any quirks you discovered (e.g., "matchesKey shim returns false — test via direct method calls")
- Which test helper functions you used

This section will be passed to the next step to avoid rediscovery.

## delegate
skills: test-writer
progress: true

Write unit tests for the changes just made. Read the git diff to see what changed.

**Before writing any tests**, read the "Test Infrastructure" section from the previous step. Use the exact test runner command and patterns documented there. Do not re-discover test infrastructure that was already found.

Rules:
- Follow existing test patterns in the project (check nearby test files for helpers, structure, mocking)
- Cover: happy path, edge cases, error cases for each changed function
- Run the tests and fix any failures before finishing
- Keep tests focused — one assertion concept per test

## reviewer
output: false
progress: false

Review the full git diff for this change. Check:
1. Correctness: logic errors, off-by-one, null/undefined gaps, type mismatches
2. Test coverage: are edge cases covered? any missing failure paths?
3. Simplicity: unnecessary complexity, dead code, over-engineering
4. Consistency: does it follow existing patterns in the codebase?

Report findings with severity (blocker/warning/nit) and exact file:line references. Do not edit files.
