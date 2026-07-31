import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

type RegisteredSlashCommand = {
	handler(args: string, ctx: unknown): Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
};

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(name: string, spec: RegisteredSlashCommand): void;
			registerShortcut(
				key: string,
				spec: { handler(ctx: unknown): Promise<void> },
			): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: {
				schedule(file: string, delayMs?: number): boolean;
				clear(): void;
			};
		},
	) => void;
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
	getSlashRenderableSnapshot?: typeof import("../../src/slash/slash-live-state.ts").getSlashRenderableSnapshot;
	resolveSlashMessageDetails?: typeof import("../../src/slash/slash-live-state.ts").resolveSlashMessageDetails;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
let available = true;
try {
	({ registerSlashCommands } = (await import(
		"../../src/slash/slash-commands.ts"
	)) as RegisterSlashCommandsModule);
	({
		clearSlashSnapshots,
		getSlashRenderableSnapshot,
		resolveSlashMessageDetails,
	} = (await import(
		"../../src/slash/slash-live-state.ts"
	)) as SlashLiveStateModule);
} catch {
	available = false;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(
					event,
					current.filter((entry) => entry !== handler),
				);
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function createCommandContext(
	overrides: Partial<{
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			setStatus:
				overrides.setStatus ??
				((_key: string, _text: string | undefined) => {}),
			setToolsExpanded:
				overrides.setToolsExpanded ?? ((_expanded: boolean) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withTempProject<T>(
	prefix: string,
	fn: (root: string) => Promise<T>,
): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, ".pi", "chains"), { recursive: true });
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeProjectChain(
	root: string,
	fileName: string,
	content: string,
): void {
	fs.writeFileSync(
		path.join(root, ".pi", "chains", fileName),
		content,
		"utf-8",
	);
}

async function captureSlashCommandParams(
	commandName: string,
	args: string,
	cwd: string,
	setup?: () => void,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		setup?.();
		const commands = new Map<string, RegisteredSlashCommand>();
		const events = createEventBus();
		let requestedParams: unknown;
		const notifications: string[] = [];
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, {
				requestId: payload.requestId,
			});
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: `${commandName} finished` }],
					details: { mode: "chain", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(cwd));
		await commands.get(commandName)!.handler(
			args,
			createCommandContext({
				cwd,
				notify: (message) => {
					notifications.push(message);
				},
			}),
		);
		return { params: requestedParams, notifications };
	});
}

describe("slash command custom message delivery", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run accepts an agent without a task", async () => {
		const sent: unknown[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		let requestedParams: unknown;
		const sessionManager = {
			flushed: false,
			rewrites: 0,
			getSessionFile: () => "session.jsonl",
			_rewriteFile() {
				this.rewrites++;
			},
		};
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, {
				requestId: payload.requestId,
			});
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Commit finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands
			.get("run")!
			.handler("recon", createCommandContext({ sessionManager }));

		assert.deepEqual(requestedParams, {
			agent: "recon",
			task: "",
			clarify: false,
			agentScope: "both",
		});
		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal(
			(sent[0] as { content?: string }).content,
			"Running subagent...",
		);
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match(
			(sent[1] as { content?: string }).content ?? "",
			/Commit finished/,
		);
		assert.equal(sessionManager.rewrites, 2);
		assert.equal(sessionManager.flushed, true);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on success", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: {
						mode: "single",
						results: [{ sessionFile: "/tmp/child-session.jsonl" }],
					},
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(
					`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`,
				);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler(
			"recon inspect this",
			createCommandContext({
				hasUI: true,
				setStatus: (_key, text) => {
					log.push(`status:${text ?? "clear"}`);
				},
			}),
		);

		assert.equal(sent.length, 2);
		assert.equal(
			(sent[0] as { customType?: string; display?: boolean }).customType,
			SLASH_RESULT_TYPE,
		);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal(
			(sent[1] as { customType?: string; display?: boolean }).customType,
			SLASH_RESULT_TYPE,
		);
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match(
			(sent[1] as { content?: string }).content ?? "",
			/Scout finished/,
		);
		assert.match(
			(sent[1] as { content?: string }).content ?? "",
			/Child session exports\n\n- `\/tmp\/child-session\.jsonl`/,
		);
		assert.deepEqual(log, [
			"send:visible",
			"status:running...",
			"send:visible",
			"status:clear",
		]);

		const visibleDetails = resolveSlashMessageDetails!(
			(sent[0] as { details?: unknown }).details,
		);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal(
			(visibleSnapshot.result.content[0] as { text?: string }).text,
			"Scout finished",
		);
	});

	it("/run collapses tool detail before showing the initial live card", async () => {
		const log: string[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {
				log.push("send");
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler(
			"recon inspect this",
			createCommandContext({
				hasUI: true,
				setToolsExpanded: (expanded) =>
					log.push(`expanded:${String(expanded)}`),
			}),
		);

		assert.deepEqual(log.slice(0, 2), ["expanded:false", "send"]);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on error", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(
					`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`,
				);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler(
			"recon inspect this",
			createCommandContext({
				hasUI: true,
				setStatus: (_key, text) => {
					log.push(`status:${text ?? "clear"}`);
				},
			}),
		);

		assert.equal(sent.length, 2);
		assert.equal(
			(sent[0] as { customType?: string; display?: boolean }).customType,
			SLASH_RESULT_TYPE,
		);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal(
			(sent[1] as { customType?: string; display?: boolean }).customType,
			SLASH_RESULT_TYPE,
		);
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match(
			(sent[1] as { content?: string }).content ?? "",
			/Subagent failed/,
		);
		assert.deepEqual(log, [
			"send:visible",
			"status:running...",
			"send:visible",
			"status:clear",
		]);

		const visibleDetails = resolveSlashMessageDetails!(
			(sent[0] as { details?: unknown }).details,
		);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal(
			(visibleSnapshot.result.content[0] as { text?: string }).text,
			"Subagent failed",
		);
	});

	it("/parallel forwards inline output behavior config", async () => {
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, {
				requestId: payload.requestId,
			});
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands
			.get("parallel")!
			.handler(
				"recon[output=x.md,outputMode=file-only,reads=a.md+b.md,progress] -- Review",
				createCommandContext(),
			);

		assert.deepEqual(requestedParams, {
			tasks: [
				{
					agent: "recon",
					task: "Review",
					output: "x.md",
					outputMode: "file-only",
					reads: ["a.md", "b.md"],
					progress: true,
				},
			],
			clarify: false,
			agentScope: "both",
		});
	});

	it("/run forwards inline lane config", async () => {
		const { params } = await captureSlashCommandParams(
			"run",
			"worker[lane=easy] Investigate",
			process.cwd(),
		);

		assert.deepEqual(params, {
			agent: "worker",
			task: "Investigate",
			lane: "easy",
			clarify: false,
			agentScope: "both",
		});
	});

	it("/chain forwards inline lane config for sequential steps", async () => {
		const { params } = await captureSlashCommandParams(
			"chain",
			'worker[lane=easy] "Inspect" -> reviewer[lane=hard]',
			process.cwd(),
		);

		assert.deepEqual(params, {
			chain: [
				{ agent: "worker", task: "Inspect", lane: "easy" },
				{ agent: "reviewer", lane: "hard" },
			],
			task: "Inspect",
			clarify: false,
			agentScope: "both",
		});
	});

	it("/parallel forwards inline lane config", async () => {
		const { params } = await captureSlashCommandParams(
			"parallel",
			"worker[lane=easy] -- Review",
			process.cwd(),
		);

		assert.deepEqual(params, {
			tasks: [
				{ agent: "worker", task: "Review", lane: "easy" },
			],
			clarify: false,
			agentScope: "both",
		});
	});

	it("/parallel no longer hard-blocks runs above the old 8-task limit before the executor responds", async () => {
		const sent: unknown[] = [];
		const commands = new Map<
			string,
			{ handler(args: string, ctx: unknown): Promise<void> }
		>();
		const events = createEventBus();
		let requestedTasks = 0;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as {
				requestId: string;
				params?: { tasks?: unknown[] };
			};
			requestedTasks = payload.params?.tasks?.length ?? 0;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, {
				requestId: payload.requestId,
			});
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void> },
			) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		const args = Array.from(
			{ length: 9 },
			(_, index) => `recon "task ${index + 1}"`,
		).join(" -> ");
		await commands.get("parallel")!.handler(args, createCommandContext());

		assert.equal(requestedTasks, 9);
		assert.equal(sent.length, 2);
		assert.match(
			(sent[1] as { content?: string }).content ?? "",
			/parallel finished/,
		);
	});
});

describe("saved chain slash command", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run and /chain accept dotted packaged runtime agent names", async () => {
		await withTempProject("pi-packaged-agent-slash-", async (root) => {
			fs.writeFileSync(
				path.join(root, ".pi", "agents", "code-analysis.scout.md"),
				`---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`,
				"utf-8",
			);
			fs.writeFileSync(
				path.join(root, ".pi", "agents", "documentation.writer.md"),
				`---
name: writer
package: documentation
description: Writer
---

Write
`,
				"utf-8",
			);

			const run = await captureSlashCommandParams(
				"run",
				"code-analysis.scout Investigate",
				root,
			);
			assert.deepEqual(run.params, {
				agent: "code-analysis.scout",
				task: "Investigate",
				clarify: false,
				agentScope: "both",
			});

			const chain = await captureSlashCommandParams(
				"chain",
				'code-analysis.scout "Scan" -> documentation.writer',
				root,
			);
			assert.deepEqual(
				(
					chain.params as { chain?: Array<{ agent?: string; task?: string }> }
				).chain?.map(({ agent, task }) => ({ agent, task })),
				[
					{ agent: "code-analysis.scout", task: "Scan" },
					{ agent: "documentation.writer", task: undefined },
				],
			);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) {
						commands.set(name, spec);
					},
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const runCompletions = commands.get("run")!.getArgumentCompletions!(
					"code-",
				) as Array<{ value: string; label: string }>;
				assert.deepEqual(
					runCompletions.map((completion) => completion.value),
					["code-analysis.scout"],
				);
				const chainCompletions = commands.get("chain")!.getArgumentCompletions!(
					'code-analysis.scout "Scan" -> doc',
				) as Array<{ value: string; label: string }>;
				assert.deepEqual(
					chainCompletions.map((completion) => completion.value),
					['code-analysis.scout "Scan" -> documentation.writer'],
				);
			});
		});
	});

	it("/chain launches a saved chain with a shared task", async () => {
		await withTempProject("pi-chain-saved-success-", async (root) => {
			writeProjectChain(
				root,
				"review-flow.chain.md",
				`---
name: review-flow
description: Review flow
---

## scout

Scan {task}

## reviewer

Review {previous}
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"review-flow -- Audit the auth flow",
				root,
			);
			const runParams = params as {
				chain?: Array<{ agent?: string; task?: string }>;
				task?: string;
				clarify?: boolean;
				agentScope?: string;
				async?: unknown;
				context?: unknown;
			};

			assert.deepEqual(
				runParams.chain?.map(({ agent, task }) => ({ agent, task })),
				[
					{ agent: "scout", task: "Scan {task}" },
					{ agent: "reviewer", task: "Review {previous}" },
				],
			);
			assert.equal(runParams.task, "Audit the auth flow");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.async, undefined);
			assert.equal(runParams.context, undefined);
		});
	});

	it("/chain launches and completes packaged saved chains by dotted runtime name", async () => {
		await withTempProject("pi-chain-saved-packaged-", async (root) => {
			writeProjectChain(
				root,
				"code-analysis.review-flow.chain.md",
				`---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Scan {task}
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"code-analysis.review-flow -- Audit",
				root,
			);
			assert.equal((params as { task?: string }).task, "Audit");
			assert.deepEqual(
				(
					params as { chain?: Array<{ agent?: string; task?: string }> }
				).chain?.map(({ agent, task }) => ({ agent, task })),
				[{ agent: "code-analysis.scout", task: "Scan {task}" }],
			);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) {
						commands.set(name, spec);
					},
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("chain")!.getArgumentCompletions!(
					"code-",
				) as Array<{ value: string; label: string }>;
				assert.deepEqual(
					completions.map((completion) => completion.value),
					["code-analysis.review-flow"],
				);
			});
		});
	});

	it("/chain reports an unknown saved chain without launching", async () => {
		await withTempProject("pi-chain-saved-unknown-", async (root) => {
			const { params, notifications } = await captureSlashCommandParams(
				"chain",
				"missing -- Do work",
				root,
			);

			assert.equal(params, undefined);
			assert.deepEqual(notifications, ["Unknown chain: missing"]);
		});
	});

	it("/chain suggests saved chain names", async () => {
		await withTempProject("pi-chain-saved-completions-", async (root) => {
			writeProjectChain(
				root,
				"review-flow.chain.md",
				`---
name: review-flow
description: Review flow
---

## scout

Scan
`,
			);
			writeProjectChain(
				root,
				"release-flow.chain.md",
				`---
name: release-flow
description: Release flow
---

## planner

Plan
`,
			);
			writeProjectChain(
				root,
				"triage.chain.md",
				`---
name: triage
description: Triage flow
---

## scout

Triage
`,
			);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) {
						commands.set(name, spec);
					},
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};

				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("chain")!.getArgumentCompletions!(
					"re",
				) as Array<{ value: string; label: string }>;
				assert.deepEqual(
					completions.map((completion) => completion.value).sort(),
					["recon", "release-flow", "review-flow", "reviewer"],
				);
				const chainLabels = completions
					.filter((c) => c.label.includes("(chain)"))
					.map((c) => c.value)
					.sort();
				assert.deepEqual(chainLabels, [
					"release-flow",
					"review-flow",
				]);
				assert.equal(
					commands.get("chain")!.getArgumentCompletions!("review-flow -- "),
					null,
				);
			});
		});
	});

	it("/chain maps --bg to async execution for saved chains", async () => {
		await withTempProject("pi-chain-saved-bg-", async (root) => {
			writeProjectChain(
				root,
				"review-flow.chain.md",
				`---
name: review-flow
description: Review flow
---

## scout

Scan
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"review-flow -- Audit --bg",
				root,
			);

			assert.equal((params as { async?: unknown }).async, true);
			assert.equal((params as { context?: unknown }).context, undefined);
		});
	});

	it("/chain maps --fork to forked context for saved chains", async () => {
		await withTempProject("pi-chain-saved-fork-", async (root) => {
			writeProjectChain(
				root,
				"review-flow.chain.md",
				`---
name: review-flow
description: Review flow
---

## scout

Scan
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"review-flow -- Audit --fork",
				root,
			);

			assert.equal((params as { context?: unknown }).context, "fork");
			assert.equal((params as { async?: unknown }).async, undefined);
		});
	});

	it("/chain prefers a project saved chain over a same-named user chain", async () => {
		await withTempProject("pi-chain-saved-priority-", async (root) => {
			writeProjectChain(
				root,
				"review-flow.chain.md",
				`---
name: review-flow
description: Project review flow
---

## scout

Project chain task
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"review-flow -- Shared task",
				root,
				() => {
					const userChainsDir = path.join(
						os.homedir(),
						".pi",
						"agent",
						"chains",
					);
					fs.mkdirSync(userChainsDir, { recursive: true });
					fs.writeFileSync(
						path.join(userChainsDir, "review-flow.chain.md"),
						`---
name: review-flow
description: User review flow
---

## scout

User chain task
`,
						"utf-8",
					);
				},
			);

			assert.equal(
				(params as { chain?: Array<{ task?: string }> }).chain?.[0]?.task,
				"Project chain task",
			);
		});
	});

	it("/chain preserves saved step behavior fields", async () => {
		await withTempProject("pi-chain-saved-fields-", async (root) => {
			writeProjectChain(
				root,
				"field-flow.chain.md",
				`---
name: field-flow
description: Field flow
---

## scout
output: context.md
outputMode: file-only
reads: input.md, notes.md
model: openai/gpt-5.5
skills: research, audit
progress: true

Gather context
`,
			);

			const { params } = await captureSlashCommandParams(
				"chain",
				"field-flow -- Shared task",
				root,
			);

			assert.deepEqual((params as { chain?: unknown[] }).chain?.[0], {
				agent: "scout",
				task: "Gather context",
				output: "context.md",
				outputMode: "file-only",
				reads: ["input.md", "notes.md"],
				progress: true,
				skill: ["research", "audit"],
				model: "openai/gpt-5.5",
			});
		});
	});
});

describe("subagents-doctor slash command", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams(
			"subagents-doctor",
			"",
			process.cwd(),
		);
		assert.deepEqual(params, { action: "doctor" });
	});

	it("does not register the removed subagents-status overlay command", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			assert.equal(commands.has("subagents-status"), false);
		});
	});
});

describe("/subagents config shortcut", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/subagents with no args does not trigger config shortcut", async () => {
		// Capture with a hasUI:false context — should get the TUI error notify, not a config notify.
		const { params, notifications } = await captureSlashCommandParams(
			"subagents",
			"",
			process.cwd(),
		);
		// The hub command emits a slash request event only when hasUI is true (or falls through).
		// Without UI it notifies. Either way, no subagent params event for the config branch.
		// The important assertion: no notification containing a settings path.
		const configNote = notifications.find((n) => n.includes("settings.json"));
		assert.ok(!configNote, `no settings.json notification expected for empty args, got: ${configNote}`);
		// params can be undefined (no subagent launched for no-UI run)
		void params;
	});

	it("/subagents config seeds settings and notifies the path", async () => {
		const savedVisual = process.env.VISUAL;
		const savedEditor = process.env.EDITOR;
		try {
			process.env.VISUAL = "/usr/bin/true"; // exits 0 immediately — no terminal needed
			delete process.env.EDITOR;
			const { notifications } = await captureSlashCommandParams(
				"subagents",
				"config",
				process.cwd(),
			);
			const note = notifications.find((n) => n.includes("settings.json"));
			assert.ok(note, `expected a notification mentioning settings.json, got: ${JSON.stringify(notifications)}`);
		} finally {
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
			if (savedEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = savedEditor;
		}
	});

	it("/subagents json is treated as config shortcut", async () => {
		const savedVisual = process.env.VISUAL;
		try {
			process.env.VISUAL = "/usr/bin/true";
			const { notifications } = await captureSlashCommandParams(
				"subagents",
				"json",
				process.cwd(),
			);
			const note = notifications.find((n) => n.includes("settings.json"));
			assert.ok(note, `expected a settings.json notification for json arg, got: ${JSON.stringify(notifications)}`);
		} finally {
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
		}
	});

	it("/subagents config with failing editor notifies path and error", async () => {
		const savedVisual = process.env.VISUAL;
		const savedEditor = process.env.EDITOR;
		try {
			process.env.VISUAL = "/nonexistent-editor-9999-test";
			delete process.env.EDITOR;
			const { notifications } = await captureSlashCommandParams(
				"subagents",
				"config",
				process.cwd(),
			);
			// Should get a warning notification with the settings path
			const note = notifications.find((n) => n.includes("settings.json"));
			assert.ok(note, `expected settings.json in notification, got: ${JSON.stringify(notifications)}`);
		} finally {
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
			if (savedEditor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = savedEditor;
		}
	});

	it("/subagents config does not dispatch a subagent event", async () => {
		const savedVisual = process.env.VISUAL;
		try {
			process.env.VISUAL = "/usr/bin/true";
			const { params } = await captureSlashCommandParams(
				"subagents",
				"config",
				process.cwd(),
			);
			assert.equal(params, undefined, "config shortcut should not dispatch a subagent event");
		} finally {
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
		}
	});

	it("/subagents edit seeds worker.normal/worker.hard only when modelLanes is absent", async () => {
		const savedVisual = process.env.VISUAL;
		try {
			process.env.VISUAL = "/usr/bin/true";
			await withIsolatedHome(async () => {
				const settingsPath = userSettingsPathForHome();
				writeSettingsFixture(settingsPath, { theme: "dark" });
				await runRegisteredCommand("subagents", "edit", process.cwd(), () => {});
				const seeded = readSettingsFixture(settingsPath);
				assert.equal(seeded.theme, "dark");
				assert.deepEqual(
					(seeded.subagents as { modelLanes?: LaneMapFixture }).modelLanes,
					{
						worker: {
							normal: { model: "zai/glm-5.1", thinking: "high" },
							hard: { model: "anthropic/claude-sonnet-4-6", thinking: "medium" },
						},
					},
				);

				// A second run must not reseed over the user's own lane map.
				writeSettingsFixture(settingsPath, {
					theme: "dark",
					subagents: { modelLanes: { worker: { custom: { model: "vendor/custom" } } } },
				});
				await runRegisteredCommand("subagents", "config", process.cwd(), () => {});
				assert.deepEqual(
					(readSettingsFixture(settingsPath).subagents as { modelLanes?: LaneMapFixture })
						.modelLanes,
					{ worker: { custom: { model: "vendor/custom" } } },
				);
			});
		} finally {
			if (savedVisual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = savedVisual;
		}
	});
});

type LaneMapFixture = Record<
	string,
	Record<string, { model?: string; thinking?: string }>
>;

interface CapturedNotification {
	message: string;
	type?: string;
}

type HubFactory = (
	tui: unknown,
	theme: unknown,
	keybindings: unknown,
	done: (result: unknown) => void,
) => unknown;

/** Narrow accessor for the lane state the hub receives from the slash handler. */
interface LaneComponentState {
	projectLanes: LaneMapFixture;
	laneDrafts: Array<{
		agentName: string;
		name: string;
		model?: string;
		thinking?: string;
	}>;
}

function userSettingsPathForHome(): string {
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function writeSettingsFixture(filePath: string, settings: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function readSettingsFixture(filePath: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

/** Builds the real hub component from the factory the handler hands to ctx.ui.custom. */
function constructHubFromFactory(factory: HubFactory): LaneComponentState {
	const component = factory(
		{ requestRender() {} },
		{
			fg: (_key: string, text: string) => text,
			bold: (text: string) => text,
		},
		{},
		() => {},
	);
	return component as LaneComponentState;
}

async function runRegisteredCommand(
	commandName: string,
	args: string,
	cwd: string,
	notify: (message: string, type?: string) => void,
	custom?: (...customArgs: unknown[]) => Promise<unknown>,
	hasUI = false,
): Promise<void> {
	const commands = new Map<string, RegisteredSlashCommand>();
	const pi = {
		events: createEventBus(),
		registerCommand(name: string, spec: RegisteredSlashCommand) {
			commands.set(name, spec);
		},
		registerShortcut() {},
		sendMessage(_message: unknown) {},
	};
	assert.ok(registerSlashCommands, "slash-commands.ts must export registerSlashCommands");
	registerSlashCommands(pi, createState(cwd));
	const command = commands.get(commandName);
	assert.ok(command, `expected a registered /${commandName} command`);
	await command.handler(
		args,
		createCommandContext({
			cwd,
			hasUI,
			notify,
			...(custom ? { custom } : {}),
		}),
	);
}

async function runSubagentsHub(options: {
	cwd: string;
	setup?: () => void;
	custom?: (factory: HubFactory) => Promise<unknown>;
	after?: () => void;
}): Promise<{ notifications: CapturedNotification[]; customCalls: number }> {
	return withIsolatedHome(async () => {
		options.setup?.();
		const notifications: CapturedNotification[] = [];
		let customCalls = 0;
		await runRegisteredCommand(
			"subagents",
			"",
			options.cwd,
			(message, type) => {
				notifications.push({ message, type });
			},
			async (...customArgs: unknown[]) => {
				customCalls += 1;
				const factory = customArgs[0] as HubFactory;
				return options.custom ? await options.custom(factory) : undefined;
			},
			true,
		);
		options.after?.();
		return { notifications, customCalls };
	});
}

describe("/subagents lane wiring", {
	skip: !available ? "slash-commands.ts not importable" : undefined,
}, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("passes separate user and project lane maps into the overlay", async () => {
		await withTempProject("pi-subagents-lane-scopes-", async (root) => {
			let captured: LaneComponentState | undefined;
			const { customCalls } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					writeSettingsFixture(userSettingsPathForHome(), {
						subagents: {
							modelLanes: {
								worker: {
									normal: { model: "user/normal" },
									hard: { model: "user/hard" },
								},
							},
						},
					});
					writeSettingsFixture(path.join(root, ".pi", "settings.json"), {
						subagents: {
							modelLanes: {
								worker: { normal: { model: "project/normal", thinking: "high" } },
							},
						},
					});
				},
				custom: async (factory) => {
					captured = constructHubFromFactory(factory);
					return undefined;
				},
			});

			assert.equal(customCalls, 1);
			assert.ok(captured, "expected the hub factory to be invoked");
			// Scope identity is preserved: the same lane name exists in both maps.
			assert.deepEqual(captured?.projectLanes, {
				worker: { normal: { model: "project/normal", thinking: "high" } },
			});
			assert.deepEqual(
				captured?.laneDrafts.map((draft) => ({
					agentName: draft.agentName,
					name: draft.name,
					model: draft.model,
				})),
				[
					{ agentName: "worker", name: "normal", model: "user/normal" },
					{ agentName: "worker", name: "hard", model: "user/hard" },
				],
			);
		});
	});

	it("persists lane mutations only after the overlay resolves, and only to user settings", async () => {
		await withTempProject("pi-subagents-lane-persist-", async (root) => {
			const projectSettingsPath = path.join(root, ".pi", "settings.json");
			let userSettingsPath = "";
			let userBytesBefore = "";
			let userBytesDuringOverlay = "";
			let projectBytesBefore = "";
			let projectBytesAfter = "";
			let savedLanes: LaneMapFixture | undefined;
			let savedRoot: Record<string, unknown> | undefined;

			const { notifications } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					userSettingsPath = userSettingsPathForHome();
					writeSettingsFixture(userSettingsPath, {
						theme: "dark",
						subagents: {
							agentOverrides: { worker: { model: "openai/model-0" } },
							modelLanes: { worker: { normal: { model: "user/normal" } } },
						},
					});
					writeSettingsFixture(projectSettingsPath, {
						subagents: { modelLanes: { worker: { hard: { model: "project/hard" } } } },
					});
					userBytesBefore = fs.readFileSync(userSettingsPath, "utf-8");
					projectBytesBefore = fs.readFileSync(projectSettingsPath, "utf-8");
				},
				custom: async () => {
					userBytesDuringOverlay = fs.readFileSync(userSettingsPath, "utf-8");
					return {
						overrides: new Map<string, string>(),
						laneMutations: [
							{
								kind: "upsert",
								agentName: "worker",
								laneName: "fast",
								patch: { model: "vendor/fast", thinking: "low" },
							},
						],
					};
				},
				after: () => {
					savedRoot = readSettingsFixture(userSettingsPath);
					savedLanes = (savedRoot.subagents as { modelLanes?: LaneMapFixture })
						.modelLanes;
					projectBytesAfter = fs.readFileSync(projectSettingsPath, "utf-8");
				},
			});

			// Nothing is written while the overlay is open.
			assert.equal(userBytesDuringOverlay, userBytesBefore);
			assert.deepEqual(savedLanes, {
				worker: {
					normal: { model: "user/normal" },
					fast: { model: "vendor/fast", thinking: "low" },
				},
			});
			assert.equal(savedRoot?.theme, "dark");
			assert.deepEqual(
				(savedRoot?.subagents as { agentOverrides?: Record<string, unknown> })
					.agentOverrides,
				{ worker: { model: "openai/model-0" } },
			);
			// Project settings are display-only and must be byte-identical.
			assert.equal(projectBytesAfter, projectBytesBefore);
			assert.deepEqual(notifications, [
				{ message: "Subagent model lanes updated", type: "success" },
			]);
		});
	});

	it("merges the lane write into settings changed while the overlay was open", async () => {
		await withTempProject("pi-subagents-lane-merge-", async (root) => {
			let savedRoot: Record<string, unknown> | undefined;

			const { notifications } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					writeSettingsFixture(userSettingsPathForHome(), {
						theme: "dark",
						subagents: { modelLanes: { worker: { normal: { model: "user/normal" } } } },
					});
				},
				// Another writer touches the same file while the overlay is open: a new root key
				// and a sibling lane the overlay never saw. The lane write must merge, not replace.
				custom: async () => {
					writeSettingsFixture(userSettingsPathForHome(), {
						theme: "dark",
						mcpServers: { local: { command: "node" } },
						subagents: {
							modelLanes: {
								worker: {
									normal: { model: "user/normal" },
									sibling: { model: "other-writer/sibling" },
								},
							},
						},
					});
					return {
						overrides: new Map<string, string>(),
						laneMutations: [
							{
								kind: "upsert",
								agentName: "worker",
								laneName: "fast",
								patch: { model: "vendor/fast" },
							},
						],
					};
				},
				after: () => {
					savedRoot = readSettingsFixture(userSettingsPathForHome());
				},
			});

			assert.equal(savedRoot?.theme, "dark");
			assert.deepEqual(savedRoot?.mcpServers, { local: { command: "node" } });
			assert.deepEqual(
				(savedRoot?.subagents as { modelLanes?: LaneMapFixture }).modelLanes,
				{
					worker: {
						normal: { model: "user/normal" },
						sibling: { model: "other-writer/sibling" },
						fast: { model: "vendor/fast" },
					},
				},
			);
			assert.deepEqual(notifications, [
				{ message: "Subagent model lanes updated", type: "success" },
			]);
		});
	});
	const noWriteScenarios: Array<{ label: string; result: unknown }> = [
		{ label: "an undefined result", result: undefined },
		{ label: "a ctrl+c cancel result", result: { overrides: new Map<string, string>() } },
		{
			label: "an empty lane mutation list",
			result: { overrides: new Map<string, string>(), laneMutations: [] },
		},
	];

	for (const scenario of noWriteScenarios) {
		it(`writes nothing for ${scenario.label}`, async () => {
			await withTempProject("pi-subagents-lane-nowrite-", async (root) => {
				let userBytesBefore = "";
				let userBytesAfter = "";
				const { notifications } = await runSubagentsHub({
					cwd: root,
					setup: () => {
						writeSettingsFixture(userSettingsPathForHome(), {
							subagents: { modelLanes: { worker: { normal: { model: "user/normal" } } } },
						});
						userBytesBefore = fs.readFileSync(userSettingsPathForHome(), "utf-8");
					},
					custom: async () => scenario.result,
					after: () => {
						userBytesAfter = fs.readFileSync(userSettingsPathForHome(), "utf-8");
					},
				});

				assert.equal(userBytesAfter, userBytesBefore);
				assert.deepEqual(notifications, []);
			});
		});
	}

	it("refuses to open the overlay when the user lane shape is malformed", async () => {
		await withTempProject("pi-subagents-lane-bad-user-", async (root) => {
			const projectSettingsPath = path.join(root, ".pi", "settings.json");
			let userSettingsPath = "";
			let userBytesBefore = "";
			let userBytesAfter = "";
			let projectBytesBefore = "";
			let projectBytesAfter = "";

			const { notifications, customCalls } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					userSettingsPath = userSettingsPathForHome();
					writeSettingsFixture(userSettingsPath, {
						subagents: { modelLanes: { worker: { normal: "not-an-object" } } },
					});
					writeSettingsFixture(projectSettingsPath, {
						subagents: { modelLanes: { worker: { hard: { model: "project/hard" } } } },
					});
					userBytesBefore = fs.readFileSync(userSettingsPath, "utf-8");
					projectBytesBefore = fs.readFileSync(projectSettingsPath, "utf-8");
				},
				custom: async () => ({
					overrides: new Map<string, string>(),
					laneMutations: [
						{ kind: "upsert", agentName: "worker", laneName: "fast", patch: {} },
					],
				}),
				after: () => {
					userBytesAfter = fs.readFileSync(userSettingsPath, "utf-8");
					projectBytesAfter = fs.readFileSync(projectSettingsPath, "utf-8");
				},
			});

			assert.equal(customCalls, 0, "overlay must not open on a malformed lane shape");
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.type, "error");
			assert.match(notifications[0]?.message ?? "", /must be an object/);
			assert.ok(
				(notifications[0]?.message ?? "").includes(userSettingsPath),
				`expected the user settings path in: ${notifications[0]?.message}`,
			);
			assert.equal(userBytesAfter, userBytesBefore);
			assert.equal(projectBytesAfter, projectBytesBefore);
		});
	});

	it("refuses to open the overlay when the project lane shape is malformed", async () => {
		await withTempProject("pi-subagents-lane-bad-project-", async (root) => {
			const projectSettingsPath = path.join(root, ".pi", "settings.json");
			let userSettingsPath = "";
			let userBytesBefore = "";
			let userBytesAfter = "";
			let projectBytesBefore = "";
			let projectBytesAfter = "";

			const { notifications, customCalls } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					userSettingsPath = userSettingsPathForHome();
					writeSettingsFixture(userSettingsPath, {
						subagents: { modelLanes: { worker: { normal: { model: "user/normal" } } } },
					});
					writeSettingsFixture(projectSettingsPath, {
						subagents: { modelLanes: { worker: { hard: { thinking: "loud" } } } },
					});
					userBytesBefore = fs.readFileSync(userSettingsPath, "utf-8");
					projectBytesBefore = fs.readFileSync(projectSettingsPath, "utf-8");
				},
				custom: async () => ({
					overrides: new Map<string, string>(),
					laneMutations: [
						{ kind: "upsert", agentName: "worker", laneName: "fast", patch: {} },
					],
				}),
				after: () => {
					userBytesAfter = fs.readFileSync(userSettingsPath, "utf-8");
					projectBytesAfter = fs.readFileSync(projectSettingsPath, "utf-8");
				},
			});

			assert.equal(customCalls, 0, "overlay must not open on a malformed lane shape");
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.type, "error");
			assert.match(notifications[0]?.message ?? "", /invalid 'thinking'/);
			assert.ok(
				(notifications[0]?.message ?? "").includes(projectSettingsPath),
				`expected the project settings path in: ${notifications[0]?.message}`,
			);
			assert.equal(userBytesAfter, userBytesBefore);
			assert.equal(projectBytesAfter, projectBytesBefore);
		});
	});

	it("surfaces a store rejection verbatim and claims no success", async () => {
		await withTempProject("pi-subagents-lane-store-error-", async (root) => {
			let userBytesBefore = "";
			let userBytesAfter = "";
			const { notifications } = await runSubagentsHub({
				cwd: root,
				setup: () => {
					writeSettingsFixture(userSettingsPathForHome(), {
						subagents: { modelLanes: { worker: { normal: { model: "user/normal" } } } },
					});
					userBytesBefore = fs.readFileSync(userSettingsPathForHome(), "utf-8");
				},
				// A lane deleted externally while the overlay was open: the store rejects
				// the stale removal and the whole batch fails.
				custom: async () => ({
					overrides: new Map<string, string>(),
					laneMutations: [{ kind: "remove", agentName: "worker", laneName: "ghost" }],
				}),
				after: () => {
					userBytesAfter = fs.readFileSync(userSettingsPathForHome(), "utf-8");
				},
			});

			assert.equal(userBytesAfter, userBytesBefore);
			assert.equal(notifications.length, 1);
			assert.equal(notifications[0]?.type, "error");
			assert.match(
				notifications[0]?.message ?? "",
				/Cannot remove model lane 'ghost' for agent 'worker'/,
			);
			assert.equal(
				notifications.some((note) => note.type === "success"),
				false,
			);
		});
	});

	it("still saves and resets role-default overrides", async () => {
		await withTempProject("pi-subagents-override-save-", async (root) => {
			let savedOverrides: Record<string, unknown> | undefined;
			const saveRun = await runSubagentsHub({
				cwd: root,
				custom: async () => ({
					overrides: new Map<string, string>([["worker", "openai/model-0"]]),
					thinkingOverrides: new Map<string, string>([["worker", "high"]]),
				}),
				after: () => {
					savedOverrides = (
						readSettingsFixture(userSettingsPathForHome()).subagents as {
							agentOverrides?: Record<string, unknown>;
						}
					).agentOverrides;
				},
			});

			assert.deepEqual(savedOverrides, {
				worker: { model: "openai/model-0", thinking: "high" },
			});
			assert.deepEqual(saveRun.notifications, [
				{ message: "Subagent overrides updated", type: "success" },
			]);

			let resetOverrides: Record<string, unknown> | undefined = { present: true };
			const resetRun = await runSubagentsHub({
				cwd: root,
				setup: () => {
					writeSettingsFixture(userSettingsPathForHome(), {
						subagents: {
							agentOverrides: { worker: { model: "openai/model-0", thinking: "high" } },
						},
					});
				},
				custom: async () => ({
					overrides: new Map<string, string>(),
					resetAgents: new Set<string>(["worker"]),
				}),
				after: () => {
					resetOverrides = (
						readSettingsFixture(userSettingsPathForHome()).subagents as {
							agentOverrides?: Record<string, unknown>;
						} | undefined
					)?.agentOverrides;
				},
			});

			assert.equal(resetOverrides, undefined);
			assert.deepEqual(resetRun.notifications, [
				{ message: "Subagent overrides updated", type: "success" },
			]);
		});
	});

	it("reports both domains when overrides and lanes are saved together", async () => {
		await withTempProject("pi-subagents-both-domains-", async (root) => {
			let savedSubagents: Record<string, unknown> | undefined;
			const { notifications } = await runSubagentsHub({
				cwd: root,
				custom: async () => ({
					overrides: new Map<string, string>([["worker", "openai/model-0"]]),
					laneMutations: [
						{
							kind: "upsert",
							agentName: "worker",
							laneName: "normal",
							patch: { model: "vendor/normal" },
						},
					],
				}),
				after: () => {
					savedSubagents = readSettingsFixture(userSettingsPathForHome())
						.subagents as Record<string, unknown>;
				},
			});

			assert.deepEqual(savedSubagents?.agentOverrides, {
				worker: { model: "openai/model-0" },
			});
			assert.deepEqual(savedSubagents?.modelLanes, {
				worker: { normal: { model: "vendor/normal" } },
			});
			assert.deepEqual(notifications, [
				{ message: "Subagent overrides and model lanes updated", type: "success" },
			]);
		});
	});
});
