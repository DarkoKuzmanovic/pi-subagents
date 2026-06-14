import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildPiArgs } from "../../src/runs/shared/pi-args.js";
import {
	cleanupStructuredOutputRuntime,
	createStructuredOutputRuntime,
	readStructuredOutput,
} from "../../src/runs/shared/structured-output.js";

/**
 * Live, model-gated regression test for the restricted-`tools:` structured_output bug
 * (commit df69fa6). Skipped by default because it spawns a real `pi` child that makes a
 * model call. Run it deliberately:
 *
 *   PI_LIVE_SMOKE=1 npm run test:integration
 *   PI_LIVE_SMOKE=1 PI_LIVE_SMOKE_MODEL=anthropic/claude-opus-4-7 npm run test:integration
 *
 * The class of bug this guards (an agent's `--tools` allowlist filtering out the
 * extension-registered structured_output tool) cannot be caught by any non-spawning test;
 * the deterministic companion guard lives in test/unit/pi-args.test.ts.
 */
const live = process.env.PI_LIVE_SMOKE === "1";
const model = process.env.PI_LIVE_SMOKE_MODEL ?? "openai-codex/gpt-5.5";

describe("structured output live smoke (spawns a real child)", () => {
	it(
		"a restricted-tools agent can still call structured_output end-to-end (TC-3)",
		{ skip: live ? false : "set PI_LIVE_SMOKE=1 (needs a real pi + model access) to run" },
		() => {
			const schema = {
				type: "object",
				properties: { n: { type: "number" }, color: { type: "string" } },
				required: ["n", "color"],
				additionalProperties: false,
			};
			const rt = createStructuredOutputRuntime(schema as never);
			try {
				const { args, env } = buildPiArgs({
					baseArgs: ["--mode", "json", "-p"],
					task: 'Call the structured_output tool exactly once with {"n":7,"color":"blue"} and produce no other output.',
					sessionEnabled: false,
					inheritProjectContext: false,
					inheritSkills: false,
					model,
					// Restricted allowlist that deliberately omits structured_output.
					// The fix must inject it because a schema is active.
					tools: ["read", "grep", "bash"],
					structuredOutput: { schemaPath: rt.schemaPath, outputPath: rt.outputPath },
				});

				// Deterministic half of the guard: the fix injected structured_output into --tools.
				const toolsArg = args[args.indexOf("--tools") + 1] ?? "";
				assert.ok(
					toolsArg.split(",").includes("structured_output"),
					`--tools must include structured_output when a schema is active; got: ${toolsArg}`,
				);

				const mergedEnv: Record<string, string> = {};
				for (const [k, v] of Object.entries({ ...process.env, ...env })) {
					if (v !== undefined) mergedEnv[k] = v;
				}

				const res = spawnSync("pi", args, {
					env: mergedEnv,
					encoding: "utf-8",
					timeout: 180_000,
					maxBuffer: 64 * 1024 * 1024,
				});
				assert.equal(res.error, undefined, `spawn error: ${res.error?.message}`);

				// Live half: the child actually registered + called the tool, and the capture round-trips.
				const out = readStructuredOutput(rt);
				assert.ok(!out.error, `structured_output round-trip failed: ${out.error}`);
				assert.deepEqual(out.value, { n: 7, color: "blue" });
			} finally {
				cleanupStructuredOutputRuntime(rt);
			}
		},
	);
});
