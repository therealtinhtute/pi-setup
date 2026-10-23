// Run from the repo root: node tests/test-rewind.mjs
// For other install layouts: PI_NODE_MODULES=/path/to/node_modules node tests/test-rewind.mjs
//
// The planner is pure, so most of this runs with plain objects. The wiring half
// checks that the context hook only rewrites when armed, and that user and
// assistant messages survive untouched.
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { jitiEntry, load, piAliases } from "./lib/pi-modules.mjs";

const { createJiti } = await load(jitiEntry);
const jiti = createJiti(import.meta.url, { alias: piAliases });

const lib = await jiti.import(resolve("extensions/rewind/lib/rewind.ts"));
const { default: rewind } = await jiti.import(resolve("extensions/rewind/index.ts"));

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`  FAIL ${name}\n       ${error.message}`);
	}
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const big = (chars) => "x".repeat(chars);
const toolResult = (toolName, chars, extra = {}) => ({
	role: "toolResult",
	toolCallId: `call-${toolName}`,
	toolName,
	content: [{ type: "text", text: big(chars) }],
	isError: false,
	timestamp: 1,
	...extra,
});
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

// 3 bulky old results, then a tail that must stay intact.
const transcript = () => [
	user("fix the parser"),
	toolResult("read", 9_000),
	assistant("the parser drops the last token"),
	toolResult("bash", 4_000),
	user("try again with the new fixture"),
	toolResult("grep", 2_000),
	assistant("found it"),
	toolResult("read", 8_000), // inside the tail
	assistant("done"),
];

// ── planner ─────────────────────────────────────────────────────────────────
console.log("planner");

test("prunes only tool results before the tail", () => {
	const report = lib.planRewind(transcript(), { keepTail: 4, minResultChars: 1_000 });
	assert.equal(report.changed, true);
	assert.equal(report.pruned, 2, "read and bash are before the cutoff; grep is not");
	assert.deepEqual(report.tools, { read: 1, bash: 1 });

	const kept = report.messages.filter((message) => message.role === "toolResult" && !lib.isStub(message));
	assert.equal(kept.length, 2, "grep and the trailing read stay verbatim");
});

test("stubs keep the tool-call pairing fields", () => {
	const report = lib.planRewind(transcript(), { keepTail: 4, minResultChars: 1_000 });
	const stubbed = report.messages.find((message) => lib.isStub(message));
	assert.equal(stubbed.toolCallId, "call-read");
	assert.equal(stubbed.toolName, "read");
	assert.equal(stubbed.isError, false);
	assert.equal(stubbed.timestamp, 1);
	assert.match(stubbed.content[0].text, /^\[rewound read output · 9,000 chars/);
});

test("user and assistant messages are never touched", () => {
	const input = transcript();
	const report = lib.planRewind(input, { keepTail: 4, minResultChars: 1_000 });
	report.messages.forEach((message, index) => {
		if (message.role === "toolResult") return;
		assert.deepEqual(message, input[index], `message ${index} (${message.role}) changed`);
	});
});

test("small results are left alone", () => {
	const input = [user("q"), toolResult("ls", 200), assistant("a")];
	const report = lib.planRewind(input, { keepTail: 1, minResultChars: 1_000 });
	assert.equal(report.changed, false);
	assert.equal(report.pruned, 0);
});

test("already-stubbed results are not pruned twice", () => {
	const once = lib.planRewind(transcript(), { keepTail: 4, minResultChars: 1_000 });
	const twice = lib.planRewind(once.messages, { keepTail: 4, minResultChars: 1_000 });
	assert.equal(twice.pruned, 0, "second pass finds nothing left to collapse");
	assert.deepEqual(twice.messages, once.messages);
});

test("the input array and its messages are not mutated", () => {
	const input = transcript();
	const snapshot = JSON.stringify(input);
	lib.planRewind(input, { keepTail: 4, minResultChars: 1_000 });
	assert.equal(JSON.stringify(input), snapshot);
});

test("image results report the omitted count", () => {
	const input = [
		user("look"),
		{ role: "toolResult", toolCallId: "c", toolName: "screenshot", isError: false, timestamp: 2,
			content: [{ type: "text", text: big(2_000) }, { type: "image", data: big(5_000), mimeType: "image/png" }] },
		assistant("ok"),
	];
	const report = lib.planRewind(input, { keepTail: 1, minResultChars: 1_000 });
	assert.equal(report.pruned, 1);
	assert.match(report.messages[1].content[0].text, /1 image\(s\)/);
});

console.log("arguments");

test("parseArgs handles the documented forms", () => {
	const base = { keepTail: 8, minResultChars: 1_500 };
	assert.deepEqual(lib.parseArgs("", base), { config: base, action: "arm" });
	assert.deepEqual(lib.parseArgs("off", base), { config: base, action: "off" });
	assert.deepEqual(lib.parseArgs("status", base), { config: base, action: "status" });
	assert.deepEqual(lib.parseArgs("keep 12", base), { config: { ...base, keepTail: 12 }, action: "arm" });
	assert.deepEqual(lib.parseArgs("min 400", base), { config: { ...base, minResultChars: 400 }, action: "arm" });
});

test("parseArgs rejects garbage and bad numbers", () => {
	const base = { keepTail: 8, minResultChars: 1_500 };
	assert.equal(lib.parseArgs("explode", base), undefined);
	assert.equal(lib.parseArgs("keep zero", base), undefined);
	assert.equal(lib.parseArgs("keep 0", base), undefined);
});

// ── extension wiring ────────────────────────────────────────────────────────
console.log("wiring");

function fakePi(branch = []) {
	const handlers = new Map();
	const commands = new Map();
	const entries = [];
	return {
		pi: {
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, []);
				handlers.get(name).push(handler);
				return () => {};
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
			appendEntry(customType, data) {
				entries.push({ type: "custom", customType, data });
			},
		},
		handlers,
		commands,
		entries,
		branch,
	};
}

function fakeCtx(notices, branch = []) {
	return {
		hasUI: true,
		mode: "tui",
		model: { id: "test-model", provider: "test" },
		ui: { notify: (text, type) => notices.push({ text, type }) },
		sessionManager: { getBranch: () => branch },
	};
}

test("context is untouched while rewind is off", async () => {
	const { pi, handlers } = fakePi();
	rewind(pi);
	const context = handlers.get("context")[0];
	assert.equal(await context({ type: "context", messages: transcript() }, fakeCtx([])), undefined);
});

test("/rewind arms the hook, which then rewrites the context", async () => {
	const { pi, handlers, commands, entries } = fakePi();
	rewind(pi);
	const notices = [];
	const ctx = fakeCtx(notices);
	await commands.get("rewind").handler("", ctx);
	assert.match(notices[0].text, /rewind: on/);
	assert.equal(entries[0].customType, "rewind", "state is persisted as a custom entry");
	assert.equal(entries[0].data.armed, true);

	const result = await handlers.get("context")[0]({ type: "context", messages: transcript() }, ctx);
	assert.ok(result?.messages, "hook returns a rewritten message list");
	const stubs = result.messages.filter((message) => lib.isStub(message));
	assert.equal(stubs.length, 1, "default keepTail=8 leaves only the first result prunable");
	assert.ok(notices.some((notice) => /rewind: 1 tool result/.test(notice.text)), "one announcement per session");
});

test("/rewind keep N widens the window", async () => {
	const { pi, handlers, commands } = fakePi();
	rewind(pi);
	const ctx = fakeCtx([]);
	await commands.get("rewind").handler("keep 4 min 1000", ctx);
	const result = await handlers.get("context")[0]({ type: "context", messages: transcript() }, ctx);
	const stubs = result.messages.filter((message) => lib.isStub(message));
	assert.equal(stubs.length, 2);
});

test("/rewind off restores the full context", async () => {
	const { pi, handlers, commands } = fakePi();
	rewind(pi);
	const ctx = fakeCtx([]);
	await commands.get("rewind").handler("keep 4 min 1000", ctx);
	await commands.get("rewind").handler("off", ctx);
	assert.equal(await handlers.get("context")[0]({ type: "context", messages: transcript() }, ctx), undefined);
});

test("a fresh session restores the armed state from the branch", async () => {
	const branch = [
		{ type: "message" },
		{ type: "custom", customType: "rewind", data: { armed: true, config: { keepTail: 4, minResultChars: 1000 } } },
	];
	const { pi, handlers } = fakePi(branch);
	rewind(pi);
	const ctx = fakeCtx([], branch);
	await handlers.get("session_start")[0]({ type: "session_start" }, ctx);
	const result = await handlers.get("context")[0]({ type: "context", messages: transcript() }, ctx);
	assert.equal(result.messages.filter((message) => lib.isStub(message)).length, 2, "restored config is used");
});

test("nothing to prune means no rewrite at all", async () => {
	const { pi, handlers, commands } = fakePi();
	rewind(pi);
	const ctx = fakeCtx([]);
	await commands.get("rewind").handler("min 999999", ctx);
	assert.equal(await handlers.get("context")[0]({ type: "context", messages: transcript() }, ctx), undefined);
});

test("/rewind status reports the configuration", async () => {
	const { pi, commands } = fakePi();
	rewind(pi);
	const notices = [];
	await commands.get("rewind").handler("status", fakeCtx(notices));
	assert.match(notices[0].text, /rewind: off · keep 8 messages · min 1500 chars/);
	assert.match(notices[0].text, /never modified/);
});

console.log(failures === 0 ? "\nrewind: all checks passed" : `\nrewind: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
