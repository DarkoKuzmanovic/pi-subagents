import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "support", "mock-pi-script.mjs");

/** Invoke the mock child the way the runner does, including the injected output instruction. */
function runMockChild(queueDir: string, task: string, outputPath: string): void {
	const taskArg = `${task}\n\n---\n**Output:** Write your findings to: ${outputPath}`;
	const result = spawnSync(process.execPath, [SCRIPT_PATH, "--mode", "json", "-p", taskArg], {
		encoding: "utf-8",
		env: { ...process.env, MOCK_PI_QUEUE_DIR: queueDir },
	});
	assert.equal(result.status, 0, `mock pi child failed: ${result.stderr}`);
}

describe("mock pi response routing", () => {
	it("routes keyed responses by task text regardless of child start order", () => {
		const mockPi = createMockPi();
		mockPi.install();
		const tempDir = createTempDir("mock-pi-keyed-");
		try {
			mockPi.onCall({ taskIncludes: "Review file alpha.ts", writeOutput: "child alpha" });
			mockPi.onCall({ taskIncludes: "Review file beta.ts", writeOutput: "child beta" });

			// Deliberately reversed: beta claims first. That is the interleaving that made the
			// first-come queue hand "child alpha" to the beta child under full-suite concurrency.
			const betaPath = path.join(tempDir, "beta.md");
			const alphaPath = path.join(tempDir, "alpha.md");
			runMockChild(mockPi.dir, "Review file beta.ts", betaPath);
			runMockChild(mockPi.dir, "Review file alpha.ts", alphaPath);

			assert.equal(fs.readFileSync(betaPath, "utf-8"), "child beta");
			assert.equal(fs.readFileSync(alphaPath, "utf-8"), "child alpha");
		} finally {
			removeTempDir(tempDir);
			mockPi.uninstall();
		}
	});

	it("never lets a non-matching task consume a keyed response", () => {
		const mockPi = createMockPi();
		mockPi.install();
		const tempDir = createTempDir("mock-pi-reserved-");
		try {
			mockPi.onCall({ taskIncludes: "Review file alpha.ts", writeOutput: "child alpha" });
			mockPi.onCall({ writeOutput: "unkeyed filler" });

			// A task matching neither key falls through to the unkeyed response, leaving the
			// reserved one intact for its own child.
			const producerPath = path.join(tempDir, "producer.md");
			runMockChild(mockPi.dir, "List the files", producerPath);
			assert.equal(fs.readFileSync(producerPath, "utf-8"), "unkeyed filler");

			const alphaPath = path.join(tempDir, "alpha.md");
			runMockChild(mockPi.dir, "Review file alpha.ts", alphaPath);
			assert.equal(fs.readFileSync(alphaPath, "utf-8"), "child alpha");
		} finally {
			removeTempDir(tempDir);
			mockPi.uninstall();
		}
	});
});
