import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import { resolveJitiCliPath, type JitiResolverDeps, type RequireLike } from "../../src/runs/background/async-execution.ts";

/**
 * Fake-require that resolves a set of known package paths and throws for the rest.
 *
 * We only need `resolve` to match Node's `require.resolve` shape closely enough
 * for the resolver under test. The other Require methods are unused.
 */
function fakeRequire(resolutions: Record<string, string>): RequireLike {
	return {
		resolve(id: string): string {
			const hit = resolutions[id];
			if (hit) return hit;
			throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
		},
	};
}

const localBareJitiPkg = "/ext/node_modules/jiti/package.json";
const localScopedJitiPkg = "/ext/node_modules/@earendil-works/jiti/package.json";
const piBareJitiPkg = "/pi/node_modules/jiti/package.json";
const piScopedJitiPkg = "/pi/node_modules/@earendil-works/jiti/package.json";

const expectedCli = (pkgPath: string) => path.join(path.dirname(pkgPath), "lib/jiti-cli.mjs");

describe("resolveJitiCliPath", () => {
	test("returns local bare `jiti` first when all four candidates resolve and exist", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({ "jiti/package.json": localBareJitiPkg, "@earendil-works/jiti/package.json": localScopedJitiPkg }),
			piRequire: fakeRequire({ "jiti/package.json": piBareJitiPkg, "@earendil-works/jiti/package.json": piScopedJitiPkg }),
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), expectedCli(localBareJitiPkg));
	});

	test("falls back to local @earendil-works/jiti when local bare jiti is absent", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({ "@earendil-works/jiti/package.json": localScopedJitiPkg }),
			piRequire: fakeRequire({ "jiti/package.json": piBareJitiPkg, "@earendil-works/jiti/package.json": piScopedJitiPkg }),
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), expectedCli(localScopedJitiPkg));
	});

	test("falls back to pi-bundled @earendil-works/jiti when no local jiti is available", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({}),
			piRequire: fakeRequire({ "jiti/package.json": piBareJitiPkg, "@earendil-works/jiti/package.json": piScopedJitiPkg }),
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), expectedCli(piScopedJitiPkg));
	});

	test("falls back to pi-bundled bare `jiti` when only that candidate exists", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({}),
			piRequire: fakeRequire({ "jiti/package.json": piBareJitiPkg }),
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), expectedCli(piBareJitiPkg));
	});

	test("returns undefined when no candidate resolves", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({}),
			piRequire: fakeRequire({}),
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), undefined);
	});

	test("returns undefined when piRequire is missing and no local jiti", () => {
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({}),
			piRequire: undefined,
			fileExists: () => true,
		};
		assert.strictEqual(resolveJitiCliPath(deps), undefined);
	});

	test("skips candidates whose CLI file does not exist on disk", () => {
		// Local bare jiti resolves but the CLI file is missing; should fall through to local scoped.
		const deps: JitiResolverDeps = {
			localRequire: fakeRequire({ "jiti/package.json": localBareJitiPkg, "@earendil-works/jiti/package.json": localScopedJitiPkg }),
			piRequire: undefined,
			fileExists: (p) => p !== expectedCli(localBareJitiPkg),
		};
		assert.strictEqual(resolveJitiCliPath(deps), expectedCli(localScopedJitiPkg));
	});
});
