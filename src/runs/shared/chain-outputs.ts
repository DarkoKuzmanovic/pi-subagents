import { isDynamicParallelStep, isParallelStep, type ChainStep, type SequentialStep } from "../../shared/settings.ts";
import type { ChainOutputMap, ChainOutputMapEntry, SingleResult } from "../../shared/types.ts";
import { getSingleResultOutput } from "../../shared/utils.ts";
import { DynamicFanoutError, hasDynamicFanoutFields, type DynamicFanoutConfig, validateDynamicStepShape } from "./dynamic-fanout.ts";

// Name class excludes '{' as well as '}' so an unterminated '{outputs.' prefix fails fast
// instead of rescanning to end-of-string (avoids quadratic blowup on malformed templates).
// Output names are validated against SAFE_OUTPUT_NAME_PATTERN, so they never contain braces.
const OUTPUT_REF_PATTERN = /\{outputs\.([^{}]*)\}/g;
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ChainOutputValidationError extends Error {}

function outputNamesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.as).filter((name): name is string => Boolean(name));
	if (isDynamicParallelStep(step)) return [step.collect.as];
	const name = (step as SequentialStep).as;
	return name ? [name] : [];
}

function taskTemplatesForStep(step: ChainStep): string[] {
	if (isParallelStep(step)) return step.parallel.map((task) => task.task ?? "{previous}");
	if (isDynamicParallelStep(step)) return [step.parallel.task ?? "{previous}", step.parallel.label ?? ""].filter(Boolean);
	return [(step as SequentialStep).task ?? "{previous}"];
}

export function validateChainOutputBindings(steps: ChainStep[], dynamicFanoutConfig: DynamicFanoutConfig = {}): void {
	const available = new Set<string>();
	const seen = new Set<string>();
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		// The M13.1 revert (2026-08-05) removed the gate executor but the revert left the
		// schema accepting `gate:` and silently ignoring it — a contract lie. Reject loudly
		// so a caller sees the error instead of a chain that never grades anything.
		if ("gate" in step && step.gate !== undefined) {
			throw new ChainOutputValidationError(`Chain step ${stepIndex + 1} declares an acceptance gate, which was reverted with M13.1 — remove the gate property.`);
		}
		if (hasDynamicFanoutFields(step)) {
			if (!isDynamicParallelStep(step)) {
				throw new ChainOutputValidationError(`Dynamic chain step ${stepIndex + 1} requires expand, a single parallel template object, and collect; dynamic expand/collect cannot be mixed with static parallel arrays.`);
			}
			try {
				validateDynamicStepShape(step, stepIndex, dynamicFanoutConfig);
			} catch (error) {
				if (error instanceof DynamicFanoutError) throw new ChainOutputValidationError(error.message);
				throw error;
			}
			if (!available.has(step.expand.from.output)) {
				throw new ChainOutputValidationError(`Dynamic chain step ${stepIndex + 1} references unknown output '${step.expand.from.output}'. Named outputs are only available after producing step/group completes.`);
			}
		}
		for (const name of outputNamesForStep(step)) {
			if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
				throw new ChainOutputValidationError(`Invalid chain output name '${name}' at step ${stepIndex + 1}. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`);
			}
			if (seen.has(name)) {
				throw new ChainOutputValidationError(`Duplicate chain output name '${name}'. Each as name must be unique.`);
			}
			seen.add(name);
		}
		for (const template of taskTemplatesForStep(step)) {
			for (const match of template.matchAll(OUTPUT_REF_PATTERN)) {
				const rawReference = match[0];
				const name = match[1]!;
				if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) {
					throw new ChainOutputValidationError(`Invalid chain output reference '${rawReference}' at step ${stepIndex + 1}. Use {outputs.name} with /^[A-Za-z_][A-Za-z0-9_]*$/ names.`);
				}
				if (!available.has(name)) {
					throw new ChainOutputValidationError(`Unknown chain output reference '${rawReference}' at step ${stepIndex + 1}. Named outputs are only available after producing step/group completes.`);
				}
			}
		}
		for (const name of outputNamesForStep(step)) {
			available.add(name);
		}
	}
}

/**
 * Runtime substitution of {outputs.name} tokens. Best-effort and total: it never throws.
 *
 * `validateChainOutputBindings` is the authoritative authoring-time gate for output references.
 * At runtime we must NOT throw on an unrecognized or invalid token, because the input here can be
 * post-substitution text (it runs after {previous} / {item} expansion) and may legitimately contain
 * a literal `{outputs.X}` substring, or reference a producer that failed at runtime. Throwing here
 * previously crashed the whole foreground chain and, in the detached async runner, killed the entire
 * process via the top-level handler (BLK-1). Unknown/invalid tokens are left literal, mirroring how
 * unmatched {previous}/{item} tokens are already passed through untouched.
 */
export function resolveOutputReferences(template: string, outputs: ChainOutputMap): string {
	return template.replace(OUTPUT_REF_PATTERN, (rawReference, name: string) => {
		if (!SAFE_OUTPUT_NAME_PATTERN.test(name)) return rawReference;
		if (!Object.hasOwn(outputs, name)) return rawReference;
		const entry = outputs[name];
		if (!entry) return rawReference;
		return entry.text;
	});
}

const CHAIN_TEMPLATE_TOKEN = /\{outputs\.([^{}]*)\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Single-pass chain template render. Resolves {outputs.NAME} and plain {var} tokens (task,
 * previous, chain_dir, item, ...) in ONE left-to-right scan, so a value substituted for one
 * token is never re-scanned for another. This prevents both injection directions: an output
 * whose text contains a literal {previous}/{task}/{chain_dir} is not expanded, and a
 * {previous}/{item} value containing a literal {outputs.name} is not expanded either.
 *
 * Total and best-effort like resolveOutputReferences: unknown/invalid tokens are left literal
 * and it never throws (post-substitution input may legitimately contain a literal token).
 */
export function renderChainTemplate(template: string, vars: Record<string, string>, outputs: ChainOutputMap): string {
	return template.replace(CHAIN_TEMPLATE_TOKEN, (full: string, outName: string | undefined, varName: string | undefined) => {
		if (outName !== undefined) {
			if (!SAFE_OUTPUT_NAME_PATTERN.test(outName)) return full;
			if (!Object.hasOwn(outputs, outName)) return full;
			const entry = outputs[outName];
			return entry ? entry.text : full;
		}
		if (varName !== undefined && Object.hasOwn(vars, varName)) return vars[varName]!;
		return full;
	});
}

function compactStructuredText(value: unknown): string {
	return JSON.stringify(value);
}

export function outputEntryFromResult(result: SingleResult, stepIndex: number): ChainOutputMapEntry {
	return {
		text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : getSingleResultOutput(result),
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		agent: result.agent,
		stepIndex,
	};
}

export function outputEntryFromAsyncResult(result: { agent: string; output: string; structuredOutput?: unknown }, stepIndex: number): ChainOutputMapEntry {
	return {
		text: result.structuredOutput !== undefined ? compactStructuredText(result.structuredOutput) : result.output,
		...(result.structuredOutput !== undefined ? { structured: result.structuredOutput } : {}),
		agent: result.agent,
		stepIndex,
	};
}

/**
 * A chain step's output is published under its `as` name only when the step actually
 * succeeded. Foreground and async paths share this predicate so a failed step can never
 * expose partial/garbage output to downstream `{outputs.name}` references (SF-1).
 */
export function isStorableStepResult(result: { exitCode: number; error?: string }): boolean {
	return result.exitCode === 0 && !result.error;
}
