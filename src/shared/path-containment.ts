import * as fs from "node:fs";
import * as path from "node:path";

function isPathWithin(basePath: string, candidatePath: string): boolean {
	const relative = path.relative(basePath, candidatePath);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function nearestExistingAncestor(candidatePath: string, basePath: string): string | undefined {
	let current = candidatePath;
	while (true) {
		try {
			fs.lstatSync(current);
			return current;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
		if (current === basePath) return undefined;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function canonicalizeExistingAncestor(existingPath: string, outputPath: string): string {
	try {
		return fs.realpathSync(existingPath);
	} catch (error) {
		if (fs.lstatSync(existingPath).isSymbolicLink()) {
			throw new Error(`Relative output path escapes its base directory through a symlink: ${outputPath}`);
		}
		throw error;
	}
}

/** Reject a relative output path that lexically escapes its declared base directory. */
export function assertRelativeOutputPathWithinBase(outputPath: string, baseDirectory: string): void {
	if (path.isAbsolute(outputPath)) return;
	const resolvedBase = path.resolve(baseDirectory);
	const resolvedOutput = path.resolve(resolvedBase, outputPath);
	if (!isPathWithin(resolvedBase, resolvedOutput)) {
		throw new Error(`Relative output path escapes its base directory: ${outputPath}`);
	}
}

/** Resolve an output path while keeping relative values inside their declared base directory. */
export function resolveOutputPathWithinBase(
	outputPath: string,
	baseDirectory: string,
	containmentRootDirectory?: string,
): string {
	if (path.isAbsolute(outputPath)) return outputPath;

	assertRelativeOutputPathWithinBase(outputPath, baseDirectory);
	const resolvedBase = path.resolve(baseDirectory);
	const resolvedOutput = path.resolve(resolvedBase, outputPath);

	// A materialized namespace may not exist yet. When its owning root is known,
	// canonicalize the nearest existing namespace ancestor before any mkdir can
	// follow an intermediate symlink outside that root.
	if (containmentRootDirectory) {
		const resolvedContainmentRoot = path.resolve(containmentRootDirectory);
		if (!isPathWithin(resolvedContainmentRoot, resolvedBase)) {
			throw new Error(`Relative output path base directory escapes its containment root: ${baseDirectory}`);
		}
		let containmentRootStat: fs.Stats;
		try {
			containmentRootStat = fs.statSync(resolvedContainmentRoot);
		} catch (error) {
			throw new Error(`Relative output path containment root is unavailable: ${resolvedContainmentRoot}`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		if (!containmentRootStat.isDirectory()) {
			throw new Error(`Relative output path containment root is not a directory: ${resolvedContainmentRoot}`);
		}
		const existingBaseAncestor = nearestExistingAncestor(resolvedBase, resolvedContainmentRoot);
		if (!existingBaseAncestor) {
			throw new Error(`Relative output path containment root disappeared: ${resolvedContainmentRoot}`);
		}
		const canonicalContainmentRoot = fs.realpathSync(resolvedContainmentRoot);
		const canonicalBaseAncestor = canonicalizeExistingAncestor(existingBaseAncestor, outputPath);
		if (!isPathWithin(canonicalContainmentRoot, canonicalBaseAncestor)) {
			throw new Error(`Relative output path escapes its base directory through a symlink: ${outputPath}`);
		}
	}

	// The output may not exist yet. Canonicalize its nearest existing ancestor so an
	// in-base symlink cannot redirect the eventual write outside the allowed root.
	if (!fs.existsSync(resolvedBase)) return resolvedOutput;
	const existingAncestor = nearestExistingAncestor(resolvedOutput, resolvedBase);
	if (!existingAncestor) return resolvedOutput;
	const canonicalBase = fs.realpathSync(resolvedBase);
	const canonicalAncestor = canonicalizeExistingAncestor(existingAncestor, outputPath);
	if (!isPathWithin(canonicalBase, canonicalAncestor)) {
		throw new Error(`Relative output path escapes its base directory through a symlink: ${outputPath}`);
	}
	return resolvedOutput;
}

/** Revalidate an already-resolved path that originated from a relative output declaration. */
export function revalidateResolvedRelativeOutputPath(outputPath: string, baseDirectory: string, containmentRootDirectory = baseDirectory): string {
	const resolvedBase = path.resolve(baseDirectory);
	const resolvedOutput = path.resolve(outputPath);
	if (!isPathWithin(resolvedBase, resolvedOutput)) {
		throw new Error(`Resolved relative output path escapes its base directory: ${outputPath}`);
	}
	const relativeOutput = path.relative(resolvedBase, resolvedOutput) || ".";
	const revalidatedOutput = resolveOutputPathWithinBase(relativeOutput, resolvedBase, containmentRootDirectory);
	if (revalidatedOutput !== resolvedOutput) {
		throw new Error(`Resolved relative output path changed during revalidation: ${outputPath}`);
	}
	return resolvedOutput;
}

/** Materialize a generated directory only while it remains inside its owning root. */
export function materializeDirectoryWithinRoot(directoryPath: string, containmentRootDirectory: string): string {
	const resolvedDirectory = path.resolve(directoryPath);
	resolveOutputPathWithinBase(".", resolvedDirectory, containmentRootDirectory);
	fs.mkdirSync(resolvedDirectory, { recursive: true });
	const materializedDirectory = resolveOutputPathWithinBase(".", resolvedDirectory, containmentRootDirectory);
	if (materializedDirectory !== resolvedDirectory) {
		throw new Error(`Generated directory changed during namespace materialization: ${resolvedDirectory}`);
	}
	return resolvedDirectory;
}
