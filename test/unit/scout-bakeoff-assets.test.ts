import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();
const bakeoffDir = path.join(root, "docs", "scout-bakeoff");
const promptPath = path.join(root, "prompts", "scout-bakeoff.md");
const modelsPath = path.join(bakeoffDir, "models.json");
const rubricPath = path.join(bakeoffDir, "rubric.md");
const tasksDir = path.join(bakeoffDir, "tasks");

const expectedModels = [
	"minimax/MiniMax-M2.7-highspeed",
	"crofai/qwen3.5-9b",
	"crofai/greg-1-mini",
	"crofai/kimi-k2.5-lightning",
	"openai-codex/gpt-5.3-codex-spark",
];

const expectedTaskIds = ["SB-01", "SB-02", "SB-03", "SB-04", "SB-05"];

describe("scout bakeoff benchmark assets", () => {
	it("defines the exact candidate scout model set", () => {
		const parsed = JSON.parse(fs.readFileSync(modelsPath, "utf-8")) as { candidates: Array<{ model: string; agent: string }> };
		assert.deepEqual(parsed.candidates.map((candidate) => candidate.model), expectedModels);
		assert.deepEqual(parsed.candidates.map((candidate) => candidate.agent), expectedModels.map(() => "scout"));
	});

	it("ships five read-only scout task briefs with required scoring sections", () => {
		const taskFiles = fs.readdirSync(tasksDir).filter((file) => file.endsWith(".md")).sort();
		assert.deepEqual(taskFiles, expectedTaskIds.map((id) => `${id.toLowerCase()}.md`));

		for (const id of expectedTaskIds) {
			const content = fs.readFileSync(path.join(tasksDir, `${id.toLowerCase()}.md`), "utf-8");
			assert.match(content, new RegExp(`^# ${id}:`, "m"));
			for (const heading of ["## Goal", "## Starting point", "## Allowed scope", "## Expected evidence", "## Scoring notes"]) {
				assert.match(content, new RegExp(`^${heading}$`, "m"), `${id} missing ${heading}`);
			}
			assert.match(content, /read-only/i, `${id} must remain read-only`);
		}
	});

	it("documents a 100-point scout rubric weighted toward precise fast recon", () => {
		const rubric = fs.readFileSync(rubricPath, "utf-8");
		assert.match(rubric, /Precision and factual accuracy\s*\|\s*30/);
		assert.match(rubric, /Coverage of relevant surface area\s*\|\s*20/);
		assert.match(rubric, /Signal-to-noise and brevity\s*\|\s*15/);
		assert.match(rubric, /Speed\s*\|\s*10/);
		assert.match(rubric, /Cost efficiency\s*\|\s*10/);
		assert.match(rubric, /Total\s*\|\s*100/);
		assert.match(rubric, /-50.*mutating the repository/i);
	});

	it("provides a prompt template that launches isolated scout runs", () => {
		const prompt = fs.readFileSync(promptPath, "utf-8");
		for (const model of expectedModels) {
			assert.match(prompt, new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		assert.match(prompt, /agent:\s*"scout"/);
		assert.match(prompt, /context:\s*"fresh"/);
		assert.match(prompt, /worktree:\s*false/);
		assert.match(prompt, /\$@/);
	});
});
