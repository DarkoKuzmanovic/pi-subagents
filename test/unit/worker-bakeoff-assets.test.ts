import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const bakeoffDir = path.join(root, "docs", "worker-bakeoff");
const promptPath = path.join(root, "prompts", "worker-bakeoff.md");
const modelsPath = path.join(bakeoffDir, "models.json");
const rubricPath = path.join(bakeoffDir, "rubric.md");
const tasksDir = path.join(bakeoffDir, "tasks");

const expectedModels = [
	"mimo/mimo-v2.5-pro",
	"openai-codex/gpt-5.4-mini",
	"minimax/MiniMax-M2.7-highspeed",
	"crofai/glm-5.1-precision",
];

const expectedTaskIds = ["WB-01", "WB-02", "WB-03", "WB-04", "WB-05", "WB-06"];

describe("worker bakeoff benchmark assets", () => {
	it("defines the exact candidate model set", () => {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as { candidates: Array<{ model: string }> };
		assert.deepEqual(parsed.candidates.map((candidate) => candidate.model), expectedModels);
	});

	it("ships six implementation task briefs with required scoring sections", () => {
		const taskFiles = fs.readdirSync(tasksDir).filter((file) => file.endsWith(".md")).sort();
		assert.deepEqual(taskFiles, expectedTaskIds.map((id) => `${id.toLowerCase()}.md`));

		for (const id of expectedTaskIds) {
			const content = fs.readFileSync(path.join(tasksDir, `${id.toLowerCase()}.md`), "utf-8");
			assert.match(content, new RegExp(`^# ${id}:`, "m"));
			for (const heading of ["## Goal", "## Starting point", "## Allowed scope", "## Verification", "## Scoring notes"]) {
				assert.match(content, new RegExp(`^${heading}$`, "m"), `${id} missing ${heading}`);
			}
		}
	});

	it("documents a 100-point rubric with hard safety penalties", () => {
		const rubric = fs.readFileSync(rubricPath, "utf-8");
		assert.match(rubric, /Correctness\s*\|\s*35/);
		assert.match(rubric, /Instruction fidelity\s*\|\s*15/);
		assert.match(rubric, /Minimality\/scope control\s*\|\s*15/);
		assert.match(rubric, /Total\s*\|\s*100/);
		assert.match(rubric, /-50.*deleting, overwriting, or rewriting protected files/i);
	});

	it("provides a prompt template that launches isolated worker runs", () => {
		const prompt = fs.readFileSync(promptPath, "utf-8");
		for (const model of expectedModels) {
			assert.match(prompt, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		assert.match(prompt, /worktree:\s*true/);
		assert.match(prompt, /agent:\s*"worker"/);
		assert.match(prompt, /\$@/);
	});
});
