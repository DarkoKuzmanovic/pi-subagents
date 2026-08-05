import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: JsonSchemaNode;
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		action?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		message?: { type?: string; description?: string };
		requestId?: { type?: string; description?: string };
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				activeNoticeAfterMs?: { minimum?: number };
				activeNoticeAfterTurns?: { minimum?: number };
				activeNoticeAfterTokens?: { minimum?: number };
				failedToolAttemptsBeforeAttention?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		output?: JsonSchemaNode;
		maxOutput?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: JsonSchemaNode;
	};
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
	const anyOf = schema?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
	return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
	return anyOfBranches(schema).some((branch) => {
		if (branch.type !== "array") return false;
		const items = branch.items;
		return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
	});
}

/** Returns the array branch of an anyOf-widened array|string schema (or the schema itself when it is a plain array). */
function arrayBranch(schema: JsonSchemaNode | undefined): JsonSchemaNode | undefined {
	if (!schema) return undefined;
	if (schema.type === "array") return schema;
	return anyOfBranches(schema).find((branch) => branch.type === "array");
}

/** Item `properties` of an array schema, tolerating the anyOf array|string widening. */
function arrayItemProperties(schema: JsonSchemaNode | undefined): Record<string, JsonSchemaNode> | undefined {
	const items = arrayBranch(schema)?.items;
	if (!items || typeof items !== "object") return undefined;
	const properties = (items as JsonSchemaNode).properties;
	return properties && typeof properties === "object" ? (properties as Record<string, JsonSchemaNode>) : undefined;
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
try {
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	// The structural schema assertions below do not need the optional compiler package.
}

describe("SubagentParams schema", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("includes context field for fresh/fork/lineage execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork", "lineage"]);
		const description = String(contextSchema.description ?? "");
		assert.match(description, /fresh/);
		assert.match(description, /fork/);
		assert.match(description, /lineage/);
		assert.match(description, /whole invocation/);
	});

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskSchema = arrayItemProperties(SubagentParams?.properties?.tasks);
		const taskCountSchema = taskSchema?.count as (JsonSchemaNode & { minimum?: number; description?: string }) | undefined;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		assert.match(String(taskCountSchema.description ?? ""), /repeat/i);
		const outputSchema = taskSchema?.output as JsonSchemaNode | undefined;
		assert.equal(outputSchema?.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
		const readsSchema = taskSchema?.reads as JsonSchemaNode | undefined;
		assert.equal(readsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
		assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
		assert.equal((taskSchema?.progress as JsonSchemaNode | undefined)?.type, "boolean");

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

	it("includes per-run output token budget override", () => {
		const budgetSchema = SubagentParams?.properties?.budget;
		assert.ok(budgetSchema, "budget schema should exist");
		assert.equal(budgetSchema.type, "integer");
		assert.equal(budgetSchema.minimum, 1);
		assert.match(String(budgetSchema.description ?? ""), /output token/i);
		assert.match(String(budgetSchema.description ?? ""), /per-run/i);
	});

	it("describes maxOutput as post-run truncation rather than a generation cap", () => {
		const maxOutputSchema = SubagentParams?.properties?.maxOutput;
		assert.ok(maxOutputSchema, "maxOutput schema should exist");
		assert.equal(maxOutputSchema.type, "object");
		const properties = maxOutputSchema.properties as Record<string, JsonSchemaNode> | undefined;
		assert.equal(properties?.bytes?.minimum, 1);
		assert.equal(properties?.lines?.minimum, 1);
		const description = String(maxOutputSchema.description ?? "");
		assert.match(description, /post-run/i);
		assert.match(description, /does not limit model generation/i);
	});

	it("includes lane selectors on single, parallel, and chain execution inputs", () => {
		const singleLaneSchema = SubagentParams?.properties?.lane as JsonSchemaNode | undefined;
		assert.ok(singleLaneSchema, "single lane schema should exist");
		assert.equal(singleLaneSchema?.type, "string");
		assert.match(String(singleLaneSchema?.description ?? ""), /lane/i);

		const taskLaneSchema = arrayItemProperties(SubagentParams?.properties?.tasks)?.lane as JsonSchemaNode | undefined;
		assert.ok(taskLaneSchema, "tasks[].lane schema should exist");
		assert.equal(taskLaneSchema?.type, "string");
		assert.match(String(taskLaneSchema?.description ?? ""), /lane/i);

		const chainStepLaneSchema = arrayItemProperties(SubagentParams?.properties?.chain)?.lane as JsonSchemaNode | undefined;
		assert.ok(chainStepLaneSchema, "chain[].lane schema should exist");
		assert.equal(chainStepLaneSchema?.type, "string");
		assert.match(String(chainStepLaneSchema?.description ?? ""), /lane/i);

		const parallelLaneSchema = arrayItemProperties(SubagentParams?.properties?.chain)?.parallel as JsonSchemaNode | undefined;
		const parallelTaskLaneSchema = arrayItemProperties(parallelLaneSchema)?.lane;
		assert.ok(parallelTaskLaneSchema, "chain[].parallel[].lane schema should exist");
		assert.equal(parallelTaskLaneSchema?.type, "string");
		assert.match(String(parallelTaskLaneSchema?.description ?? ""), /lane/i);
	});


	it("accepts max thinking overrides in every execution shape", () => {
		const expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const singleThinking = SubagentParams?.properties?.thinking as JsonSchemaNode | undefined;
		const taskThinking = arrayItemProperties(SubagentParams?.properties?.tasks)?.thinking;
		const chainProperties = arrayItemProperties(SubagentParams?.properties?.chain);
		const chainThinking = chainProperties?.thinking;
		const parallelThinking = arrayItemProperties(chainProperties?.parallel)?.thinking;

		for (const schema of [singleThinking, taskThinking, chainThinking, parallelThinking]) {
			assert.deepEqual(schema?.enum, expected);
		}
	});

	it("uses an enum for management and control actions", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.deepEqual(actionSchema.enum, ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "steer", "follow-up", "wrap-up", "recover", "inspect", "attach", "detach", "doctor"]);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control action/);
		assert.match(description, /Omit for execution mode/);
		assert.doesNotMatch(description, /orchestration\./);
		assert.match(description, /accepted-by-pi/);
		assert.match(description, /outcome-unknown/);
		assert.match(description, /never silently downgraded/);
		assert.match(description, /recover/);
		assert.match(description, /inspect/);
		assert.match(description, /attach/);
		assert.match(description, /detach/);
	});

	it("documents live-control message and requestId shapes", () => {
		const messageSchema = SubagentParams?.properties?.message;
		assert.equal(messageSchema?.type, "string");
		assert.match(String(messageSchema?.description ?? ""), /steer/);
		assert.match(String(messageSchema?.description ?? ""), /follow-up/);
		assert.match(String(messageSchema?.description ?? ""), /wrap-up needs no message/);
		assert.match(String(messageSchema?.description ?? ""), /never silently downgraded/);

		const requestIdSchema = SubagentParams?.properties?.requestId;
		assert.equal(requestIdSchema?.type, "string");
		assert.match(String(requestIdSchema?.description ?? ""), /idempotency/);
		assert.match(String(requestIdSchema?.description ?? ""), /rather than delivering twice/);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);

		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.needsAttentionAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTurns?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTokens?.minimum, 1);
		assert.equal(controlSchema.properties?.failedToolAttemptsBeforeAttention?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.notifyOn?.items?.enum, ["active_long_running", "needs_attention", "timed_out_escalating", "timed_out", "timeout_killed"]);
		assert.deepEqual(controlSchema.properties?.notifyChannels?.items?.enum, ["event", "async", "intercom"]);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Object.hasOwn(node, "description") && !Object.hasOwn(node, "type") && !Object.hasOwn(node, "anyOf")) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => {
						stack.push({ path: `${current.path}[${index}]`, value });
					});
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (node.type === "array" && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => {
						stack.push({ path: `${current.path}[${index}]`, value });
					});
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(missingItemsPaths, []);
	});

	it("does not emit provider-rejected union schema shapes", () => {
		const rejectedPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Array.isArray(node.type)) {
					rejectedPaths.push(`${current.path}.type`);
				}
				if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
					rejectedPaths.push(`${current.path}.type+anyOf`);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => {
						stack.push({ path: `${current.path}[${index}]`, value });
					});
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(rejectedPaths, []);
	});

	it("uses provider-friendly anyOf unions for flexible fields and chain items", () => {
		const skillSchema = SubagentParams?.properties?.skill;
		assert.ok(skillSchema, "skill schema should exist");
		assert.equal(skillSchema.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(skillSchema), true);
		assert.equal(hasAnyOfType(skillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(skillSchema, "string"), true);

		const outputSchema = SubagentParams?.properties?.output;
		assert.ok(outputSchema, "output schema should exist");
		assert.equal(outputSchema.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);

		const configSchema = SubagentParams?.properties?.config;
		assert.ok(configSchema, "config schema should exist");
		assert.equal(configSchema.type, undefined);
		assert.equal(anyOfBranches(configSchema).some((branch) => branch.type === "object" && branch.additionalProperties === true), true);
		assert.equal(hasAnyOfType(configSchema, "string"), true);

		// chain itself is anyOf [array-of-objects, string] (stringified-envelope
		// tolerance for cheap drivers); the chain ITEM stays a flat object.
		const chainSchema = SubagentParams?.properties?.chain;
		assert.equal(hasAnyOfType(chainSchema, "string"), true, "chain accepts a JSON-stringified array");
		const chainItem = arrayBranch(chainSchema)?.items as (JsonSchemaNode & { properties?: Record<string, JsonSchemaNode> }) | undefined;
		assert.ok(chainItem, "chain item schema should exist");
		assert.equal(chainItem.type, "object");
		assert.equal(chainItem.anyOf, undefined);
		assert.equal(chainItem.oneOf, undefined);
		assert.equal(chainItem.properties?.agent?.type, "string");
		const chainParallelSchema = chainItem.properties?.parallel;
		assert.equal(hasAnyOfType(chainParallelSchema, "string"), true, "chain[].parallel accepts a JSON-stringified array");
		assert.equal(arrayBranch(chainParallelSchema)?.type, "array");
		const chainParallelTask = arrayItemProperties(chainParallelSchema);
		assert.equal(chainParallelTask?.agent?.type, "string");
		const chainParallelOutputSchema = chainParallelTask?.output;
		assert.equal(chainParallelOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "boolean"), true);
		const chainParallelReadsSchema = chainParallelTask?.reads;
		assert.equal(chainParallelReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelReadsSchema), true);
		assert.equal(hasAnyOfType(chainParallelReadsSchema, "boolean"), true);
		const chainParallelSkillSchema = chainParallelTask?.skill;
		assert.equal(chainParallelSkillSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelSkillSchema), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "string"), true);
		const chainOutputSchema = chainItem.properties?.output as JsonSchemaNode | undefined;
		assert.equal(chainOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainOutputSchema, "boolean"), true);
		const chainReadsSchema = chainItem.properties?.reads as JsonSchemaNode | undefined;
		assert.equal(chainReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainReadsSchema), true);
		assert.equal(hasAnyOfType(chainReadsSchema, "boolean"), true);
	});

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ skill: "review" },
			{ skill: false },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: "review" }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", output: "review.md", reads: ["input.md"], progress: true }] },
			{ chain: [{ agent: "reviewer", reads: false }] },
			{ chain: [{ agent: "reviewer", skill: "review" }] },
			{ chain: [{ agent: "reviewer", skill: false }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: false, skill: false }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: "review.md", reads: ["input.md"], skill: "review" }] }] },
			{ chain: [{ agent: "worker", gate: { rubric: ["Adds the feature", "Tests the feature"], maxIterations: 2, threshold: 1, onExhausted: "fail", evidence: "worktree" } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "The producer report is complete" } }] },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];
		const invalidValues = [
			{ skill: 123 },
			{ skill: [123] },
			{ output: 123 },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: 123 }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: "input.md" }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", skill: 123 }] }] },
			{ chain: [{ agent: "worker", gate: { rubric: [] } }] },
			{ chain: [{ agent: "worker", gate: { rubric: [""] } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", maxIterations: 0 } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", threshold: 1.1 } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", threshold: -0.1 } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", onExhausted: "stop" } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", evidence: "tree" } }] },
			{ chain: [{ agent: "worker", gate: { rubric: "criterion", extra: true } }] },
			{ config: [] },
			{ config: null },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});
