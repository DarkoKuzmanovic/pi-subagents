/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --experimental-transform-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. Some source files use TypeScript parameter properties (constructor(private x: T))
 *    which require --experimental-transform-types (not just strip-types).
 *
 * It also redirects run-history writes to a throwaway temp file so the
 * integration suite (which drives the real executeChain/runSync) never pollutes
 * the per-user production history at ~/.pi/agent/run-history.jsonl.
 */

import * as os from "node:os";
import * as path from "node:path";
import { register } from "node:module";

if (!process.env.PI_SUBAGENTS_HISTORY_PATH) {
	process.env.PI_SUBAGENTS_HISTORY_PATH = path.join(
		os.tmpdir(),
		`pi-subagents-test-run-history-${process.pid}.jsonl`,
	);
}

register(new URL("./ts-loader.mjs", import.meta.url));
