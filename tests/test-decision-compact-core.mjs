// Offline only. Run: node tests/test-decision-compact-core.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
const { SessionManager, estimateTokens } = await load(join(agent, "dist/index.js"));
const { DEFAULT_CONFIG, parseConfig, collectPairs, prepareRequests, decisionsFromAnswers,
	createProposal, estimateJsonTokens, PRUNED_MARKER } = core;
const config = (overrides = {}) => parseConfig({ preserveRecentMessages: 0, minReductionRatio: 0, ...overrides });
const usage = { input: 99999999, output: 99999999, cacheRead: 99999999, cacheWrite: 0, totalTokens: 299999997,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text = "Keep exact paths and implement the task.") => ({ role: "user", content: text, timestamp: 1 });
const text = (value) => ({ type: "text", text: value });
const call = (id, name = "read", args = { path: "src/a.ts" }) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content, extra = {}) => ({ role: "assistant", content, api: "openai-responses", provider: "openai",
	model: "fixture", usage: structuredClone(usage), stopReason: "toolUse", timestamp: 2, durationMs: 43,
	responseId: "response-original", thinkingLevel: "low", rawStopReason: "tool_calls", ...extra });
const result = (id, value = "HEAD: exact evidence\n" + "payload ".repeat(1200) + "\nTAIL: exact evidence", name = "read", extra = {}) => ({
	role: "toolResult", toolCallId: id, toolName: name, content: [text(value)], isError: false, timestamp: 3,
	durationMs: 17, details: { path: "src/a.ts", marker: "metadata exact" }, ...extra });
function fixture(messages) {
	const sm = SessionManager.inMemory("/tmp/decision-compact-core");
	for (const message of messages) sm.appendMessage(message);
	return sm;
}
function entries(sm) { return sm.buildSessionProjection().entries; }
function decisions(pairs, score = { keepCall: 0, keepResult: 0 }) { return new Map(pairs.filter((pair) => !pair.pinnedReason).map((pair) => [pair.key, score])); }
function propose(sm, cfg = config(), score) {
	const projected = entries(sm);
	const pairs = collectPairs(projected, cfg);
	return createProposal(projected, pairs, decisions(pairs, score), cfg);
}
function commit(sm, proposal) {
	for (const edit of proposal.edits) sm.appendContextEdit(edit.targetId, edit.replacement);
}
function freezeDeep(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freezeDeep); }
	return value;
}
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test("defaults, strict JSON config and user-only remote consent", () => {
	assert.deepEqual(parseConfig(), DEFAULT_CONFIG);
	assert.equal(DEFAULT_CONFIG.provider, "typesafe"); assert.equal(DEFAULT_CONFIG.model, "jev-latest");
	assert.equal(DEFAULT_CONFIG.allowRemoteDecisions, false); assert.equal(DEFAULT_CONFIG.auto, false);
	for (const value of [null, [], "{}", new Date(), () => {}]) assert.throws(() => parseConfig(value));
	for (const invalid of [{ apiKey: "secret" }, { url: "https://example.test" }, { provider: 1 }, { provider: "https://example.test" },
		{ model: "!command" }, { auto: 1 }, { allowRemoteDecisions: "true" }, { keepThreshold: NaN }, { keepThreshold: Infinity },
		{ keepThreshold: -1 }, { minReductionRatio: 1.01 }, { maxQuestions: 65 }, { maxRequests: 1.5 }, { concurrency: 0 },
		{ truncateHeadChars: 0 }, { timeoutMs: -1 }, { toString: "attack" }, { maxRequestBytes: undefined }]) assert.throws(() => parseConfig(invalid));
	assert.throws(() => parseConfig({}, { allowRemoteDecisions: true }), /USER consent/);
	assert.throws(() => parseConfig({ allowRemoteDecisions: false }, { allowRemoteDecisions: true }));
	assert.equal(parseConfig({ allowRemoteDecisions: true }, { allowRemoteDecisions: true }).allowRemoteDecisions, true);
	assert.equal(parseConfig({ allowRemoteDecisions: true }, { allowRemoteDecisions: false }).allowRemoteDecisions, false);
	assert.equal(parseConfig({}, { provider: "opencode", model: "jev-1.13-free" }).model, "jev-1.13-free");
	assert.equal(parseConfig({}, { model: "@cf/cloudflare/clef" }).model, "@cf/cloudflare/clef");
	assert.throws(() => parseConfig({ [Symbol("bad")]: 1 }));
	assert.throws(() => parseConfig(Object.defineProperty({}, "auto", { get() { throw new Error("getter executed"); }, enumerable: true })), /non-JSON/);
});

test("all three actions, mixed multi-call message, exact prose/metadata and real projection", () => {
	const thinking = { type: "thinking", thinking: "Retained unsigned thinking verbatim" };
	const sm = fixture([user(), assistant([text("  Inspect src/a.ts\nverbatim **text**  "), thinking, call("keep"), call("truncate"), call("drop")]),
		result("keep"), result("truncate"), result("drop"), assistant([text("Continue the task.")], { stopReason: "stop" })]);
	const baseline = sm.buildSessionProjection();
	const original = JSON.stringify(sm.getEntries());
	freezeDeep(baseline.entries);
	const pairs = collectPairs(baseline.entries, config());
	assert.equal(pairs.length, 3); assert.ok(pairs.every((pair) => !pair.pinnedReason));
	assert.deepEqual(pairs.map((pair) => pair.callBlockIndex), [2, 3, 4]);
	const scores = new Map(pairs.map((pair, index) => [pair.key, [{ keepCall: 1, keepResult: 1 }, { keepCall: 1, keepResult: 0 }, { keepCall: 0, keepResult: 0 }][index]]));
	const proposal = createProposal(baseline.entries, pairs, scores, config());
	assert.equal(proposal.accepted, true);
	assert.deepEqual([proposal.stats.kept, proposal.stats.truncated, proposal.stats.dropped], [1, 1, 1]);
	assert.equal(proposal.stats.beforeTokens, baseline.messages.reduce((sum, message) => sum + estimateTokens(message), 0));
	assert.ok(proposal.stats.beforeTokens < 20000); // Never cumulative historical usage.
	assert.equal(JSON.stringify(sm.getEntries()), original);
	commit(sm, proposal);
	const after = sm.buildSessionProjection().messages;
	assert.deepEqual(after[0], baseline.messages[0]);
	assert.deepEqual(after[1], { ...baseline.messages[1], content: baseline.messages[1].content.slice(0, 4) });
	assert.deepEqual(after[2], baseline.messages[2]);
	assert.deepEqual({ ...after[3], content: baseline.messages[3].content }, baseline.messages[3]);
	assert.ok(after[3].content[0].text.startsWith("HEAD: exact evidence"));
	assert.ok(after[3].content[0].text.endsWith("TAIL: exact evidence"));
	assert.ok(after[3].content[0].text.includes(PRUNED_MARKER));
	assert.ok(after[3].content[0].text.includes("do not rerun side effects"));
	assert.equal(after.some((message) => message.role === "toolResult" && message.toolCallId === "drop"), false);
	assert.equal(proposal.stats.afterTokens, after.reduce((sum, message) => sum + estimateTokens(message), 0));
	assert.equal(JSON.stringify(sm.getEntries().slice(0, baseline.entries.length)), original);
});

test("call-only assistant omission is atomic, zero savings and minimum reduction reject edits", () => {
	const sm = fixture([user(), assistant([call("drop")]), result("drop")]);
	const proposal = propose(sm);
	assert.equal(proposal.accepted, true); assert.equal(proposal.edits.length, 2);
	assert.ok(proposal.edits.every((edit) => edit.replacement === null));
	commit(sm, proposal); assert.deepEqual(sm.buildSessionProjection().messages, [user()]);
	const kept = fixture([user(), assistant([call("keep")]), result("keep")]);
	const noOp = propose(kept, config(), { keepCall: 1, keepResult: 1 });
	assert.equal(noOp.accepted, false); assert.deepEqual(noOp.edits, []); assert.equal(noOp.stats.reduction, 0);
	const largeUser = fixture([user("u".repeat(30000)), assistant([call("old")]), result("old")]);
	const rejected = propose(largeUser, config({ minReductionRatio: .9 }));
	assert.equal(rejected.accepted, false); assert.deepEqual(rejected.edits, []);
	assert.ok(rejected.stats.reduction > 0); assert.equal(rejected.stats.dropped, 1);
});

test("recent pin checks both message endpoints, not raw/state-entry count; all user messages unchanged", () => {
	const sm = fixture([user(), assistant([call("old")]), result("old"), user("Latest goal")]);
	for (let index = 0; index < 20; index++) sm.appendCustomEntry("state", { index });
	const pairs = collectPairs(entries(sm), config({ preserveRecentMessages: 2 }));
	assert.match(pairs[0].pinnedReason, /recent/); // Call outside window, result inside.
	const pinned = createProposal(entries(sm), pairs, new Map([[pairs[0].key, { keepCall: 0, keepResult: 0 }]]), config({ preserveRecentMessages: 2 }));
	assert.equal(pinned.stats.pinned, 1); assert.deepEqual(pinned.edits, []);
	assert.ok(collectPairs(entries(sm), DEFAULT_CONFIG)[0].pinnedReason);
	assert.equal(collectPairs(entries(sm), config({ preserveRecentMessages: 1 }))[0].pinnedReason, undefined);
	const drop = propose(sm); commit(sm, drop);
	assert.deepEqual(sm.buildSessionProjection().messages, [user(), user("Latest goal")]);
});

test("incomplete, duplicate, empty, wrong-name, reversed and interrupted pairs are pinned", () => {
	const fixtures = [
		[assistant([call("missing")])], [result("orphan")],
		[assistant([call("dup"), call("dup")]), result("dup")],
		[assistant([call("dup")]), result("dup"), result("dup")],
		[assistant([call("")]), result("")],
		[assistant([call("name")]), result("name", "data", "grep")],
		[result("reversed"), assistant([call("reversed")])],
		[assistant([call("interrupted")]), user("new turn"), result("interrupted")],
	];
	for (const messages of fixtures) {
		const sm = fixture([user(), ...messages]);
		const pairs = collectPairs(entries(sm), config()); assert.ok(pairs.every((pair) => pair.pinnedReason));
		const proposal = createProposal(entries(sm), pairs, decisions(pairs), config());
		assert.deepEqual(proposal.edits, []);
	}
	for (const stopReason of ["pending", "error", "aborted", "deferred", "length"]) {
		const sm = fixture([user(), assistant([call("failed")], { stopReason }), result("failed")]);
		assert.match(collectPairs(entries(sm), config())[0].pinnedReason, /unfinished|failed/);
	}
});

test("images, opaque signatures and unsupported blocks pin entire assistant group", () => {
	const variants = [
		{ block: { type: "thinking", thinking: "secret reasoning", thinkingSignature: "opaque" } },
		{ block: { type: "thinking", thinking: "", redacted: true } },
		{ block: { type: "text", text: "signed", textSignature: "" } },
		{ callExtra: { thoughtSignature: "secret opaque signature" } },
		{ block: { type: "image", data: "DO NOT SEND", mimeType: "image/png" } },
		{ resultContent: [{ type: "image", data: "DO NOT SEND", mimeType: "image/png" }] },
		{ block: { type: "futureBlock", payload: "unknown" } },
		{ resultContent: [{ type: "text", text: "signed output", textSignature: "opaque" }] },
	];
	for (const variant of variants) {
		const sm = fixture([user(), assistant([text("prose"), ...(variant.block ? [variant.block] : []),
			{ ...call("a"), ...variant.callExtra }, call("b")]),
			result("a", undefined, "read", variant.resultContent ? { content: variant.resultContent } : {}), result("b")]);
		const prepared = prepareRequests(entries(sm), config());
		assert.equal(prepared.requests.length, 0); assert.ok(prepared.pairs.every((pair) => /opaque|unsupported/.test(pair.pinnedReason)));
		const scores = new Map(prepared.pairs.map((pair) => [pair.key, { keepCall: 0, keepResult: 0 }]));
		assert.deepEqual(createProposal(entries(sm), prepared.pairs, scores, config()).edits, []);
	}
});

test("errors, unknown effects and annotations cannot prove destructive safety", () => {
	for (const name of ["bash", "powershell", "mcp__fs__read", "read_remote", "delete", "edit", "write"]) {
		const sm = fixture([user(), assistant([call("unsafe", name)]), result("unsafe", undefined, name)]);
		const hints = new Map([[name, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }]]);
		assert.ok(collectPairs(entries(sm), config(), hints)[0].pinnedReason);
	}
	for (const extra of [{ isError: true }, { nestedCalls: { calls: [], complete: true } }]) {
		const sm = fixture([user(), assistant([call("read")]), result("read", undefined, "read", extra)]);
		assert.ok(collectPairs(entries(sm), config())[0].pinnedReason);
	}
	const sm = fixture([user(), assistant([call("read")]), result("read")]);
	for (const hint of [{ destructiveHint: true }, { openWorldHint: true }, { readOnlyHint: "true" }, { bogus: true }]) {
		const pairs = collectPairs(entries(sm), config(), new Map([["read", hint]]));
		assert.ok(pairs[0].pinnedReason);
		assert.deepEqual(createProposal(entries(sm), pairs, new Map(), config()).edits, []);
	}
	for (const name of ["read", "find", "grep", "ls"]) {
		const safe = fixture([user(), assistant([call("safe", name)]), result("safe", undefined, name)]);
		assert.equal(collectPairs(entries(safe), config())[0].pinnedReason, undefined);
	}
});

test("native edit/write need surviving execution receipt, eligible mutation pair can keep/truncate/drop", () => {
	for (const name of ["edit", "write"]) {
		const args = name === "edit" ? { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } : { path: "src/a.ts", content: "b" };
		const receipt = name === "edit" ? "Successfully replaced 1 block(s) in src/a.ts." : "Successfully wrote to src/a.ts";
		const sm = fixture([user(), assistant([call("mutation", name, args)]), result("mutation", receipt, name)]);
		assert.match(collectPairs(entries(sm), config())[0].pinnedReason, /receipt/);
		sm.appendMessage(assistant([text(`Execution receipt: ${receipt}\nDo not repeat.`)], { stopReason: "stop" }));
		const pairs = collectPairs(entries(sm), config()); assert.equal(pairs[0].pinnedReason, undefined);
		const kept = createProposal(entries(sm), pairs, decisions(pairs, { keepCall: 1, keepResult: 1 }), config());
		assert.equal(kept.stats.kept, 1);
		const truncated = createProposal(entries(sm), pairs, decisions(pairs, { keepCall: 1, keepResult: 0 }), config({ truncateHeadChars: 1, truncateTailChars: 1 }));
		// A bounded execution receipt is already shorter than the omission marker: no-op.
		assert.equal(truncated.stats.kept, 1); assert.deepEqual(truncated.edits, []);
		const dropped = createProposal(entries(sm), pairs, decisions(pairs), config());
		assert.equal(dropped.stats.dropped, 1); commit(sm, dropped);
		assert.ok(sm.buildSessionProjection().messages.at(-1).content[0].text.includes(receipt));
	}
	// A long native path makes the existing execution receipt genuinely truncatable.
	const path = "src/" + "long-directory/".repeat(50) + "a.ts";
	const receipt = `Successfully wrote to ${path}`;
	const sm = fixture([user(), assistant([call("write", "write", { path, content: "done" })]), result("write", receipt, "write"),
		assistant([text(receipt)], { stopReason: "stop" })]);
	const truncated = propose(sm, config(), { keepCall: 1, keepResult: 0 });
	assert.equal(truncated.stats.truncated, 1); commit(sm, truncated);
	assert.ok(sm.buildSessionProjection().messages.at(-1).content[0].text.includes(receipt));
});

test("mutation receipt survives simultaneous dropping of the receipt-bearing assistant's calls", () => {
	const receipt = "Successfully wrote to src/a.ts";
	const sm = fixture([user(), assistant([call("mutation", "write", { path: "src/a.ts", content: "done" })]), result("mutation", receipt, "write"),
		assistant([text(`Receipt: ${receipt}`), call("later-read")]), result("later-read")]);
	const proposal = propose(sm); assert.equal(proposal.stats.dropped, 2);
	commit(sm, proposal);
	assert.deepEqual(sm.buildSessionProjection().messages, [user(), assistant([text(`Receipt: ${receipt}`)])]);
});

test("short output truncation is no-op; previous edit projection is not resurrected; repeated edits idempotent", () => {
	const short = fixture([user(), assistant([call("short")]), result("short", "short")]);
	assert.deepEqual(propose(short, config(), { keepCall: 1, keepResult: 0 }).edits, []);
	const sm = fixture([user(), assistant([text("raw assistant text"), call("old")]), result("old")]);
	const before = entries(sm);
	sm.appendContextEdit(before[1].sourceEntry.id, { content: [text("projected assistant text"), call("old")] });
	sm.appendContextEdit(before[2].sourceEntry.id, { content: [text("PROJECTED HEAD " + "replacement ".repeat(900) + " PROJECTED TAIL")] });
	const raw = JSON.stringify(sm.getEntries());
	const prepared = prepareRequests(entries(sm), config());
	const serialized = JSON.stringify(prepared.requests);
	assert.ok(serialized.includes("PROJECTED HEAD")); assert.ok(serialized.includes("PROJECTED TAIL"));
	assert.equal(serialized.includes("raw assistant text"), false);
	const proposal = createProposal(entries(sm), prepared.pairs, decisions(prepared.pairs, { keepCall: 1, keepResult: 0 }), config());
	assert.equal(JSON.stringify(sm.getEntries()), raw); commit(sm, proposal);
	assert.equal(sm.buildSessionProjection().messages[1].content[0].text, "projected assistant text");
	assert.ok(collectPairs(entries(sm), config())[0].pinnedReason.includes("previously pruned"));
	assert.deepEqual(propose(sm).edits, []);
	assert.deepEqual(prepareRequests(entries(sm), config()).requests, []);
});

test("bounded classifier state includes arguments, latest goal, history and actual output head/tail, not opaque metadata", () => {
	const sm = fixture([user("Original goal"), assistant([text("Retain literal prose"), { type: "thinking", thinking: "RAW REASONING NEVER SENT" }, call("opaque-provider/id#with punctuation")]),
		result("opaque-provider/id#with punctuation"), user("Current task goal")]);
	const prepared = prepareRequests(entries(sm), config());
	assert.equal(prepared.requests.length, 1);
	const request = prepared.requests[0];
	assert.equal(request.state.untrustedData.currentGoal, "Current task goal");
	assert.ok(JSON.stringify(request.state).includes("Original goal"));
	assert.ok(JSON.stringify(request.state).includes("Retain literal prose"));
	assert.ok(JSON.stringify(request.state).includes("HEAD: exact evidence"));
	assert.ok(JSON.stringify(request.state).includes("TAIL: exact evidence"));
	assert.ok(JSON.stringify(request.state).includes("src/a.ts"));
	assert.equal(JSON.stringify(request.state).includes("RAW REASONING"), false);
	assert.equal(JSON.stringify(request.state).includes("metadata exact"), false);
	assert.match(request.state.policy, /untrusted/);
	assert.equal(Object.keys(request.questions).length, 2);
	for (const [id, question] of Object.entries(request.questions)) {
		assert.match(id, /^[a-z0-9_]+$/); assert.ok(id.length < 64);
		assert.equal(question.type, "bool"); assert.deepEqual(Object.keys(question.criteria).sort(), ["false", "true"]);
	}
	assert.throws(() => prepareRequests(entries(sm), config({ maxStateTokens: 10 })), /cannot fit/);
	assert.throws(() => prepareRequests(entries(sm), config({ maxRequestBytes: 10 })), /cannot fit/);
	assert.throws(() => prepareRequests(entries(sm), config(), 10), /cannot fit/);
	assert.throws(() => prepareRequests(entries(sm), config(), NaN), /context window/);
});

test("unavailable image evidence or oversized user history aborts before producing requests", () => {
	const sm = fixture([user(), assistant([call("read")]), result("read"),
		{ role: "user", content: [text("Use this diagram"), { type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }], timestamp: 4 }]);
	const raw = JSON.stringify(sm.getEntries());
	assert.throws(() => prepareRequests(entries(sm), config()), /evidence includes images/);
	assert.equal(JSON.stringify(sm.getEntries()), raw);
	const tooLarge = fixture([user("important requirements ".repeat(2000)), assistant([call("read")]), result("read")]);
	assert.throws(() => prepareRequests(entries(tooLarge), config()), /cannot fit/);
});

test("Jev/OpenCode/Clef question IDs and request/attempt budgets are deterministic across backend policies", () => {
	const sm = fixture([user()]);
	const calls = [];
	for (let index = 0; index < 33; index++) calls.push(call(`id/${index}::opaque`));
	sm.appendMessage(assistant(calls));
	for (let index = 0; index < 33; index++) sm.appendMessage(result(`id/${index}::opaque`, `start-${index}` + "x".repeat(800) + `end-${index}`));
	for (const [provider, model] of [["typesafe", "jev-latest"], ["opencode", "jev-1.13"], ["opencode", "jev-1.13-free"],
		["cloudflare-workers-ai", "@cf/cloudflare/clef"], ["cloudflare-workers-ai", "@cf/cloudflare/clef-flash"], ["custom", "fixture"]]) {
		const cfg = config({ provider, model, maxStateTokens: 100000, maxRequestTokens: 100000, maxAttemptTokens: 200000, maxRequestBytes: 100000 });
		const prepared = prepareRequests(entries(sm), cfg, 100000);
		assert.equal(prepared.pairs.length, 33); assert.ok(prepared.requests.length >= 2);
		assert.equal(prepared.requests.reduce((sum, request) => sum + request.keys.length, 0), 33);
		const ids = prepared.requests.flatMap((request) => Object.keys(request.questions));
		assert.equal(new Set(ids).size, 66);
		for (const request of prepared.requests) {
			assert.ok(Object.keys(request.questions).length <= 64);
			assert.ok(Buffer.byteLength(JSON.stringify(request.state)) <= cfg.maxStateTokens);
			const wireQuestions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, { ...question, type: "noul" }]));
			const input = { state: request.state, questions: wireQuestions };
			const wire = provider === "cloudflare-workers-ai" ? { model, input } : { model, ...input };
			const bytes = Buffer.byteLength(JSON.stringify(wire));
			const estimated = bytes + Object.keys(request.questions).length * 32;
			assert.ok(bytes <= cfg.maxRequestBytes); assert.ok(estimated <= cfg.maxRequestTokens);
			assert.ok(estimated <= Math.floor((provider === "cloudflare-workers-ai" ? 65536 : 32000) * .8));
			const fakeAnswers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "bool", probability: 1 }]));
			assert.equal(decisionsFromAnswers(request, fakeAnswers).size, request.keys.length);
		}
		assert.deepEqual(prepareRequests(entries(sm), cfg, 100000), prepared);
		assert.throws(() => prepareRequests(entries(sm), { ...cfg, maxRequests: 1 }, 100000), /attempt budget/);
		assert.throws(() => prepareRequests(entries(sm), { ...cfg, maxAttemptTokens: 1 }, 100000), /attempt budget/);
	}
	// 33 one-candidate requests cannot fit the configured request-count bound.
	assert.throws(() => prepareRequests(entries(sm), config({ maxQuestions: 2, maxRequests: 32, maxAttemptTokens: 200000 })), /attempt budget/);
});

test("UTF-8 JSON accounting covers Unicode and escapes and does not split surrogate pairs", () => {
	assert.equal(estimateJsonTokens({ text: "漢字😀\n\"" }), Buffer.byteLength(JSON.stringify({ text: "漢字😀\n\"" }), "utf8"));
	const sm = fixture([user("Unicode goal 漢字😀"), assistant([call("unicode")]), result("unicode", "😀漢字".repeat(500))]);
	const cfg = config({ truncateHeadChars: 7, truncateTailChars: 5 });
	const request = prepareRequests(entries(sm), cfg).requests[0];
	const excerpt = request.state.untrustedData.candidates[0].output;
	assert.equal(Array.from(excerpt.head).length, 7); assert.equal(Array.from(excerpt.tail).length, 5);
	assert.equal(excerpt.head.isWellFormed(), true); assert.equal(excerpt.tail.isWellFormed(), true);
	const proposal = propose(sm, cfg, { keepCall: 1, keepResult: 0 });
	commit(sm, proposal); assert.equal(sm.buildSessionProjection().messages[2].content[0].text.isWellFormed(), true);
	assert.deepEqual(prepareRequests(entries(sm), config({ maxRequestBytes: 1 })).requests, []); // Already pruned: no remote evidence required.
});

test("answers fail closed for missing/wrong-type/nonfinite/out-of-range probabilities, Maps supported", () => {
	const sm = fixture([user(), assistant([call("a")]), result("a")]);
	const request = prepareRequests(entries(sm), config()).requests[0];
	const [first, second] = Object.keys(request.questions);
	const valid = { [first]: { type: "bool", probability: .6 }, [second]: { type: "bool", probability: .7 } };
	assert.deepEqual(decisionsFromAnswers(request, valid).get(request.keys[0]), { keepCall: .6, keepResult: .7 });
	assert.deepEqual(decisionsFromAnswers(request, new Map(Object.entries(valid))), decisionsFromAnswers(request, valid));
	for (const probability of [NaN, Infinity, -Infinity, -1, 1.01, ".5", null, undefined]) {
		assert.throws(() => decisionsFromAnswers(request, { ...valid, [second]: { type: "bool", probability } }));
	}
	for (const answers of [{}, { [first]: valid[first] }, null, [], { ...valid, injected: { type: "bool", probability: 0 } },
		{ ...valid, [second]: { type: "choice", probability: 1 } }]) assert.throws(() => decisionsFromAnswers(request, answers));
	const pairs = collectPairs(entries(sm), config());
	assert.throws(() => createProposal(entries(sm), pairs, new Map(), config()), /Missing decision/);
	assert.throws(() => createProposal(entries(sm), pairs, new Map([[pairs[0].key, { keepCall: 1, keepResult: NaN }]]), config()), /probability/);
	assert.throws(() => createProposal(entries(sm), pairs, new Map([["unknown", { keepCall: 0, keepResult: 0 }]]), config()), /Unknown/);
});

test("stale targets, missing pairs and weaker pinning cannot bypass local invariants", () => {
	const sm = fixture([user(), assistant([call("old")]), result("old")]);
	const projected = entries(sm); const pairs = collectPairs(projected, config());
	assert.throws(() => createProposal(projected, [], new Map(), config()), /Stale/);
	assert.throws(() => createProposal(projected, [{ ...pairs[0], callBlockIndex: 99 }], decisions(pairs), config()), /Stale/);
	sm.appendContextEdit(pairs[0].resultEntryId, { content: [text("different result")] });
	assert.throws(() => createProposal(entries(sm), pairs, decisions(pairs), config()), /Stale/);
	const bad = fixture([user(), assistant([call("bad", "bash")]), result("bad", undefined, "bash")]);
	const protectedPairs = collectPairs(entries(bad), config());
	const tampered = protectedPairs.map((pair) => ({ ...pair, pinnedReason: undefined }));
	const proposal = createProposal(entries(bad), tampered, new Map([[tampered[0].key, { keepCall: 0, keepResult: 0 }]]), config());
	assert.equal(proposal.stats.pinned, 1); assert.deepEqual(proposal.edits, []);
});

test("retained full result always retains its call even when keepCall is low", () => {
	const sm = fixture([user(), assistant([call("conflict")]), result("conflict")]);
	const proposal = propose(sm, config(), { keepCall: 0, keepResult: 1 });
	assert.equal(proposal.stats.kept, 1); assert.equal(proposal.stats.dropped, 0);
	assert.equal(proposal.accepted, false); assert.deepEqual(proposal.edits, []);
});

test("runtime factory only registers handlers/commands; no I/O or model calls", () => {
	const commands = [];
	core.default({ on() {}, registerCommand(name) { commands.push(name); },
		getAllTools() { throw new Error("Runtime tool inventory accessed at load time"); } });
	assert.deepEqual(commands, ["decision-compact"]);
});
test("classifier evidence arguments are detached and in-place pair mutations invalidate captured fingerprints", () => {
	const sm = fixture([user(), assistant([call("mutable")]), result("mutable")]);
	const prepared = prepareRequests(entries(sm), config());
	prepared.requests[0].state.untrustedData.candidates[0].arguments.path = "mutation";
	assert.equal(sm.buildSessionProjection().messages[1].content[0].arguments.path, "src/a.ts");
	prepared.pairs[0].result.content[0].text = "in-place changed output";
	assert.throws(() => createProposal(entries(sm), prepared.pairs, decisions(prepared.pairs), config()), /Stale/);
});
test("superseded system deltas use replayed canonical system estimate", () => {
	const sm = fixture([user(), assistant([call("system-budget")]), result("system-budget")]);
	for (const value of ["a", "b", "c"]) sm.appendMessage({ role: "system", content: "", sections: { preamble: value.repeat(8000) }, timestamp: 4 });
	const projected = entries(sm);
	const proposal = propose(sm, config({ minReductionRatio: .4 }));
	const expected = 2000 + projected.flatMap((entry) => entry.messages).filter((message) => message.role !== "system").reduce((sum, message) => sum + estimateTokens(message), 0);
	assert.equal(proposal.stats.beforeTokens, expected); assert.equal(core.estimateProjectedTokens(projected), expected);
	assert.equal(proposal.accepted, true);
});
console.log(`PASS ${passed} offline deterministic-core test groups`);
