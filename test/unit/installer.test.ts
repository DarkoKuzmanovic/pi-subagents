import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { deriveRepoUrl, normalizeRepoIdentity, runInstall } from "../../install.mjs";

const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(repoDir: string, fileName: string, content: string, message: string): void {
	fs.writeFileSync(path.join(repoDir, fileName), content, "utf-8");
	git(repoDir, "add", fileName);
	git(repoDir, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", message);
}

interface InstallFixture {
	barePath: string;
	extensionDir: string;
	workDir: string;
}

/** A local bare "remote" with one commit, plus a checkout at extensionDir. */
function createInstallFixture(): InstallFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-installer-"));
	tempRoots.push(root);
	const seedDir = path.join(root, "seed");
	fs.mkdirSync(seedDir);
	git(seedDir, "init", "-b", "main");
	commitFile(seedDir, "file.txt", "v1\n", "v1");
	const barePath = path.join(root, "remote.git");
	git(root, "clone", "--bare", seedDir, barePath);
	const extensionDir = path.join(root, "extensions", "subagent");
	fs.mkdirSync(path.dirname(extensionDir), { recursive: true });
	git(root, "clone", barePath, extensionDir);
	const workDir = path.join(root, "work");
	git(root, "clone", barePath, workDir);
	return { barePath, extensionDir, workDir };
}

function pushNewCommit(fixture: InstallFixture): void {
	commitFile(fixture.workDir, "file.txt", "v2\n", "v2");
	git(fixture.workDir, "push", "origin", "main");
}

const silentIo = { log: () => {}, error: () => {} };

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("installer repository identity", () => {
	// Regression (GPTPRO P0.2): install.mjs hardcoded the upstream repo URL, so
	// the published binary of this fork silently installed upstream code.
	it("derives the clone URL from package.json.repository", () => {
		const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
		const derived = deriveRepoUrl(pkg.repository);
		assert.equal(normalizeRepoIdentity(derived), "github.com/darkokuzmanovic/pi-subagents");
	});

	it("normalizes equivalent GitHub URL spellings to one identity", () => {
		const spellings = [
			"https://github.com/DarkoKuzmanovic/pi-subagents.git",
			"git+https://github.com/DarkoKuzmanovic/pi-subagents.git",
			"git@github.com:DarkoKuzmanovic/pi-subagents.git",
			"ssh://git@github.com/DarkoKuzmanovic/pi-subagents",
			"https://github.com/DarkoKuzmanovic/pi-subagents/",
		];
		for (const spelling of spellings) {
			assert.equal(
				normalizeRepoIdentity(spelling),
				"github.com/darkokuzmanovic/pi-subagents",
				`unexpected identity for ${spelling}`,
			);
		}
		assert.notEqual(
			normalizeRepoIdentity("https://github.com/nicobailon/pi-subagents.git"),
			normalizeRepoIdentity("https://github.com/DarkoKuzmanovic/pi-subagents.git"),
		);
	});

	it("converts scp-style repository fields to https clone URLs", () => {
		assert.equal(
			deriveRepoUrl("git@github.com:owner/repo.git"),
			"https://github.com/owner/repo.git",
		);
		assert.throws(() => deriveRepoUrl(undefined));
		assert.throws(() => deriveRepoUrl({ url: "" }));
	});
});

describe("installer update path", () => {
	it("fast-forwards an existing checkout with the expected remote", () => {
		const fixture = createInstallFixture();
		pushNewCommit(fixture);
		const code = runInstall({ extensionDir: fixture.extensionDir, repoUrl: fixture.barePath, ...silentIo });
		assert.equal(code, 0);
		assert.equal(fs.readFileSync(path.join(fixture.extensionDir, "file.txt"), "utf-8"), "v2\n");
	});

	it("refuses to update a checkout tracking an unexpected remote", () => {
		const fixture = createInstallFixture();
		pushNewCommit(fixture);
		git(fixture.extensionDir, "remote", "set-url", "origin", "https://github.com/nicobailon/pi-subagents.git");
		const code = runInstall({ extensionDir: fixture.extensionDir, repoUrl: fixture.barePath, ...silentIo });
		assert.equal(code, 1);
		assert.equal(
			fs.readFileSync(path.join(fixture.extensionDir, "file.txt"), "utf-8"),
			"v1\n",
			"checkout must not be touched when the remote is unexpected",
		);
	});

	it("fails instead of merging when the checkout has diverged", () => {
		const fixture = createInstallFixture();
		pushNewCommit(fixture);
		commitFile(fixture.extensionDir, "local.txt", "local\n", "diverging local commit");
		const code = runInstall({ extensionDir: fixture.extensionDir, repoUrl: fixture.barePath, ...silentIo });
		assert.equal(code, 1);
		assert.ok(!fs.existsSync(path.join(fixture.extensionDir, ".git", "MERGE_HEAD")), "no merge may be left behind");
	});

	it("refuses a destination directory that is not a git repository", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-installer-"));
		tempRoots.push(root);
		const extensionDir = path.join(root, "subagent");
		fs.mkdirSync(extensionDir);
		const code = runInstall({ extensionDir, repoUrl: "https://example.invalid/repo.git", ...silentIo });
		assert.equal(code, 1);
	});
});
