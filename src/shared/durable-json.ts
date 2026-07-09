import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DURABLE_ROOT_DIR_MODE = 0o700;
export const DURABLE_FILE_MODE = 0o600;
export const DURABLE_WRITE_DEGRADED_REASON = "directory_fsync_unsupported";

export interface ValidatedDurableRoot {
	configuredPath: string;
	canonicalPath: string;
}

export interface DurableWriteCommitted {
	status: "committed";
	path: string;
	tempPath: string;
	sha256: string;
	byteLength: number;
}

export interface DurableWriteDegraded {
	status: "degraded";
	reason: typeof DURABLE_WRITE_DEGRADED_REASON;
	path: string;
	tempPath: string;
	sha256: string;
	byteLength: number;
}

export type DurableWriteResult = DurableWriteCommitted | DurableWriteDegraded;

interface FsStat {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
	mode?: number;
	uid?: number;
}

interface DurableFsOps {
	existsSync(targetPath: string): boolean;
	lstatSync(targetPath: string): FsStat;
	realpathSync(targetPath: string): string;
	mkdirSync(targetPath: string, options?: { recursive?: boolean; mode?: number }): unknown;
	openSync(targetPath: string, flags: number, mode?: number): number;
	writeFileSync(target: number | string, data: string, encoding?: string): void;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	linkSync(existingPath: string, newPath: string): void;
	renameSync(fromPath: string, toPath: string): void;
	readFileSync(targetPath: string, encoding: string): string;
	rmSync(targetPath: string, options?: { force?: boolean }): void;
}

export interface WriteDurableJsonOptions {
	fsOps?: Partial<DurableFsOps>;
	exclusive?: boolean;
}

const defaultFsOps: DurableFsOps = {
	existsSync: fs.existsSync,
	lstatSync: (targetPath) => fs.lstatSync(targetPath) as FsStat,
	realpathSync: (targetPath) => fs.realpathSync(targetPath),
	mkdirSync: (targetPath, options) => fs.mkdirSync(targetPath, options),
	openSync: (targetPath, flags, mode) => fs.openSync(targetPath, flags, mode),
	writeFileSync: (target, data, encoding) => {
		(fs.writeFileSync as unknown as (targetPath: string | number, content: string, options?: string) => void)(target, data, encoding);
	},
	fsyncSync: (fd) => (fs as unknown as { fsyncSync(fd: number): void }).fsyncSync(fd),
	closeSync: fs.closeSync,
	linkSync: (existingPath, newPath) => (fs as unknown as { linkSync(existingPath: string, newPath: string): void }).linkSync(existingPath, newPath),
	renameSync: fs.renameSync,
	readFileSync: (targetPath, encoding) => (fs.readFileSync as unknown as (targetPath: string, encoding: string) => string)(targetPath, encoding),
	rmSync: (targetPath, options) => fs.rmSync(targetPath, options),
};

export function validateDurableRoot(rootPath: string): ValidatedDurableRoot {
	const resolved = path.resolve(rootPath);
	assertNoSymlinkedAbsoluteAncestors(resolved);
	const rootStat = defaultFsOps.lstatSync(resolved);
	if (rootStat.isSymbolicLink()) throw new Error(`Durable root must not be a symlink: ${rootPath}`);
	if (!rootStat.isDirectory()) throw new Error(`Durable root must be a directory: ${rootPath}`);
	assertOwnerOnly(rootStat, resolved, "Durable root");
	return {
		configuredPath: rootPath,
		canonicalPath: defaultFsOps.realpathSync(resolved),
	};
}

export function resolveDurableRootPath(root: ValidatedDurableRoot, ...segments: string[]): string {
	if (segments.length === 0) throw new Error("Durable path requires at least one relative segment.");
	const targetPath = path.resolve(root.canonicalPath, ...segments);
	assertWithinRoot(root.canonicalPath, targetPath);
	assertNoSymlinkedAncestors(root.canonicalPath, targetPath);
	return targetPath;
}

export function writeDurableJson(filePath: string, payload: unknown, options?: WriteDurableJsonOptions): DurableWriteResult {
	const fsOps: DurableFsOps = { ...defaultFsOps, ...options?.fsOps };
	const canonicalJson = canonicalJsonStringify(payload);
	const sha256 = sha256Hex(canonicalJson);
	const byteLength = Buffer.byteLength(canonicalJson, "utf-8");
	const targetPath = path.resolve(filePath);
	const targetDir = path.dirname(targetPath);
	const tempPath = path.join(targetDir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
	const exclusive = options?.exclusive ?? true;
	let tempFd: number | undefined;
	let dirFd: number | undefined;

	assertNoSymlinkedAbsoluteAncestors(targetDir, fsOps);
	ensureDirectory(targetDir, fsOps);
	assertNoSymlinkedAbsoluteAncestors(targetPath, fsOps);

	try {
		tempFd = fsOps.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, DURABLE_FILE_MODE);
		fsOps.writeFileSync(tempFd, canonicalJson, "utf-8");
		fsOps.fsyncSync(tempFd);
		fsOps.closeSync(tempFd);
		tempFd = undefined;
		if (exclusive) {
			fsOps.linkSync(tempPath, targetPath);
		} else {
			fsOps.renameSync(tempPath, targetPath);
		}

		const reopened = fsOps.readFileSync(targetPath, "utf-8");
		if (sha256Hex(reopened) !== sha256) throw new Error(`Durable write hash mismatch for ${targetPath}`);
		if (Buffer.byteLength(reopened, "utf-8") !== byteLength) throw new Error(`Durable write byte-length mismatch for ${targetPath}`);

		try {
			dirFd = fsOps.openSync(targetDir, fs.constants.O_RDONLY);
			fsOps.fsyncSync(dirFd);
		} catch (error) {
			if (isUnsupportedDirectorySync(error)) {
				return {
					status: "degraded",
					reason: DURABLE_WRITE_DEGRADED_REASON,
					path: targetPath,
					tempPath,
					sha256,
					byteLength,
				};
			}
			throw error;
		} finally {
			if (dirFd !== undefined) {
				fsOps.closeSync(dirFd);
				dirFd = undefined;
			}
		}

		return {
			status: "committed",
			path: targetPath,
			tempPath,
			sha256,
			byteLength,
		};
	} finally {
		if (tempFd !== undefined) {
			try {
				fsOps.closeSync(tempFd);
			} catch {}
		}
		try {
			fsOps.rmSync(tempPath, { force: true });
		} catch {}
		if (dirFd !== undefined) {
			try {
				fsOps.closeSync(dirFd);
			} catch {}
		}
	}
}

function canonicalJsonStringify(value: unknown): string {
	return JSON.stringify(normalizeJsonValue(value));
}

function normalizeJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item));
	if (!isPlainObject(value)) return value;
	const source = value as Record<string, unknown>;
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
		normalized[key] = normalizeJsonValue(source[key]);
	}
	return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function ensureDirectory(directoryPath: string, fsOps: DurableFsOps): void {
	fsOps.mkdirSync(directoryPath, { recursive: true, mode: DURABLE_ROOT_DIR_MODE });
	const stat = fsOps.lstatSync(directoryPath);
	if (stat.isSymbolicLink()) throw new Error(`Durable directory must not be a symlink: ${directoryPath}`);
	if (!stat.isDirectory()) throw new Error(`Durable directory must be a directory: ${directoryPath}`);
	assertOwnerOnly(stat, directoryPath, "Durable directory");
}

function assertWithinRoot(rootPath: string, targetPath: string): void {
	const relative = path.relative(rootPath, targetPath);
	if (relative === "") throw new Error(`Durable target must not be the root directory itself: ${targetPath}`);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Durable target is outside the canonical root: ${targetPath}`);
	}
}

function assertNoSymlinkedAbsoluteAncestors(targetPath: string, fsOps: DurableFsOps = defaultFsOps): void {
	const resolved = path.resolve(targetPath);
	let rootPath = resolved;
	let parentPath = path.dirname(rootPath);
	while (parentPath !== rootPath) {
		rootPath = parentPath;
		parentPath = path.dirname(rootPath);
	}
	const relative = path.relative(rootPath, resolved);
	if (!relative || relative === ".") return;
	let currentPath = rootPath;
	for (const segment of relative.split(path.sep)) {
		currentPath = path.join(currentPath, segment);
		if (!fsOps.existsSync(currentPath)) continue;
		const stat = fsOps.lstatSync(currentPath);
		if (stat.isSymbolicLink()) throw new Error(`Durable path must not traverse symlinks: ${currentPath}`);
		const isLeaf = currentPath === resolved;
		if (!isLeaf && !stat.isDirectory()) throw new Error(`Durable path ancestor is not a directory: ${currentPath}`);
	}
}

function assertNoSymlinkedAncestors(rootPath: string, targetPath: string, fsOps: DurableFsOps = defaultFsOps): void {
	const relative = path.relative(rootPath, targetPath);
	if (!relative || relative === ".") return;
	let currentPath = rootPath;
	for (const segment of relative.split(path.sep)) {
		currentPath = path.join(currentPath, segment);
		if (!fsOps.existsSync(currentPath)) continue;
		const stat = fsOps.lstatSync(currentPath);
		if (stat.isSymbolicLink()) throw new Error(`Durable path must not traverse symlinks: ${currentPath}`);
		const isLeaf = currentPath === targetPath;
		if (!isLeaf && !stat.isDirectory()) throw new Error(`Durable path ancestor is not a directory: ${currentPath}`);
	}
}

function assertOwnerOnly(stat: FsStat, targetPath: string, label: string): void {
	const mode = typeof stat.mode === "number" ? stat.mode & 0o777 : undefined;
	if (typeof mode === "number" && (mode & 0o077) !== 0) {
		throw new Error(`${label} must be owner-only (0700/0600 style permissions): ${targetPath}`);
	}
	const getuid = process.getuid?.bind(process);
	if (typeof getuid === "function" && typeof stat.uid === "number" && stat.uid !== getuid()) {
		throw new Error(`${label} must be owned by the current user: ${targetPath}`);
	}
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	const code = typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code ?? "")
		: "";
	return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS";
}
