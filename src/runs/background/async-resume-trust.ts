import * as fs from "node:fs";
import * as path from "node:path";
import { writeDurableJson } from "../../shared/durable-json.ts";

export const ASYNC_RESUME_TRUST_FILENAME = "resume-trust.json";
export const ASYNC_RESUME_TRUST_DIRECTORY = "resume-trust";
const ASYNC_RESUME_TRUST_SCHEMA_VERSION = 1;

export interface AsyncResumeLaunchTrust {
	trustedSessionRoots: string[];
	trustedSessionFiles: string[];
}

interface PersistAsyncResumeLaunchTrustInput {
	trustedSessionRoots?: Array<string | undefined>;
	trustedSessionFiles?: Array<string | undefined>;
}

function asyncResumeTrustPath(asyncDir: string): string {
	return path.join(asyncDir, ASYNC_RESUME_TRUST_DIRECTORY, ASYNC_RESUME_TRUST_FILENAME);
}

function normalizeAbsolutePaths(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0).map((value) => path.resolve(value)))];
}

function parseAbsolutePathArray(value: unknown, field: keyof AsyncResumeLaunchTrust, trustPath: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`Async resume launch trust '${trustPath}' has invalid ${field}; expected an array.`);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || !path.isAbsolute(entry)) {
			throw new Error(`Async resume launch trust '${trustPath}' has invalid ${field}[${index}]; expected an absolute path.`);
		}
		return path.resolve(entry);
	});
}

/** Persist the launch-owned roots and exact files that a completed async run may safely resume. */
export function persistAsyncResumeLaunchTrust(asyncDir: string, input: PersistAsyncResumeLaunchTrustInput): void {
	const trustedSessionRoots = normalizeAbsolutePaths(input.trustedSessionRoots ?? []);
	const trustedSessionFiles = normalizeAbsolutePaths(input.trustedSessionFiles ?? []);
	const trustDir = path.join(asyncDir, ASYNC_RESUME_TRUST_DIRECTORY);
	fs.mkdirSync(trustDir, { mode: 0o700 });
	const trustPath = asyncResumeTrustPath(asyncDir);
	writeDurableJson(trustPath, {
		schemaVersion: ASYNC_RESUME_TRUST_SCHEMA_VERSION,
		trustedSessionRoots,
		trustedSessionFiles,
	});
}

/** Read parent-authored async resume trust metadata; malformed metadata fails closed. */
export function readAsyncResumeLaunchTrust(asyncDir: string): AsyncResumeLaunchTrust {
	const trustDir = path.join(asyncDir, ASYNC_RESUME_TRUST_DIRECTORY);
	if (!fs.existsSync(trustDir)) return { trustedSessionRoots: [], trustedSessionFiles: [] };
	const trustDirStat = fs.lstatSync(trustDir);
	if (!trustDirStat.isDirectory() || trustDirStat.isSymbolicLink()) {
		throw new Error(`Async resume launch trust directory '${trustDir}' must be a regular directory.`);
	}
	const trustPath = asyncResumeTrustPath(asyncDir);
	if (!fs.existsSync(trustPath)) throw new Error(`Async resume launch trust file is missing: ${trustPath}`);
	const stat = fs.lstatSync(trustPath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Async resume launch trust '${trustPath}' must be a regular file.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(trustPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Async resume launch trust '${trustPath}' is not valid JSON: ${message}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Async resume launch trust '${trustPath}' must contain a JSON object.`);
	}
	const record = parsed as Record<string, unknown>;
	if (record.schemaVersion !== ASYNC_RESUME_TRUST_SCHEMA_VERSION) {
		throw new Error(`Async resume launch trust '${trustPath}' has unsupported schemaVersion.`);
	}
	return {
		trustedSessionRoots: parseAbsolutePathArray(record.trustedSessionRoots, "trustedSessionRoots", trustPath),
		trustedSessionFiles: parseAbsolutePathArray(record.trustedSessionFiles, "trustedSessionFiles", trustPath),
	};
}
