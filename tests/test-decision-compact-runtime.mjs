// Offline only. Run: node tests/test-decision-compact-runtime.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases",
	readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const agent = join(modules, "@earendil-works/pi-coding-agent");
const load = (path) => import(pathToFileURL(path).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(agent, "dist/index.js"),
	"@earendil-works/pi-ai": join(modules, "@earendil-works/pi-ai/dist/index.js"),
} });
const core = await jiti.import(resolve("extensions/decision-compact.ts"));
const { SessionManager } = await load(join(agent, "dist/index.js"));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const text = (text) => ({ type: "text", text });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, api: "openai-responses", provider: "openai",
	model: "fixture", usage, stopReason: "toolUse", timestamp: 2 });
function addPair(sm, id, payload = "HEAD " + "payload ".repeat(1200) + " TAIL") {
	sm.appendMessage(assistant([text("Inspect exact-path.ts"), { type: "toolCall", id, name: "read", arguments: { path: "exact-path.ts" } }]));
	sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [text(payload)], isError: false, timestamp: 3 });
	// Fixture provenance is seeded as if observed by the live tool_call/tool_result hooks.
	sm.appendCustomEntry(core.PROVENANCE_ENTRY, { version: 1, toolIdHash: hash(id), name: "read", argumentsHash: hash({ path: "exact-path.ts" }) });
}
function commit(sm, drafts) {
	for (const draft of drafts) {
		if (draft.type === "context_edit") sm.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "custom_message") sm.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
		else if (draft.type === "compaction") sm.appendCompaction(draft.summary, draft.firstKeptEntryId, 0, draft.details, true, draft.usage);
		else throw new Error(`Unsupported fixture draft: ${draft.type}`);
	}
}
function harness(overrides = {}) {
	let sm = SessionManager.inMemory("/tmp/decision-compact-runtime");
	sm.appendMessage(user("Current task, preserve literal paths and exact prose"));
	addPair(sm, "initial");
	const calls = [], notices = [], handlers = new Map(), commands = new Map();
	let clock = 1000, trusted = true, idle = true;
	let config = core.parseConfig({ allowRemoteDecisions: true, preserveRecentMessages: 0, minReductionRatio: 0, ...overrides });
	let behavior = async (model, request, opts) => ({ api: "typesafe-system-one", provider: model.provider, model: model.id, stopReason: "stop", timestamp: 1,
		usage: { ...usage, input: 12, totalTokens: 12, cost: { ...usage.cost, total: .001 } },
		answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 0 }])) });
	let catalog = true;
	const tools = ["read", "find", "grep", "ls", "edit", "write"].map((name) => ({ name, sourceInfo: { path: `builtin:${name}` } }));
	const ctx = { cwd: "/tmp/decision-compact-runtime", mode: "tui", hasUI: true,
		ui: { notify: (message) => notices.push(message) },
		isIdle: () => idle, waitForIdle: async () => {}, isProjectTrusted: () => trusted,
		getContextUsage: () => ({ tokens: 999999999, percent: 99, contextWindow: 1000 }), model: { contextWindow: 1000 },
		sessionManager: Object.fromEntries(["getSessionId", "getLeafId", "getHeader", "getBranch", "buildSessionProjection"].map((key) => [key, (...args) => sm[key](...args)])),
		modelRegistry: { findOfType: (type, provider, id) => { assert.equal(type, "classifier"); return catalog ? { provider, id, type, contextWindow: 32000 } : undefined; },
			classify: async (model, request, opts) => { calls.push({ model, request, opts }); return behavior(model, request, opts); } },
		compact() { throw new Error("native compact was changed/called"); },
	};
	core.default({ on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value),
		appendEntry: (name, data) => sm.appendCustomEntry(name, data), getAllTools: () => tools,
		sendUserMessage() { throw new Error("extra chat turn"); }, sendMessage() { throw new Error("extra context message"); },
	}, { config: () => config, now: () => clock });
	return { ctx, calls, notices, handlers, tools,
		get sm() { return sm; }, set sm(value) { sm = value; },
		set behavior(value) { behavior = value; }, set config(value) { config = core.parseConfig(value); },
		set catalog(value) { catalog = value; }, set clock(value) { clock = value; },
		set idle(value) { idle = value; }, set trusted(value) { trusted = value; },
		cmd: async (name) => commands.get("decision-compact").handler(name, ctx),
		boundary: async (prior = [], extras = {}, shouldCommit = true) => {
			const preview = SessionManager.inMemory(ctx.cwd, undefined, [sm.getHeader(), ...sm.getBranch()]);
			commit(preview, prior);
			const projection = preview.buildSessionProjection();
			const event = { type: "turn_end", outcome: "completed", entries: prior, continue: true,
				context: { contextEntries: projection.entries, contextMessages: projection.messages, llmMessages: projection.messages, pendingMessages: [], canContinue: true }, ...extras };
			const answer = await handlers.get("turn_end")(event, ctx);
			assert.equal(answer?.continue, undefined, "must preserve continuation, never force/change a turn");
			if (answer && shouldCommit) commit(sm, answer.entries);
			return answer;
		},
	};
}
const edits = (reply) => reply?.entries.filter((entry) => entry.type === "context_edit") ?? [];
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test("preview classifies through native runtime, never edits or creates chat/context messages", async () => {
	const h = harness(); const before = JSON.stringify(h.sm.getEntries());
	await h.cmd("preview");
	assert.equal(h.calls.length, 1); assert.equal(h.calls[0].model.provider, "typesafe");
	assert.equal(h.calls[0].model.id, "jev-latest"); assert.ok(h.calls[0].opts.signal instanceof AbortSignal);
	assert.equal(JSON.stringify(h.sm.getEntries()), before);
	assert.match(h.notices.at(-1), /preview only/); await h.cmd("status"); assert.match(h.notices.at(-1), /preview:/);
});
await test("apply arms only, grouped boundary edits commit with exact raw history preserved; status verifies host commit", async () => {
	const h = harness(); const raw = JSON.stringify(h.sm.getEntries()); const rawCount = h.sm.getEntries().length;
	await h.cmd("apply"); assert.equal(h.calls.length, 0); assert.match(h.notices.at(-1), /armed, NOT applied/);
	await h.cmd("status"); assert.match(h.notices.at(-1), /armed for next turn/);
	const reply = await h.boundary(); assert.equal(edits(reply).length, 2);
	assert.equal(JSON.stringify(h.sm.getEntries().slice(0, rawCount)), raw);
	assert.equal(h.sm.buildSessionProjection().messages.some((message) => message.role === "toolResult"), false);
	await h.cmd("status"); assert.match(h.notices.at(-1), /committed:/); assert.match(h.notices.at(-1), /manual=not armed/);
	assert.ok(h.sm.getEntries().every((entry) => entry.type !== "usage"), "do not falsify native billing entries");
	assert.equal(JSON.stringify(reply.entries.find((entry) => entry.customType === "pi.decision-compact.audit")).includes("payload payload"), false);
	assert.equal(await h.boundary(), undefined); assert.equal(h.calls.length, 1);
});
await test("status does not claim commit if a later host/handler discards edit drafts", async () => {
	const h = harness(); await h.cmd("apply");
	const reply = await h.boundary([], {}, false); commit(h.sm, reply.entries.filter((entry) => entry.type === "custom"));
	await h.cmd("status"); assert.match(h.notices.at(-1), /not committed by the host/);
});
await test("prior boundary drafts and projected replacements from other extensions compose without resurrection", async () => {
	const h = harness();
	const resultEntry = h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
	const prior = [{ type: "custom", customType: "other.extension", data: { keep: true } },
		{ type: "context_edit", targetId: resultEntry.id, replacement: { content: [text("PROJECTED " + "updated ".repeat(1000))] } }];
	await h.cmd("apply"); const reply = await h.boundary(prior);
	assert.deepEqual(reply.entries.slice(0, 2), prior); assert.equal(edits(reply).length, 3);
	const state = JSON.stringify(h.calls[0].request.state); assert.ok(state.includes("PROJECTED")); assert.equal(state.includes("HEAD payload"), false);
	assert.ok(h.sm.getBranch().some((entry) => entry.customType === "other.extension"));
});
await test("all configured native classifiers use exact IDs with no fallback", async () => {
	for (const [provider, model] of [["typesafe", "jev-latest"], ["opencode", "jev-1.13"], ["opencode", "jev-1.13-free"],
		["cloudflare-workers-ai", "@cf/cloudflare/clef"], ["cloudflare-workers-ai", "@cf/cloudflare/clef-flash"], ["custom", "fixture"]]) {
		const h = harness({ provider, model }); await h.cmd("apply"); const reply = await h.boundary();
		assert.equal(edits(reply).length, 2); assert.deepEqual([h.calls[0].model.provider, h.calls[0].model.id], [provider, model]);
		const noCatalog = harness({ provider, model }); noCatalog.catalog = false; await noCatalog.cmd("apply");
		assert.equal(edits(await noCatalog.boundary()).length, 0); assert.equal(noCatalog.calls.length, 0);
	}
});
await test("missing credentials, thrown provider errors and invalid answers fail closed without secret leakage", async () => {
	for (const behavior of [async () => { throw new Error("SECRET apiKey sk-DO-NOT-LOG"); },
		async () => ({ stopReason: "error", errorMessage: "SECRET credentials" }),
		async () => ({ stopReason: "stop", answers: {} }),
		async (_model, request) => ({ stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: Infinity }])) })]) {
		const h = harness({ provider: "opencode", model: "jev-1.13" }); h.behavior = behavior;
		await h.cmd("apply"); assert.equal(edits(await h.boundary()).length, 0);
		assert.equal(h.calls.length, 1); assert.equal(h.sm.buildSessionProjection().messages.length, 3);
		assert.equal(JSON.stringify(h.sm.getEntries()).includes("SECRET"), false); assert.equal(h.notices.join(" ").includes("SECRET"), false);
		await h.cmd("status"); assert.match(h.notices.at(-1), /failed:/);
	}
});
await test("disabled consent and factory defaults never contact any classifier", async () => {
	const h = harness({ allowRemoteDecisions: false, auto: true });
	await h.cmd("preview"); await h.cmd("apply"); assert.equal(h.calls.length, 0);
	assert.equal(h.sm.getEntries().some((entry) => entry.customType === "pi.decision-compact.request"), false);
	assert.equal(await h.boundary(), undefined);
});
await test("unknown or overridden builtin names cannot be pruned by a native name alone", async () => {
	const h = harness(); h.tools[0].sourceInfo.path = "/tmp/custom-read.ts";
	await h.cmd("apply"); const reply = await h.boundary(); assert.equal(edits(reply).length, 0); assert.equal(h.calls.length, 0);
	assert.equal(h.sm.buildSessionProjection().messages.length, 3);
});
await test("cancel clears queued intent; aborted/error turns do not consume an armed request", async () => {
	const h = harness(); await h.cmd("apply"); assert.equal(await h.boundary([], { outcome: "aborted" }), undefined);
	await h.cmd("status"); assert.match(h.notices.at(-1), /manual=armed/);
	await h.cmd("cancel"); assert.equal(await h.boundary(), undefined); assert.equal(h.calls.length, 0);
});
await test("hard deadline ends a classifier ignoring AbortSignal without edits or hanging", async () => {
	const h = harness({ timeoutMs: 10 }); h.behavior = () => new Promise(() => {});
	await h.cmd("apply"); const started = Date.now(); const reply = await h.boundary();
	assert.ok(Date.now() - started < 1000); assert.equal(edits(reply).length, 0);
	assert.equal(h.calls[0].opts.signal.aborted, true); assert.match(h.notices.at(-1), /deadline exceeded/);
});
await test("in-flight cancel, external abort, session/branch changes cannot commit stale targets", async () => {
	for (const change of [async (h) => h.cmd("cancel"), async (h) => h.handlers.get("session_before_tree")({}, h.ctx),
		async (h) => { h.sm.appendMessage(user("new context")); },
		async (h) => { h.handlers.get("session_before_switch")({}, h.ctx); h.sm = SessionManager.inMemory("/tmp/other-session"); }]) {
		const h = harness(); let release, entered;
		const ready = new Promise((resolve) => { entered = resolve; });
		h.behavior = async (_model, request) => { entered(); await new Promise((resolve) => { release = resolve; }); return {
			stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 0 }])) }; };
		await h.cmd("apply"); const attempt = h.boundary(); await ready; await change(h); release();
		assert.equal(await attempt, undefined);
		assert.equal(h.sm.getEntries().some((entry) => entry.type === "context_edit"), false);
	}
	const h = harness(); const controller = new AbortController(); h.ctx.signal = controller.signal;
	h.behavior = async () => { controller.abort(); return { stopReason: "aborted" }; };
	await h.cmd("apply"); assert.equal(await h.boundary(), undefined);
});
await test("bounded concurrency and budget failures create no partial editing drafts", async () => {
	const h = harness({ maxQuestions: 2, maxRequests: 4, concurrency: 2 });
	for (let index = 0; index < 3; index++) addPair(h.sm, `more-${index}`);
	let concurrent = 0, peak = 0;
	h.behavior = async (_model, request) => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((resolve) => setTimeout(resolve, 2)); concurrent--;
		return { stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 0 }])) }; };
	await h.cmd("apply"); assert.ok(edits(await h.boundary()).length > 0); assert.equal(peak, 2); assert.equal(h.calls.length, 4);
	const budget = harness({ maxStateTokens: 1 }); await budget.cmd("apply");
	assert.equal(edits(await budget.boundary()).length, 0); assert.equal(budget.calls.length, 0);
});
await test("auto requires actual projected pressure, cooldown and new material; no repeated no-op attempts", async () => {
	const h = harness({ auto: true, compactAtPercent: 1, cooldownMs: 100, minNewTokens: 100 });
	h.behavior = async (_model, request) => ({ stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 1 }])) });
	await h.boundary(); assert.equal(h.calls.length, 1);
	h.clock = 1200; assert.equal(await h.boundary(), undefined); assert.equal(h.calls.length, 1);
	addPair(h.sm, "new"); h.clock = 1050; assert.equal(await h.boundary(), undefined);
	h.clock = 1300; await h.boundary(); assert.equal(h.calls.length, 2);
	const low = harness({ auto: true, compactAtPercent: 99 });
	low.ctx.getContextUsage = () => ({ tokens: 999999999, percent: 99, contextWindow: 1000000 });
	assert.equal(await low.boundary(), undefined); assert.equal(low.calls.length, 0, "ignore stale billed tokens/percent");
});
await test("branch-scoped queued intents and audit survive resume; native compaction still works", async () => {
	const h = harness(); const beforeArm = h.sm.getLeafId(); await h.cmd("apply"); const armed = h.sm.getLeafId();
	h.sm.branch(beforeArm); assert.equal(await h.boundary(), undefined); assert.equal(h.calls.length, 0);
	h.sm.branch(armed); await h.handlers.get("session_start")({}, h.ctx); await h.boundary();
	const stored = [h.sm.getHeader(), ...h.sm.getEntries()];
	h.sm = SessionManager.inMemory(h.ctx.cwd, undefined, structuredClone(stored));
	await h.handlers.get("session_start")({}, h.ctx); await h.cmd("status"); assert.match(h.notices.at(-1), /committed:/);
	const lastUser = h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user").id;
	h.sm.appendCompaction("Native summary remains available", lastUser, 1234);
	assert.ok(h.sm.buildSessionProjection().messages.some((message) => message.role === "compactionSummary"));
	await h.cmd("apply"); assert.equal(edits(await h.boundary()).length, 0);
	const fork = SessionManager.inMemory(h.ctx.cwd, undefined, [h.sm.getHeader(), ...h.sm.getBranch()]);
	assert.deepEqual(fork.buildSessionProjection().messages, h.sm.buildSessionProjection().messages);
});
await test("print mode produces no unsolicited stdout/UI output but retains auditable results", async () => {
	const h = harness(); h.ctx.hasUI = false; h.ctx.mode = "print";
	await h.cmd("apply"); await h.boundary(); assert.deepEqual(h.notices, []);
	assert.ok(h.sm.getBranch().some((entry) => entry.customType === "pi.decision-compact.audit"));
});
await test("config file loading respects user consent, project trust, malformed/oversized files", async () => {
	const directory = mkdtempSync(join(tmpdir(), "decision-config-"));
	try {
		const agentDir = join(directory, "agent"), cwd = join(directory, "project");
		mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
		const ctx = { cwd, isProjectTrusted: () => false };
		assert.deepEqual(core.loadDecisionConfig(ctx, agentDir), core.DEFAULT_CONFIG);
		writeFileSync(join(cwd, ".pi/decision-compact.json"), JSON.stringify({ allowRemoteDecisions: true }));
		assert.equal(core.loadDecisionConfig(ctx, agentDir).allowRemoteDecisions, false);
		ctx.isProjectTrusted = () => true; assert.throws(() => core.loadDecisionConfig(ctx, agentDir), /USER consent/);
		writeFileSync(join(agentDir, "decision-compact.json"), JSON.stringify({ allowRemoteDecisions: true }));
		assert.equal(core.loadDecisionConfig(ctx, agentDir).allowRemoteDecisions, true);
		writeFileSync(join(cwd, ".pi/decision-compact.json"), JSON.stringify({ provider: "opencode", model: "jev-1.13-free" }));
		assert.equal(core.loadDecisionConfig(ctx, agentDir).model, "jev-1.13-free");
		writeFileSync(join(agentDir, "decision-compact.json"), "{SECRET broken");
		assert.throws(() => core.loadDecisionConfig(ctx, agentDir), (error) => !error.message.includes("SECRET"));
		writeFileSync(join(agentDir, "decision-compact.json"), "x".repeat(33000));
		assert.throws(() => core.loadDecisionConfig(ctx, agentDir));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
await test("classifier evidence is detached from raw transcript objects", async () => {
	const h = harness(); const raw = structuredClone(h.sm.getEntries());
	h.behavior = async (_model, request) => {
		request.state.untrustedData.candidates[0].arguments.path = "MUTATED";
		return { stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 0 }])) };
	};
	await h.cmd("apply"); await h.boundary();
	assert.deepEqual(h.sm.getEntries().slice(0, raw.length), raw, "provider must not mutate raw call arguments by reference");
});
await test("in-place target mutations are stale even without a leaf change", async () => {
	const h = harness();
	h.behavior = async (_model, request) => {
		h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult").message.content[0].text = "IN-PLACE CHANGE";
		return { stopReason: "stop", answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 0 }])) };
	};
	await h.cmd("apply"); assert.equal(edits(await h.boundary()).length, 0);
});
await test("later restoring boundary edits supersede commit verification", async () => {
	const h = harness(); const raw = h.sm.getBranch().filter((entry) => entry.type === "message");
	await h.cmd("apply"); const reply = await h.boundary([], {}, false);
	commit(h.sm, [...reply.entries, ...raw.filter((entry) => entry.message.role !== "user").map((entry) => ({ type: "context_edit", targetId: entry.id, replacement: { content: entry.message.content } }))]);
	await h.cmd("status"); assert.doesNotMatch(h.notices.at(-1), /committed: pruned context/);
});
await test("native classifier transport retries are disabled to enforce request budgets", async () => {
	const h = harness(); await h.cmd("preview"); assert.equal(h.calls[0].opts.maxRetries, 0);
});
await test("preflight budget failure records material and does not repeat until config changes", async () => {
	const h = harness({ auto: true, compactAtPercent: 1, cooldownMs: 0, maxStateTokens: 1 });
	await h.boundary(); const before = h.sm.getEntries().length;
	h.clock = 100000; assert.equal(await h.boundary(), undefined); assert.equal(h.sm.getEntries().length, before);
	h.config = { allowRemoteDecisions: true, auto: true, compactAtPercent: 1, cooldownMs: 0, preserveRecentMessages: 0, minReductionRatio: 0 };
	await h.boundary(); assert.equal(h.calls.length, 1);
});
await test("unpriced generic classifier zero cost is unknown, not advertised as free", async () => {
	const h = harness({ provider: "custom", model: "fixture" });
	h.behavior = async (_model, request) => ({ stopReason: "stop", usage: { ...usage, input: 10 },
		answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "bool", probability: 1 }])) });
	await h.cmd("preview"); assert.match(h.notices.at(-1), /cost unknown/);
});
await test("old histories without execution-time provenance stay pinned even when current read is builtin", async () => {
	const h = harness(); const result = h.sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult");
	h.sm.branch(result.id); await h.cmd("apply");
	assert.equal(edits(await h.boundary()).length, 0); assert.equal(h.calls.length, 0);
});
await test("live native tool provenance requires both endpoints and unchanged input/source; nested calls are excluded", async () => {
	for (const mode of ["native", "overridden-before", "overridden-after", "changed-input", "nested"]) {
		const h = harness(); h.sm = SessionManager.inMemory(h.ctx.cwd); h.sm.appendMessage(user("Task"));
		const input = { path: "exact-path.ts" };
		const event = { toolName: "read", toolCallId: "observed", input, ...(mode === "nested" ? { parentToolCallId: "parent" } : {}) };
		if (mode === "overridden-before") h.tools[0].sourceInfo.path = "/custom-read.ts";
		h.handlers.get("tool_call")({ type: "tool_call", ...event }, h.ctx);
		if (mode === "changed-input") input.path = "changed.ts";
		h.tools[0].sourceInfo.path = mode === "overridden-after" ? "/custom-read.ts" : "builtin:read";
		h.sm.appendMessage(assistant([{ type: "toolCall", id: "observed", name: "read", arguments: structuredClone(input) }]));
		h.sm.appendMessage({ role: "toolResult", toolCallId: "observed", toolName: "read", content: [text("x".repeat(5000))], isError: false, timestamp: 3 });
		h.handlers.get("tool_result")({ type: "tool_result", ...event, content: [text("x".repeat(5000))], isError: false }, h.ctx);
		await h.cmd("apply"); const reply = await h.boundary();
		assert.equal(edits(reply).length > 0, mode === "native", mode);
	}
});
await test("real JSONL reopen and public forkFrom replay pruning and provenance without touching user sessions", async () => {
	const h = harness(); await h.cmd("apply"); await h.boundary();
	const directory = mkdtempSync(join(tmpdir(), "decision-session-"));
	try {
		const file = join(directory, "fixture.jsonl");
		writeFileSync(file, [h.sm.getHeader(), ...h.sm.getBranch()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const reopened = SessionManager.open(file, directory);
		assert.deepEqual(reopened.buildSessionProjection().messages, h.sm.buildSessionProjection().messages);
		assert.equal(reopened.getEntries().filter((entry) => entry.type === "message").length, 3);
		assert.ok(reopened.getBranch().some((entry) => entry.customType === core.PROVENANCE_ENTRY));
		const fork = SessionManager.forkFrom(file, h.ctx.cwd, directory);
		assert.notEqual(fork.getSessionId(), reopened.getSessionId());
		assert.deepEqual(fork.buildSessionProjection().messages, reopened.buildSessionProjection().messages);
		assert.ok(fork.getSessionFile().startsWith(directory));
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
await test("example config is safe by default and matches strict schema", async () => {
	const example = JSON.parse(readFileSync(resolve("config/decision-compact.example.json"), "utf8"));
	assert.deepEqual(core.parseConfig(example), core.DEFAULT_CONFIG);
});
console.log(`PASS ${passed} offline runtime test groups`);
