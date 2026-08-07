#!/usr/bin/env node

/**
 * pi-subagents installer
 *
 * Usage:
 *   npx pi-subagents          # Install to ~/.pi/agent/extensions/subagent
 *   npx pi-subagents --remove # Remove the extension
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent");

/**
 * Reduce any supported GitHub URL spelling (https, git+https, ssh, scp-like)
 * to a comparable `github.com/owner/repo` identity.
 */
export function normalizeRepoIdentity(url) {
	if (typeof url !== "string") return "";
	let identity = url.trim().toLowerCase();
	identity = identity.replace(/^git\+/, "");
	identity = identity.replace(/^(https?|git|ssh):\/\//, "");
	identity = identity.replace(/^[^@/]+@/, "");
	identity = identity.replace(/^([^/:]+):(?!\/)/, "$1/");
	identity = identity.replace(/\.git$/, "");
	identity = identity.replace(/\/+$/, "");
	return identity;
}

/**
 * Derive the clone URL from package.json's repository field so the published
 * binary can never silently point at a different repository than the package
 * it ships with.
 */
export function deriveRepoUrl(repositoryField) {
	const raw = typeof repositoryField === "string" ? repositoryField : repositoryField?.url;
	if (typeof raw !== "string" || raw.trim() === "") {
		throw new Error("package.json is missing a usable repository URL");
	}
	let url = raw.trim().replace(/^git\+/, "");
	const scpMatch = url.match(/^([^@/]+)@([^:/]+):(.+)$/);
	if (scpMatch) {
		url = `https://${scpMatch[2]}/${scpMatch[3]}`;
	}
	if (!/^https?:\/\//.test(url)) {
		throw new Error(`Unsupported repository URL format: ${raw}`);
	}
	return url;
}

function readPackageRepoUrl() {
	const pkgPath = fileURLToPath(new URL("./package.json", import.meta.url));
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
	return deriveRepoUrl(pkg.repository);
}

/**
 * Install or update the extension checkout. Returns a process exit code.
 * Exported so tests can drive the update/rejection paths against local repos.
 */
export function runInstall({ extensionDir, repoUrl, log = console.log, error = console.error }) {
	const parentDir = path.dirname(extensionDir);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}

	if (fs.existsSync(extensionDir)) {
		if (!fs.existsSync(path.join(extensionDir, ".git"))) {
			log(`Directory exists but is not a git repo: ${extensionDir}`);
			log("Remove it first with: npx pi-subagents --remove");
			return 1;
		}

		let originUrl;
		try {
			originUrl = execFileSync("git", ["-C", extensionDir, "remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
		} catch {
			error(`Could not read remote.origin.url of ${extensionDir}`);
			error("Remove it and reinstall: npx pi-subagents --remove && npx pi-subagents");
			return 1;
		}

		if (normalizeRepoIdentity(originUrl) !== normalizeRepoIdentity(repoUrl)) {
			error(`Refusing to update: ${extensionDir} tracks an unexpected repository.`);
			error(`  found:    ${originUrl}`);
			error(`  expected: ${repoUrl}`);
			error("Remove it and reinstall: npx pi-subagents --remove && npx pi-subagents");
			return 1;
		}

		log("Updating existing installation...");
		try {
			execFileSync("git", ["-C", extensionDir, "pull", "--ff-only"], { stdio: "inherit" });
			log("\npi-subagents updated");
		} catch {
			error("Failed to update (fast-forward only). Try removing and reinstalling:");
			error("  npx pi-subagents --remove && npx pi-subagents");
			return 1;
		}
	} else {
		log(`Cloning to ${extensionDir}...`);
		try {
			execFileSync("git", ["clone", repoUrl, extensionDir], { stdio: "inherit" });
			log("\npi-subagents installed");
		} catch {
			error("Failed to clone repository");
			return 1;
		}
	}

	log(`
The extension is now available in pi. Tool added:
  • subagent - Delegate tasks to agents and inspect run status

Documentation: ${extensionDir}/README.md
`);
	return 0;
}

function main() {
	const args = process.argv.slice(2);
	const isRemove = args.includes("--remove") || args.includes("-r");
	const isHelp = args.includes("--help") || args.includes("-h");

	if (isHelp) {
		console.log(`
pi-subagents - Pi extension for delegating tasks to subagents

Usage:
  npx pi-subagents          Install the extension
  npx pi-subagents --remove Remove the extension
  npx pi-subagents --help   Show this help

Installation directory: ${DEFAULT_EXTENSION_DIR}
`);
		return 0;
	}

	if (isRemove) {
		if (fs.existsSync(DEFAULT_EXTENSION_DIR)) {
			console.log(`Removing ${DEFAULT_EXTENSION_DIR}...`);
			fs.rmSync(DEFAULT_EXTENSION_DIR, { recursive: true });
			console.log("pi-subagents removed");
		} else {
			console.log("pi-subagents is not installed");
		}
		return 0;
	}

	console.log("Installing pi-subagents...\n");
	return runInstall({ extensionDir: DEFAULT_EXTENSION_DIR, repoUrl: readPackageRepoUrl() });
}

const isExecutedDirectly = (() => {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
})();

if (isExecutedDirectly) {
	process.exit(main());
}
