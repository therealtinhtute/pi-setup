// Run from the repo root: node tests/test-custom-footer.mjs
// For other install layouts: PI_NODE_MODULES=/path/to/node_modules node tests/test-custom-footer.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(
	install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules",
);
const pkg = (name, file) => join(modules, "@earendil-works", name, file);
const load = (file) => import(pathToFileURL(file).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": pkg("pi-coding-agent", "dist/index.js"),
	"@earendil-works/pi-tui": pkg("pi-tui", "dist/index.js"),
} });
const { default: extension } = await jiti.import(resolve("extensions/custom-footer.ts"));
const { parseColor, visibleWidth } = await load(pkg("pi-tui", "dist/index.js"));
const gray = parseColor("#9e9e9e"), yellow = parseColor("#facc15"), red = parseColor("#f87171");
const contextColor = (percent) => percent >= 75
	? red
	: percent >= 50 ? yellow : gray;
const { getThemeByName } = await load(pkg("pi-coding-agent", "dist/modes/interactive/theme/theme.js"));
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

for (const themeName of ["dark", "light"]) {
	const theme = getThemeByName(themeName);
	const events = new Map();
	const commands = new Map();
	let thinking = "low";
	const pi = {
		on(name, handler) {
			if (!events.has(name)) events.set(name, new Set());
			events.get(name).add(handler);
			return () => events.get(name).delete(handler);
		},
		registerCommand: (name, command) => commands.set(name, command),
		getThinkingLevel: () => thinking,
	};
	extension(pi);
	const emit = async (name, ctx) => {
		for (const handler of [...(events.get(name) ?? [])]) await handler({}, ctx);
	};
	let header, percent = 0, branch = "main", model = { name: "Opus 5.5", id: "opus" };
	let renders = 0, footerCalls = 0;
	let entries = [], leaf = 0, branchReads = 0, sessionId = "test-session";
	let allEntries = [], sessionHeader = null, sessionReads = 0;
	const branchListeners = new Set();
	const ctx = {
		mode: "tui",
		get model() { return model; },
		getContextUsage: () => percent === undefined ? undefined : { percent },
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => String(leaf),
			getBranch: () => { branchReads++; return entries; },
			getEntries: () => { sessionReads++; return allEntries; },
			getHeader: () => sessionHeader,
		},
		ui: {
			setFooter(factory) {
				footerCalls++;
				header?.dispose();
				header = factory?.({ requestRender: () => renders++ }, theme, {
					getGitBranch: () => branch,
					onBranchChange(handler) {
						branchListeners.add(handler);
						return () => branchListeners.delete(handler);
					},
				});
			},
			notify() {},
		},
	};
	await emit("session_start", ctx);
	const text = () => plain(header.render(120)[0]);
	assert.equal(text(), " 👾 Opus 5.5 · low · ──────── 0% · ⌥ main");
	assert(header.render(120)[0].includes(theme.style("👾 Opus 5.5", { fg: parseColor(208), bold: true })));
	assert(header.render(120)[0].includes(theme.style("low", { fg: parseColor(5) })));
	assert(header.render(120)[0].includes(theme.style("──────── 0%", { fg: gray })));
	for (let cells = 0; cells <= 8; cells++) {
		percent = cells * 12.5;
		assert(text().includes("━".repeat(cells) + "─".repeat(8 - cells)));
	}
	for (const [value, cells, display] of [
		[0, 0, "0"], [0.5, 0, "1"], [6.25, 1, "6"], [50, 4, "50"], [60, 5, "60"],
		[69.9, 6, "70"], [70, 6, "70"], [75, 6, "75"], [89.9, 7, "90"],
		[90, 7, "90"], [100, 8, "100"], [-10, 0, "0"], [120, 8, "100"],
		[undefined, 0, "?"], [null, 0, "?"], [NaN, 0, "?"], [Infinity, 0, "?"],
	]) {
		percent = value;
		const bar = "━".repeat(cells) + "─".repeat(8 - cells);
		const clamped = Math.max(0, Math.min(100, value));
		const expected = theme.style(`${bar} ${display}%`, {
			fg: display === "?" ? gray : contextColor(clamped),
		});
		assert(header.render(120)[0].includes(expected), "monochromatic context matches Claude thresholds (<50% gray, >=50% yellow, >=75% red)");
		if (value === 50) assert(header.render(120)[0].includes(theme.style("━━━━──── 50%", { fg: yellow })));
		if (value === 75) assert(header.render(120)[0].includes(theme.style("━━━━━━── 75%", { fg: red })));
		for (const width of [0, 1, 10, 20, 40, 80, 120]) {
			const lines = header.render(width);
			assert.equal(lines.length, 1);
			assert(visibleWidth(lines[0]) <= width, `${themeName}: width ${width}`);
		}
	}
	const assistant = (usage) => ({ type: "message", message: { role: "assistant", usage } });
	for (const [usage, display, color] of [
		[{ input: 100, cacheRead: 0, cacheWrite: 0 }, "0", "dim"],
		[{ input: 999, cacheRead: 1, cacheWrite: 0 }, "0", "error"],
		[{ input: 71, cacheRead: 29, cacheWrite: 0 }, "29", "error"],
		[{ input: 60, cacheRead: 40, cacheWrite: 0 }, "40", "error"],
		[{ input: 25, cacheRead: 50, cacheWrite: 25 }, "50", "error"],
		[{ input: 30, cacheRead: 70, cacheWrite: 0 }, "70", "warning"],
		[{ input: 21, cacheRead: 79, cacheWrite: 0 }, "79", "warning"],
		[{ input: 20, cacheRead: 80, cacheWrite: 0 }, "80", "warning"],
		[{ input: 101, cacheRead: 899, cacheWrite: 0 }, "89", "warning"],
		[{ input: 10, cacheRead: 90, cacheWrite: 0 }, "90", "success"],
		[{ input: 0, cacheRead: 100, cacheWrite: 0 }, "100", "success"],
		[{ input: 1, cacheRead: 2, cacheWrite: 0 }, "66", "error"],
		[undefined, undefined, undefined],
		[{ input: 0, cacheRead: 0, cacheWrite: 0 }, undefined, undefined],
		[{ input: 10, cacheRead: NaN, cacheWrite: 0 }, undefined, undefined],
		[{ input: Infinity, cacheRead: 10, cacheWrite: 0 }, undefined, undefined],
		[{ input: -10, cacheRead: 10, cacheWrite: 0 }, undefined, undefined],
		[{ input: 10, cacheRead: 10 }, undefined, undefined],
	]) {
		// Only the latest assistant on this branch counts, not tools or old hits.
		entries = [assistant({ input: 0, cacheRead: 100, cacheWrite: 0 }), assistant(usage),
			{ type: "message", message: { role: "toolResult" } }];
		leaf++;
		const line = header.render(120)[0];
		if (display === undefined) {
			assert(!plain(line).includes("★"), "unknown usage must hide the whole cache segment");
			assert(!plain(line).includes(" ·  · "));
		} else {
			assert(plain(line).includes(` · ★ ${display}% · ⌥ main`));
			assert(line.includes(theme.fg(color, `★ ${display}%`)));
		}
		const reads = branchReads;
		for (const width of [0, 1, 10, 20, 40, 80, 120]) assert(visibleWidth(header.render(width)[0]) <= width);
		assert.equal(branchReads, reads, "cache usage must not rescan an unchanged branch on redraw");
	}
	entries = [];
	leaf++;
	assert(!text().includes("★"), "switching to an empty branch clears the old cache rate");
	entries = [assistant({ input: 15, cacheRead: 85, cacheWrite: 0 })];
	sessionId = "another-session"; // even the same leaf ID must not reuse the old rate
	assert(text().includes("★ 85%"));
	entries = [];
	header.invalidate();
	assert(!text().includes("★"), "invalidation refreshes usage without a leaf change");
	const realNow = Date.now;
	const now = Date.UTC(2026, 9, 6, 12);
	try {
		Date.now = () => now;
		for (const [tokens, elapsed, display] of [
			[999, 60000, "999"], [1000, 60000, "1.0k"], [2400, 60000, "2.4k"],
			[9999, 60000, "9.9k"], [10000, 60000, "10k"], [15000, 60000, "15k"],
			[2400, 120000, "1.2k"], [0, 60000, undefined], [1, 120000, undefined],
			[100, 0, undefined], [100, -60000, undefined],
		]) {
			sessionHeader = { timestamp: new Date(now - elapsed).toISOString() };
			allEntries = [assistant({ input: tokens / 2, output: tokens / 2, cacheRead: 999999, cacheWrite: 999999 })];
			leaf++;
			const line = header.render(120)[0];
			if (display === undefined) assert(!plain(line).includes("ϟ"));
			else {
				assert(plain(line).includes(` · ϟ ${display} tpm · `));
				assert(line.includes(theme.style("ϟ", { fg: parseColor(11) })));
			}
			const reads = sessionReads;
			for (const width of [0, 1, 10, 20, 40, 80, 120]) assert(visibleWidth(header.render(width)[0]) <= width);
			assert.equal(sessionReads, reads, "TPM totals are cached between redraws");
		}
		sessionHeader = { timestamp: new Date(now - 60000).toISOString() };
		allEntries = [assistant({ input: 600, output: 600 }),
			{ type: "compaction", usage: { input: 500, output: 500 } },
			{ type: "usage", usage: { input: 100, output: 100 } },
			assistant({ input: NaN, output: 10 })];
		leaf++;
		assert(text().includes("ϟ 2.4k tpm"), "session totals include auxiliary usage and skip invalid values");
		entries = [assistant({ input: 15, output: 50, cacheRead: 85, cacheWrite: 0 })];
		leaf++;
		assert(text().includes("ϟ 2.4k tpm · ★ 85% · ⌥ main"));
		for (const width of [0, 1, 10, 20, 40, 80, 120]) assert(visibleWidth(header.render(width)[0]) <= width);
		sessionHeader = { timestamp: "invalid" };
		leaf++;
		assert(!text().includes("ϟ"), "invalid session time hides TPM");
		sessionHeader = null;
		leaf++;
		assert(!text().includes("ϟ"), "missing session time hides TPM");
	} finally {
		Date.now = realNow;
		sessionHeader = null;
		allEntries = [];
		entries = [];
		leaf++;
	}
	thinking = "high";
	await emit("thinking_level_select", ctx);
	assert.equal(renders, 1);
	assert(text().includes(" · high · "));
	assert(header.render(120)[0].includes(theme.style("high", { fg: parseColor(5) })));
	model = { name: "", id: "another-model" };
	await emit("model_select", ctx);
	assert.equal(renders, 2);
	assert(text().includes("👾 another-model"));
	model = undefined;
	assert(text().includes("👾 no model"));
	branch = null;
	assert(!text().includes("⌥"));
	branch = "feature/test";
	for (const handler of branchListeners) handler();
	assert.equal(renders, 3);
	assert(text().endsWith("⌥ feature/test"));
	model = { name: "模型🙂 e\u0301\nmodel", id: "id" };
	branch = "分支🙂";
	assert(!text().includes("\n"));
	for (const width of [0, 1, 10, 20, 40, 80, 120]) assert(visibleWidth(header.render(width)[0]) <= width);

	const old = header;
	await commands.get("builtin-footer").handler("", ctx);
	assert.equal(header, undefined);
	old.dispose(); // cleanup is idempotent
	assert.equal(branchListeners.size, 0);
	assert.equal(events.get("model_select").size, 0);
	assert.equal(events.get("thinking_level_select").size, 0);
	await commands.get("custom-footer").handler("", ctx);
	await commands.get("custom-footer").handler("", ctx);
	assert.equal(branchListeners.size, 1);
	assert.equal(events.get("model_select").size, 1);
	assert.equal(events.get("thinking_level_select").size, 1);
	for (const mode of ["print", "json", "rpc"]) {
		const count = footerCalls;
		const nonTui = { ...ctx, mode };
		await emit("session_start", nonTui);
		await commands.get("custom-footer").handler("", nonTui);
		await commands.get("builtin-footer").handler("", nonTui);
		assert.equal(footerCalls, count);
	}
	header.dispose();
	console.log(`PASS ${themeName}: emoji layout, context/cache colors, TPM calculation/format/hiding, cached redraws, widths, Unicode, live updates, commands, subscriptions, non-TUI guards`);
}
