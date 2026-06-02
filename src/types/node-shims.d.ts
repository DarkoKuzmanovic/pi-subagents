// Minimal Node.js type shims for local source typechecking without bundling @types/node.
// Runtime code still executes on Node; this file only provides the narrow shapes used here.

declare namespace NodeJS {
	type Timeout = number;
	type Signals = string;
	type Platform = string;
	interface ErrnoException extends Error { code?: string; errno?: number; path?: string; syscall?: string; }
	interface ProcessEnv {
		[key: string]: string | undefined;
	}
	interface Process {
		env: ProcessEnv;
		pid: number;
		platform: string;
		execPath: string;
		stdout: { columns?: number; rows?: number; write?: (...args: unknown[]) => unknown };
		stderr: { write?: (...args: unknown[]) => unknown };
		stdin: { on(event: string, listener: (...args: any[]) => void): unknown; resume?(): void; setEncoding?(encoding: string): void };
		argv: string[];
		cwd(): string;
		exit(code?: number): never;
		getuid?: () => number;
		kill(pid: number, signal?: Signals): boolean;
		on(event: string, listener: (...args: any[]) => void): this;
	}
}

declare const process: NodeJS.Process;
declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): NodeJS.Timeout;
declare function clearTimeout(timeout?: NodeJS.Timeout | number | null): void;
declare function setInterval(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): NodeJS.Timeout;
declare function clearInterval(timeout?: NodeJS.Timeout | number | null): void;
interface Number { unref?: () => void; }

declare class Buffer extends Uint8Array {
	static byteLength(value: string, encoding?: string): number;
	static alloc(size: number): Buffer;
	static isBuffer(value: unknown): value is Buffer;
	static from(value: string | ArrayBuffer | Uint8Array, encoding?: string): Buffer;
	static concat(buffers: readonly Uint8Array[]): Buffer;
	toString(encoding?: string): string;
	lastIndexOf(value: number, byteOffset?: number): number;
	subarray(start?: number, end?: number): Buffer;
}

declare module "node:fs" {
	export interface FSWatcher { close(): void; unref?(): void; on(event: string, listener: (...args: any[]) => void): this; }
	export interface Stats { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number; }
	export interface Dirent { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; }
	export const accessSync: (...args: unknown[]) => unknown;
	export const closeSync: (...args: unknown[]) => void;
	export const constants: Record<string, number>;
	export const createWriteStream: (...args: unknown[]) => any;
	export const existsSync: (path: string) => boolean;
	export const fstatSync: (...args: unknown[]) => Stats;
	export const globSync: (...args: unknown[]) => string[];
	export const lstatSync: (path: string) => Stats;
	export const mkdirSync: (...args: unknown[]) => unknown;
	export const mkdtempSync: (...args: unknown[]) => string;
	export const openSync: (...args: unknown[]) => number;
	export const readFileSync: (...args: unknown[]) => string;
	export const appendFileSync: (...args: unknown[]) => void;
	export const readSync: (...args: unknown[]) => number;
	export const readdirSync: (...args: unknown[]) => any;
	export const realpathSync: (...args: unknown[]) => string;
	export const renameSync: (...args: unknown[]) => void;
	export const rmSync: (...args: unknown[]) => void;
	export const statSync: (path: string) => Stats;
	export const symlinkSync: (...args: unknown[]) => void;
	export const unlinkSync: (...args: unknown[]) => void;
	export const watch: (...args: unknown[]) => FSWatcher;
	export const writeFileSync: (...args: unknown[]) => void;
}

declare module "node:path" {
	export const join: (...parts: string[]) => string;
	export const resolve: (...parts: string[]) => string;
	export const dirname: (path: string) => string;
	export const basename: (path: string, suffix?: string) => string;
	export const extname: (path: string) => string;
	export const relative: (from: string, to: string) => string;
	export const isAbsolute: (path: string) => boolean;
	export const normalize: (path: string) => string;
	export const sep: string;
}

declare module "node:os" {
	export const homedir: () => string;
	export const tmpdir: () => string;
	export const userInfo: () => { username?: string | null };
}

declare module "node:url" {
	export const fileURLToPath: (url: string | URL) => string;
	export const pathToFileURL: (path: string) => URL;
}

declare module "node:child_process" {
	export interface ChildProcess { [key: string]: any; pid?: number; stdout: any; stderr: any; stdin: any; on(event: string, listener: (...args: any[]) => void): this; kill(signal?: string): boolean; unref(): void; }
	export const spawn: (...args: unknown[]) => ChildProcess;
	export const spawnSync: (...args: unknown[]) => { status: number | null; stdout?: any; stderr?: any; error?: Error };
	export const execSync: (...args: unknown[]) => string;
}

declare module "node:crypto" {
	export const randomUUID: () => string;
	export const createHash: (algorithm: string) => { update(data: string | Uint8Array): { digest(encoding: "hex"): string } };
}

declare module "node:module" {
	export const createRequire: (filename: string | URL) => NodeRequire;
}

declare interface NodeRequire {
	(id: string): any;
	resolve(id: string): string;
}
