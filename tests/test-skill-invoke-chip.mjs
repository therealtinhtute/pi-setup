// Run from the repository root:
//   PI_NODE_MODULES=<dir with @earendil-works/* and jiti> node tests/test-skill-invoke-chip.mjs
//
// Drives the chip extension through a fake UI; no model calls, no terminal.
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
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
} });

const { stripTerminalSequences, visibleWidth } =
	await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { default: extension } = await jiti.import(
	process.env.SKILL_CHIP_SOURCE || resolve("extensions/skill-invoke-chip.ts"));

/** Collect every handler the extension registers, keyed by event name. */
function loadExtension(settings = {}) {
	const handlers = new Map();
	extension({
		on: (name, fn) => handlers.set(name, fn),
		getSettings: () => settings,
	});
	assert(handlers.has("session_start"), "registers session_start");
	return handlers;
}

const fg = (token, value) => `\u001b[38;2;1;1;1m${token}\u0000${value}\u001b[39m`;
const bg = (token, value) => `\u001b[48;2;60;50;88m${token}\u0000${value}\u001b[49m`;

/**
 * A fake UI capturing widget writes and editor contents.
 *
 * `ctx.model`, `ctx.thinkingLevel`, and `ctx.getSettings()` drive the session
 * state half of the chip, so the test can vary them independently.
 */
function makeUi(initialText = "", session = {}) {
	const widgets = [];
	let text = initialText;
	const inputListeners = new Set();
	const ui = {
		theme: { fg, bg },
		getEditorText: () => text,
		setWidget: (key, content, options) => widgets.push({ key, content, options }),
		onTerminalInput: (listener) => {
			inputListeners.add(listener);
			return () => inputListeners.delete(listener);
		},
	};
	return {
		widgets,
		get text() { return text; },
		setText(value) { text = value; },
		fireInput(data) { for (const listener of inputListeners) listener(data); },
		ui,
		ctx: {
			mode: "tui",
			cwd: process.cwd(),
			ui,
			model: "model" in session ? session.model : { id: "SWE-2" },
			thinkingLevel: "thinkingLevel" in session ? session.thinkingLevel : "max",
		},
	};
}

const settle = () => new Promise((done) => setTimeout(done, 120));
// The stub theme tags each call with `<token>\u0000` so assertions can see which
// theme token styled what; stripping the escape sequences leaves those tags.
const stripTags = (value) => value.replace(/[a-zA-Z]+\u0000/g, "");
const plainChip = (write) => stripTags(stripTerminalSequences(write.content[0]));

// ---------------------------------------------------------------------------
// Session start installs the listener and writes nothing on its own.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi();
	handlers.get("session_start")({}, harness.ctx);
	assert.equal(harness.widgets.length, 0, "no widget until text is typed");

	let nonTui = 0;
	handlers.get("session_start")({}, {
		mode: "rpc", cwd: process.cwd(),
		ui: { theme: { fg, bg }, getEditorText: () => "", setWidget: () => { nonTui++; }, onTerminalInput: () => () => {} },
	});
	assert.equal(nonTui, 0, "does nothing outside tui mode");
}

// ---------------------------------------------------------------------------
// A known skill renders the full banner: glyph, names, separator, session state.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git cm");
	handlers.get("session_start")({}, harness.ctx);

	harness.fireInput("x");
	await settle();

	assert.equal(harness.widgets.length, 1, "exactly one widget write");
	const [write] = harness.widgets;
	assert.equal(write.key, "skill-invoke-chip", "stable widget key");
	assert.equal(write.options?.placement, "aboveEditor", "renders above the editor");
	assert.equal(plainChip(write), "💡 git | SWE-2 · max", "glyph, name, separator, session state");
	assert(write.content.length, 1, "one line");
	assert(write.content[0].includes("\u001b[48;2;60;50;88m"), "sits on the customMessageBg surface");
	assert(write.content[0].includes("syntaxVariable\u0000💡"), "glyph uses the teal token");
	assert(write.content[0].includes("customMessageLabel\u0000git"), "name uses the label token");
	assert(write.content[0].includes("dim\u0000|"), "separator is dim");
	assert(write.content[0].includes("muted\u0000SWE-2 · max"), "session state is muted");
}

// ---------------------------------------------------------------------------
// The chip tracks the editor: appears, updates, and clears.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("plain text");
	handlers.get("session_start")({}, harness.ctx);

	harness.fireInput("a");
	await settle();
	assert.equal(harness.widgets.length, 0, "plain text shows nothing");

	harness.setText("/skill:git");
	harness.fireInput("b");
	await settle();
	assert.equal(plainChip(harness.widgets.at(-1)), "💡 git | SWE-2 · max", "chip appears");

	harness.setText("/skill:git and /skill:check");
	harness.fireInput("c");
	await settle();
	assert.equal(plainChip(harness.widgets.at(-1)), "💡 git · check | SWE-2 · max", "lists every invoked skill");

	harness.setText("");
	harness.fireInput("d");
	await settle();
	assert.equal(harness.widgets.at(-1).content, undefined, "chip clears when the prompt is emptied");
}

// ---------------------------------------------------------------------------
// Unknown names never produce a chip — no false positives.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:definitely-not-a-real-skill-xyz");
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	assert.equal(harness.widgets.length, 0, "unknown skill name is ignored");
}

// ---------------------------------------------------------------------------
// Redundant renders are suppressed: identical text must not rewrite the widget.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git");
	handlers.get("session_start")({}, harness.ctx);

	harness.fireInput("x");
	await settle();
	const after = harness.widgets.length;
	assert.equal(after, 1, "one write for the first chip");

	for (let i = 0; i < 10; i++) {
		harness.fireInput("y");
		await settle();
	}
	assert.equal(harness.widgets.length, after, "unchanged chip does not re-render the transcript");
}

// ---------------------------------------------------------------------------
// The `$name` alias the dollar-skill extension rewrites is recognised too.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("$git cm");
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	assert.equal(plainChip(harness.widgets.at(-1)), "💡 git | SWE-2 · max", "the $ alias is recognised");
}

// ---------------------------------------------------------------------------
// Session state: model falls back to settings, thinking level is optional.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension({ defaultModel: "gemini-3.8-flash", defaultThinkingLevel: "high" });

	const noModel = makeUi("/skill:git", { model: undefined, thinkingLevel: undefined });
	handlers.get("session_start")({}, noModel.ctx);
	noModel.fireInput("x");
	await settle();
	assert.equal(plainChip(noModel.widgets.at(-1)), "💡 git | gemini-3.8-flash · high",
		"falls back to the configured defaults");

	const noLevel = makeUi("/skill:git", { model: { id: "SWE-2" }, thinkingLevel: undefined });
	loadExtension().get("session_start")({}, noLevel.ctx);
	noLevel.fireInput("x");
	await settle();
	assert.equal(plainChip(noLevel.widgets.at(-1)), "💡 git | SWE-2", "omits a missing thinking level");

	const bare = makeUi("/skill:git", { model: undefined, thinkingLevel: undefined });
	loadExtension().get("session_start")({}, bare.ctx);
	bare.fireInput("x");
	await settle();
	assert.equal(plainChip(bare.widgets.at(-1)), "💡 git", "no separator when no session state is known");
}

// ---------------------------------------------------------------------------
// A throwing getSettings must not break the chip.
// ---------------------------------------------------------------------------
{
	const handlers = new Map();
	extension({
		on: (name, fn) => handlers.set(name, fn),
		getSettings: () => { throw new Error("settings exploded"); },
	});
	const harness = makeUi("/skill:git", { model: undefined, thinkingLevel: undefined });
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	assert.equal(plainChip(harness.widgets.at(-1)), "💡 git", "a throwing getSettings degrades to glyph + name");
}

// ---------------------------------------------------------------------------
// A UI that throws must never break typing.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const listeners = new Set();
	handlers.get("session_start")({}, {
		mode: "tui", cwd: process.cwd(), model: { id: "SWE-2" }, thinkingLevel: "max",
		getSettings: () => ({}),
		ui: {
			theme: { fg, bg },
			getEditorText: () => "/skill:git",
			setWidget: () => { throw new Error("ui exploded"); },
			onTerminalInput: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		},
	});
	for (const listener of listeners) listener("x");
	await settle();
	assert.ok(true, "a throwing UI is swallowed");
}

// ---------------------------------------------------------------------------
// Re-entrant session_start must not stack listeners (resume / fork / new).
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git");
	handlers.get("session_start")({}, harness.ctx);
	handlers.get("session_start")({}, harness.ctx);
	handlers.get("session_start")({}, harness.ctx);

	harness.fireInput("x");
	await settle();
	assert.equal(harness.widgets.length, 1, "three session_starts still yield one widget write");
}

// ---------------------------------------------------------------------------
// Shutdown must detach: later input cannot write a widget.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git");
	handlers.get("session_start")({}, harness.ctx);
	handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" });
	harness.fireInput("x");
	await settle();
	assert.equal(harness.widgets.length, 0, "no widget write after shutdown");
}

// ---------------------------------------------------------------------------
// The chip stays one line when many skills are invoked.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git /skill:check /skill:think /skill:read /skill:write");
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	assert.equal(plainChip(harness.widgets.at(-1)), "💡 git · check · think +2 | SWE-2 · max",
		"collapses the overflow into +N");
	assert.equal(harness.widgets.at(-1).content.length, 1, "exactly one line");
}

// ---------------------------------------------------------------------------
// A non-TUI session_start after a TUI one must tear the old session down.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git");
	handlers.get("session_start")({}, harness.ctx);
	handlers.get("session_start")({}, {
		mode: "print", cwd: process.cwd(),
		ui: { theme: { fg, bg }, getEditorText: () => "", setWidget: () => {}, onTerminalInput: () => () => {} },
	});
	harness.fireInput("x");
	await settle();
	assert.equal(harness.widgets.length, 0, "leaving tui mode detaches the old listener");
}

// ---------------------------------------------------------------------------
// The glyph is what the widget will measure: emoji width must not be assumed.
// Measured on the plain chip, since the stub theme's token tags are not real
// output and would otherwise count toward the width.
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("/skill:git");
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	const chip = plainChip(harness.widgets.at(-1));
	assert.equal(chip, "💡 git | SWE-2 · max", "chip content is exact");
	const width = visibleWidth(chip);
	// "💡" is 2 columns, the rest 18: a terminal that treats the glyph as
	// single-width would report 19, so pin the value the widget will actually get.
	assert.equal(width, 20, `chip renders 20 columns (got ${width})`);
}

// ---------------------------------------------------------------------------
// Pipeline syntax with "->" renders a connected chain: 💡 Pipeline: think ➔ work | SWE-2 · max
// ---------------------------------------------------------------------------
{
	const handlers = loadExtension();
	const harness = makeUi("$think -> $work please fix");
	handlers.get("session_start")({}, harness.ctx);
	harness.fireInput("x");
	await settle();
	const chip = plainChip(harness.widgets.at(-1));
	assert.equal(chip, "💡 Pipeline: think ➔ work | SWE-2 · max", "pipeline chain uses ➔ separator and Pipeline prefix");
}

console.log("PASS skill-invoke-chip: banner layout, tokens, session state, known/unknown, dedupe, $ alias, overflow, leaks, fault tolerance");
