import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reconSource = fs.readFileSync(path.join(projectRoot, "agents", "recon.md"), "utf-8");
const reconBody = reconSource.split("---").slice(2).join("---").trim();

describe("builtin recon prompt", () => {
	it("keeps reconnaissance concise and artifact-driven", () => {
		assert.ok(reconBody.length <= 3_200, `recon prompt is ${reconBody.length} characters`);
		assert.doesNotMatch(reconBody, /Hard cap|at most \d+ `read` calls/i);
		assert.match(reconSource, /^modelPromptRole: scout$/m);
		assert.match(reconBody, /Write the artifact as soon as the main flow is clear/);
		assert.match(reconBody, /Conclusion.*Evidence.*Relevant files.*Risks.*Validation.*Unexplored/s);
		assert.ok(reconBody.indexOf("## Protocol") < reconBody.indexOf("## Workflow"));
		assert.match(reconBody, /Use small related batches when helpful; after a failed call, continue with one call at a time/);
		assert.match(reconBody, /Never write XML\/tool syntax/);
		assert.match(reconBody, /Use the smallest valid argument set; omit empty optional fields/);
		assert.match(reconBody, /If arguments start repeating, stop the call and write from current evidence/);
		assert.doesNotMatch(reconBody, /Read every file needed|Keep searching until/i);
	});
});
