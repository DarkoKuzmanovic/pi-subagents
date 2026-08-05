import type { JsonSchemaObject } from "../../shared/types.ts";

export type GateEvidence = "worktree" | "report-only";
export type GateExhaustion = "fail" | "accept-last";

export interface GateSpec {
	rubric: string | string[];
	grader?: string;
	maxIterations?: number;
	threshold?: number;
	onExhausted?: GateExhaustion;
	evidence?: GateEvidence;
}

export interface NormalizedGateSpec {
	rubric: string[];
	grader: string;
	maxIterations: number;
	threshold: number;
	onExhausted: GateExhaustion;
	evidence: GateEvidence;
}

export interface GateCriterionVerdict {
	criterion: string;
	met: boolean;
	note?: string;
}

export interface GateVerdict {
	pass: boolean;
	score: number;
	criteria: GateCriterionVerdict[];
	feedback: string;
}

export const DEFAULT_GATE_GRADER = "grader";
export const DEFAULT_GATE_MAX_ITERATIONS = 2;
export const DEFAULT_GATE_THRESHOLD = 1.0;
export const DEFAULT_GATE_EVIDENCE: GateEvidence = "worktree";

export const GATE_VERDICT_SCHEMA: JsonSchemaObject = {
	type: "object",
	additionalProperties: false,
	properties: {
		pass: { type: "boolean" },
		score: { type: "number", minimum: 0, maximum: 1 },
		criteria: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					criterion: { type: "string" },
					met: { type: "boolean" },
					note: { type: "string" },
				},
				required: ["criterion", "met"],
			},
		},
		feedback: { type: "string" },
	},
	required: ["pass", "score", "criteria", "feedback"],
};

export function normalizeGateSpec(spec: GateSpec): NormalizedGateSpec {
	return {
		rubric: Array.isArray(spec.rubric) ? [...spec.rubric] : [spec.rubric],
		grader: spec.grader ?? DEFAULT_GATE_GRADER,
		maxIterations: spec.maxIterations ?? DEFAULT_GATE_MAX_ITERATIONS,
		threshold: spec.threshold ?? DEFAULT_GATE_THRESHOLD,
		onExhausted: spec.onExhausted ?? "fail",
		evidence: spec.evidence ?? DEFAULT_GATE_EVIDENCE,
	};
}

const SCORE_EPSILON = 1e-6;

type GateVerdictValidation =
	| { status: "valid"; verdict: GateVerdict }
	| { status: "invalid"; message: string };

function invalidVerdict(message: string): GateVerdictValidation {
	return { status: "invalid", message };
}

/**
 * Validate a grader verdict against the gate that was actually configured.
 *
 * The verdict is bound to the configured rubric by exact criterion string at the
 * same index: criteria are never normalized before comparison, because any
 * normalization defines an equivalence class a substituted criterion could hide
 * inside. When a threshold is configured, `pass` is honored only when the
 * recomputed score meets it, independent of what the grader claimed.
 */
export function validateGateVerdictSemantics(
	verdict: unknown,
	rubric: readonly string[],
	threshold: number | undefined,
): GateVerdictValidation {
	if (!Array.isArray(rubric) || rubric.length < 1) {
		return invalidVerdict("gate rubric must contain at least one criterion.");
	}
	for (const criterion of rubric) {
		if (typeof criterion !== "string") {
			return invalidVerdict("gate rubric criteria must be strings.");
		}
	}
	if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold))) {
		return invalidVerdict("gate threshold must be a finite number.");
	}
	if (!verdict || typeof verdict !== "object" || Array.isArray(verdict)) {
		return invalidVerdict("gate verdict must be an object.");
	}

	const record = verdict as Record<string, unknown>;
	if (typeof record.pass !== "boolean") {
		return invalidVerdict("gate verdict pass must be a boolean.");
	}
	if (typeof record.feedback !== "string") {
		return invalidVerdict("gate verdict feedback must be a string.");
	}
	if (!Array.isArray(record.criteria)) {
		return invalidVerdict("gate verdict criteria must be an array.");
	}
	if (record.criteria.length !== rubric.length) {
		return invalidVerdict(`criteria length ${record.criteria.length} does not match rubric length ${rubric.length}.`);
	}

	let metCount = 0;
	const criteria: GateCriterionVerdict[] = [];
	for (let index = 0; index < record.criteria.length; index += 1) {
		const criterion = record.criteria[index];
		if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
			return invalidVerdict(`criteria[${index}] must be an object.`);
		}
		const criterionRecord = criterion as Record<string, unknown>;
		if (typeof criterionRecord.criterion !== "string") {
			return invalidVerdict(`criteria[${index}].criterion must be a string.`);
		}
		if (criterionRecord.criterion !== rubric[index]) {
			return invalidVerdict(
				`criteria[${index}].criterion ${JSON.stringify(criterionRecord.criterion)} does not match configured rubric criterion ${JSON.stringify(rubric[index])}.`,
			);
		}
		if (typeof criterionRecord.met !== "boolean") {
			return invalidVerdict(`criteria[${index}].met must be a boolean.`);
		}
		if (criterionRecord.note !== undefined && typeof criterionRecord.note !== "string") {
			return invalidVerdict(`criteria[${index}].note must be a string when present.`);
		}
		if (criterionRecord.met) metCount += 1;
		criteria.push({
			criterion: criterionRecord.criterion,
			met: criterionRecord.met,
			...(typeof criterionRecord.note === "string" ? { note: criterionRecord.note } : {}),
		});
	}

	if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
		return invalidVerdict("gate verdict score must be a finite number.");
	}
	if (record.score < 0 || record.score > 1) {
		return invalidVerdict("gate verdict score must be between 0 and 1.");
	}

	const recomputedScore = metCount / rubric.length;
	if (Math.abs(record.score - recomputedScore) > SCORE_EPSILON) {
		return invalidVerdict(`score ${record.score} does not match recomputed score ${recomputedScore}.`);
	}

	// `pass` is never taken on the grader's word: a claimed pass below the configured
	// threshold is honored as a fail.
	const meetsThreshold = threshold === undefined || recomputedScore + SCORE_EPSILON >= threshold;
	return {
		status: "valid",
		verdict: {
			pass: record.pass && meetsThreshold,
			score: recomputedScore,
			criteria,
			feedback: record.feedback,
		},
	};
}

export interface BuildGraderTaskInput {
	rubric: GateSpec["rubric"];
	threshold?: number;
	producerOutput?: string;
	/** Alias accepted for callers that already name the captured text `output`. */
	output?: string;
	changedFiles?: readonly string[];
	evidence?: GateEvidence;
}

export function buildGraderTask(input: BuildGraderTaskInput): string {
	const spec = normalizeGateSpec({
		rubric: input.rubric,
		threshold: input.threshold,
		evidence: input.evidence,
	});
	const producerOutput = input.producerOutput ?? input.output ?? "";
	const lines = [
		"Score the producer's attempt against the acceptance rubric below.",
		`A verdict passes only when the recomputed fraction of met criteria is at least ${spec.threshold}.`,
		"Score every criterion independently; do not infer one criterion from another.",
		"",
		"## Rubric",
		...spec.rubric.map((criterion, index) => `${index + 1}. ${criterion}`),
		"",
		"## Producer output",
		producerOutput,
	];

	if (spec.evidence === "worktree") {
		const changedFiles = input.changedFiles ?? [];
		lines.push(
			"",
			"## Worktree evidence",
			"The changed-file list below refers to the attempt WORKTREE, not the producer's real working tree.",
			"Changed files:",
			...(changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`) : ["- (none reported)"]),
			"Before scoring any criterion, READ the actual contents of every listed changed file in the attempt WORKTREE.",
		);
	} else {
		lines.push(
			"",
			"## Evidence mode",
			"This is report-only evaluation. Score only the producer output supplied above and do not assume that an asserted result exists without support in that output.",
		);
	}

	lines.push(
		"",
		"Return one criterion entry per rubric item with a short factual note.",
		"Recompute score as met criteria divided by total criteria; do not trust the producer's or your own unreconciled arithmetic.",
		"Write feedback as specific, actionable instructions addressed to the next producer attempt.",
		"Finish by calling structured_output with exactly the GateVerdict shape: pass, score, criteria, and feedback.",
	);
	return lines.join("\n");
}
