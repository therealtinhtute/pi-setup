// Run from the repository root: node tests/test-compact-tools.mjs
// Uses Pi's actual ToolExecutionComponent and mouse dispatch; no model calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const { default: extension } = await jiti.import(process.env.COMPACT_TOOLS_SOURCE || resolve("extensions/compact-tools.ts"));
const { backgroundAnsi, colorToRgb, Container, mixColors, rgbColor, stripTerminalSequences, Text, visibleWidth } = await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { loadThemeFromPath, setTerminalColors, setTheme, setThemeInstance, theme: activeTheme } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
let terminalBackground = rgbColor(40, 44, 52); // Reporter screenshot: #282c34.
setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });
const { withBuiltInRenderers } = await load(join(agent, "dist/core/tools/renderers/index.js"));
const { AssistantMessageComponent } = await load(join(agent, "dist/modes/interactive/components/assistant-message.js"));
const { ToolExecutionComponent } = await load(join(agent, "dist/modes/interactive/components/tool-execution.js"));
const handlers = new Map();
let resolver;
extension({ registerToolRenderer: (fn) => { resolver = fn; }, on: (name, fn) => handlers.set(name, fn) });
let collapsed = 0;
handlers.get("session_start")({}, { mode: "tui", ui: { setToolsExpanded: (value) => { assert.equal(value, false); collapsed++; } } });
for (const mode of ["rpc", "print", "json"]) handlers.get("session_start")({}, { mode, ui: { setToolsExpanded() { assert.fail("non-TUI mutation"); } } });
assert.equal(collapsed, 1);
const plain = stripTerminalSequences;
const nonempty = (component, width = 120) => component.render(width).map(plain).filter((line) => line.trim());
const click = (component) => component.handleMouse({ type: "click", button: "left", x: 1, y: 1,
	width: 120, height: component.render(120).length, shift: false, alt: false, ctrl: false });
const ui = { requestRender() {} };
const panelTint = () => mixColors(activeTheme.colors.toolPendingBg, activeTheme.colors.text, 0.06, "srgb");
const panelBackground = () => backgroundAnsi(mixColors(terminalBackground, panelTint(), 0.3, "srgb"), activeTheme.getColorMode());
// Measure the active background at every printed cell, not just SGR presence.
// The old frame had the tint in its body but reset it before the right/bottom borders.
const backgroundCells = (line) => {
	const cells = [];
	let background = "default", offset = 0;
	const append = (text) => cells.push(...Array(visibleWidth(plain(text))).fill(background));
	for (const match of line.matchAll(/\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
		append(line.slice(offset, match.index));
		if (match[0].startsWith("\x1b[")) {
			const parameters = match[0].slice(2, -1);
			const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 38 || code === 48) {
					const count = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
					if (code === 48) background = `\x1b[${codes.slice(i, i + count).join(";")}m`;
					i += count - 1;
				} else if (code === 0 || code === 49) background = "default";
				else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = `\x1b[${code}m`;
			}
		}
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return cells;
};
// Paired controls prove the verifier catches a gap after an ANSI reset.
assert.deepEqual(backgroundCells("\x1b[48;2;49;51;57m│ \x1b[31mX\x1b[0m│"),
	["\x1b[48;2;49;51;57m", "\x1b[48;2;49;51;57m", "\x1b[48;2;49;51;57m", "default"]);
assert.deepEqual(backgroundCells("\x1b[48;2;49;51;57m│ \x1b[31mX\x1b[0m\x1b[48;2;49;51;57m│"),
	Array(4).fill("\x1b[48;2;49;51;57m"));
const overlineCells = (line) => {
	const cells = [];
	let decorated = false, offset = 0;
	const append = (text) => cells.push(...Array(visibleWidth(plain(text))).fill(decorated));
	for (const match of line.matchAll(/\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
		append(line.slice(offset, match.index));
		if (match[0].startsWith("\x1b[")) {
			const parameters = match[0].slice(2, -1);
			const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 38 || code === 48 || code === 58) {
					i += codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
				} else if (code === 0 || code === 55) decorated = false;
				else if (code === 53) decorated = true;
			}
		}
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return cells;
};
assert.deepEqual(overlineCells("\x1b[53m  \x1b[55m "), [true, true, false]);
assert.deepEqual(overlineCells("\x1b[38;2;53;55;0m \x1b[58;2;53;55;0m "), [false, false],
	"RGB channels must never be interpreted as overline controls");
assert.deepEqual(overlineCells("\x1b[59;53m \x1b[0m "), [true, false], "combined SGR and resets are tracked");
const hasOverline = (component, width = 120) => component.render(width).some((line) => overlineCells(line).includes(true));
const assertFrame = (component, width = 120) => {
	// Decorations on spaces are visible: do not filter rows by stripped text.trim().
	const raw = component.render(width).slice(1);
	const lines = raw.map(plain);
	assert.deepEqual(overlineCells(raw[1]), [false, ...Array(width - 2).fill(true), false],
		"top cap uses native overline on spaces, without font-dependent block or scan-line glyphs");
	assert.equal(lines[1], "▕" + " ".repeat(width - 2) + "▏", "top padding joins correctly oriented side strokes");
	assert.equal(lines.at(-1), " ".repeat(width), "bottom cap is decorated spaces, not thick block glyphs");
	assert.deepEqual(overlineCells(raw.at(-1)), [false, ...Array(width - 2).fill(true), false], "bottom overline spans exactly the interior");
	assert.deepEqual(overlineCells(raw[0]), Array(visibleWidth(lines[0])).fill(false), "heading remains undecorated");
	assert.deepEqual(backgroundCells(raw[0]), Array(visibleWidth(lines[0])).fill("default"), "heading remains unshaded");
	assert(lines.slice(1, -1).every((line) => line.startsWith("▕") && line.endsWith("▏") && visibleWidth(line) === width),
		"content and top padding have aligned edge strokes");
	const background = panelBackground();
	assert(background !== "\x1b[49m", "dim background is explicit even for the system theme");
	assert.deepEqual(backgroundCells(raw.at(-1)), Array(width).fill("default"), "bottom cap does not tint outside the frame");
	for (const [index, line] of raw.slice(1, -1).entries()) {
		assert.deepEqual(backgroundCells(line), ["default", ...Array(width - 2).fill(background), "default"],
			`row ${index}: fill every interior cell, but neither border cell`);
		assert.equal(overlineCells(line)[0], false); assert.equal(overlineCells(line).at(-1), false);
	}
};

const modernDarkPath = join(homedir(), ".pi/agent/git/github.com/mitsuhiko/agent-stuff/themes/modern-dark.json");
const themes = ["dark", "light", "system", ...(existsSync(modernDarkPath) ? ["modern-dark"] : [])];
const selectTheme = (name) => name === "modern-dark" ? setThemeInstance(loadThemeFromPath(modernDarkPath)) : setTheme(name);
for (const theme of themes) {
	selectTheme(theme);
	const base = colorToRgb(terminalBackground), tint = colorToRgb(panelTint());
	const mixed = colorToRgb(mixColors(terminalBackground, panelTint(), 0.3, "srgb"));
	for (const channel of ["r", "g", "b"]) assert(Math.abs(mixed[channel] - base[channel]) <= Math.abs(tint[channel] - base[channel]),
		"30% tint is closer to the actual terminal background than the old opaque surface");
	for (const [name, args] of [
		["read", { path: "sample.ts" }], ["bash", { command: "npm test\necho done" }],
		["write", { path: "sample.ts", content: "HIDDEN WRITE CONTENT\nmore" }],
		["edit", { path: "sample.ts", edits: [{ oldText: "a", newText: "b" }] }],
		["lsp_diagnostics", { path: "sample.ts" }], ["mcp__demo__lookup", { query: "a query" }],
		["web_search", { queries: ["query A", "query B"] }], ["subagent", { task: "Check the code" }],
	]) {
		const result = { content: [{ type: "text", text: "HIDDEN RESULT\nsecond line\nthird line" }],
			details: name === "edit" ? { diff: "-1 a\n+1 HIDDEN EDIT DIFF" } : undefined };
		const expandedText = name === "write" ? "HIDDEN WRITE CONTENT" : name === "edit" ? "HIDDEN EDIT DIFF" : "HIDDEN RESULT";
		const snapshot = JSON.stringify({ args, result });
		const definition = resolver(name, () => withBuiltInRenderers(name));
		const component = new ToolExecutionComponent(name, `test-${name}`, args, { showImages: false }, definition, ui, process.cwd());
		component.markExecutionStarted();
		assert.equal(nonempty(component).length, 1, "pending tool is one line");
		component.updateResult(result, false);
		assert.equal(nonempty(component).length, 1, "completed tool defaults to one line");
		assert(nonempty(component)[0].startsWith(`▸ ${name}`));
		assert(!nonempty(component).join("\n").includes("HIDDEN"));
		assert(click(component)?.handled, "header click must be handled by Pi");
		assert(nonempty(component)[0].startsWith(`▾ ${name}`));
		assert(nonempty(component).join("\n").includes(expandedText), `click reveals the native output for ${name}`);
		assertFrame(component); // Check the screenshot's right/bottom gaps before tiny-width cases.
		for (const width of [0, 1, 4, 5, 10, 20, 40, 80, 120]) {
			assert(component.render(width).every((line) => visibleWidth(line) <= width), `expanded ${name} fits width ${width}`);
			if (width >= 5) assertFrame(component, width);
			else {
				const rendered = component.render(width).slice(1);
				assert.deepEqual(backgroundCells(rendered[0]), Array(visibleWidth(plain(rendered[0]))).fill("default"),
					"tiny-width headings stay unshaded");
				for (const line of rendered.slice(1)) assert.deepEqual(backgroundCells(line), Array(width).fill(panelBackground()),
					"frameless tiny widths still fill every output cell");
			}
		}
		component.updateResult(result, true);
		assertFrame(component);
		assert(nonempty(component)[0].includes("running"), "streaming output remains framed");
		component.updateResult(result, false);
		assert(click(component)?.handled);
		assert.equal(nonempty(component).length, 1, "second click collapses again");
		component.setExpanded(true); // native Ctrl+O path
		assert(nonempty(component).join("\n").includes(expandedText));
		component.setExpanded(false);
		component.updateResult({ ...result, isError: true }, false);
		assert(nonempty(component)[0].includes("error"), "collapsed errors remain visible");
		component.setExpanded(true);
		assertFrame(component);
		component.setExpanded(false);
		for (const width of [0, 1, 10, 20, 40, 80, 120]) {
			assert.equal(component.render(width).filter((line) => plain(line).trim()).length <= 1, true);
			assert(component.render(width).every((line) => visibleWidth(line) <= width));
		}
		assert.equal(JSON.stringify({ args, result }), snapshot, "renderers must not alter model-facing args/results");
	}
	// The native read call is a second heading, not an argument body. Merge its
	// range into the outer heading, while keeping overrides and overflowing args.
	const readTitles = (component) => nonempty(component).filter((line) =>
		/^read\b/.test(line.replace(/^▕\s*/, "").replace(/^▾\s*/, "").trim()));
	for (const [args, detail] of [
		[{ path: "sample.ts" }, "sample.ts"],
		[{ file_path: "alias.ts", offset: 7, limit: 4 }, "alias.ts:7-10"],
		[{ path: "sample.ts", offset: null, limit: null }, "sample.ts"],
		[{ path: "sample.ts", offset: 7 }, "sample.ts:7"],
		[{ path: "ignored.ts", file_path: "actual.ts", limit: 3 }, "actual.ts:1-3"],
	]) {
		const read = new ToolExecutionComponent("read", "dedup", args, { showImages: false },
			resolver("read", () => withBuiltInRenderers("read")), ui, process.cwd());
		read.updateResult({ content: [{ type: "text", text: "UNIQUE READ PAYLOAD" }] }, false);
		read.setExpanded(true);
		assert.equal(readTitles(read).length, 1, "expanded built-in read has exactly one heading (positive dedup guard)");
		assert(nonempty(read)[0].includes(detail), "the single heading preserves the native range and path alias");
		assert(nonempty(read).join("\n").includes("UNIQUE READ PAYLOAD"));
		for (const partial of [true, false]) {
			read.updateResult({ content: [{ type: "text", text: "UNIQUE READ PAYLOAD" }] }, partial);
			read.invalidate();
			assert.equal(readTitles(read).length, 1, "streaming/redraw reuse does not restore the duplicate");
		}
		read.updateResult({ content: [{ type: "text", text: "READ ERROR PAYLOAD" }], isError: true }, false);
		assert.equal(readTitles(read).length, 1, "error transitions retain one heading");
		assert(nonempty(read).join("\n").includes("READ ERROR PAYLOAD"));
		read.setExpanded(false);
		assert.equal(nonempty(read).length, 1);
	}
	const longReadArgs = { path: "模型🙂".repeat(80) + ".ts", offset: 11, limit: 5 };
	const longRead = new ToolExecutionComponent("read", "long-read", longReadArgs, { showImages: false },
		resolver("read", () => withBuiltInRenderers("read")), ui, process.cwd());
	longRead.updateResult({ content: [{ type: "text", text: "UNIQUE READ PAYLOAD" }] }, false);
	longRead.setExpanded(true);
	for (const width of [0, 1, 4, 5, 10, 20, 40, 80, 120]) {
		const rows = longRead.render(width).map(plain);
		assert(rows.every((line) => visibleWidth(line) <= width));
		if (width >= 20) {
			const compact = rows.slice(2).map((line) => line.replace(/^▕\s*/, "").replace(/\s*▏$/, "").trim()).join("");
			assert(compact.includes(`${longReadArgs.path}:11-15`), "overflow metadata keeps the full path/range accessible without another read heading");
		}
	}
	// A same-name override or native-call/custom-result decorator is not ours to strip.
	const nativeRead = withBuiltInRenderers("read");
	for (const override of [
		{ ...nativeRead, renderCall: () => new Text("read PLUGIN ARGS", 0, 0) },
		{ ...nativeRead, renderResult: (...args) => nativeRead.renderResult(...args) },
	]) {
		const decorated = new ToolExecutionComponent("read", "override", { path: "sample.ts" }, { showImages: false },
			resolver("read", () => override), ui, process.cwd());
		decorated.updateResult({ content: [{ type: "text", text: "UNIQUE READ PAYLOAD" }] }, false);
		decorated.setExpanded(true);
		assert.equal(readTitles(decorated).length, 2, "paired positive case: custom read headings remain intact");
		decorated.invalidate();
		assert.equal(readTitles(decorated).length, 2);
	}
	let calls = 0, results = 0, previousCall, previousResult, originalState;
	const custom = {
		renderCall(_args, _theme, ctx) {
			calls++;
			if (calls > 1) assert.equal(ctx.lastComponent, previousCall);
			originalState ??= ctx.state;
			assert.equal(ctx.state, originalState);
			return previousCall = new Text("CUSTOM ARGS", 0, 0);
		},
		renderResult(_result, options, _theme, ctx) {
			results++;
			assert(options.expanded);
			assert.equal(ctx.state, originalState);
			if (results > 1) assert.equal(ctx.lastComponent, previousResult);
			return previousResult = new Text("\x1b[31mCUSTOM OUTPUT\x1b[0m after reset \x1b[44mhighlight\x1b[49m after highlight\n\x1b[38;2;48;49;50mRGB foreground\x1b[48;2;49;50;51mRGB background\x1b[39;49mreset", 0, 0);
		},
	};
	const a = new ToolExecutionComponent("custom", "a", { path: "模型🙂\n\x1b[31mfile" }, { showImages: false }, resolver("custom", () => custom), ui, process.cwd());
	const b = new ToolExecutionComponent("custom", "b", {}, { showImages: false }, resolver("custom", () => custom), ui, process.cwd());
	const result = { content: [{ type: "text", text: "plain fallback" }], details: {} };
	a.updateResult(result, false); b.updateResult(result, false);
	assert.equal(calls, 0); assert.equal(results, 0);
	click(a);
	assert(nonempty(a).join("\n").includes("CUSTOM OUTPUT"));
	assertFrame(a);
	assert(a.render(120).join("\n").includes("\x1b[31m"), "native foreground colors are preserved");
	assert(!a.render(120).join("\n").includes("\x1b[44m"), "native background layers are flattened into one surface");
	assert(a.render(120).join("\n").includes("\x1b[38;2;48;49;50m"), "foreground RGB channels matching SGR codes are preserved");
	assert(!a.render(120).join("\n").includes("\x1b[48;2;49;50;51m"), "RGB background layers are flattened too");
	assert.equal(nonempty(b).length, 1, "click expands only the selected tool");
	a.invalidate();
	assert(calls > 1 && results > 1, "native components/state are reused on redraw");
	for (const width of [0, 1, 10, 20, 40, 80]) assert(b.render(width).every((line) => visibleWidth(line) <= width));
	const broken = { renderCall() { throw Error("renderer failed"); }, renderResult() { throw Error("renderer failed"); } };
	const fallback = new ToolExecutionComponent("broken", "f", { query: "test" }, { showImages: false }, resolver("broken", () => broken), ui, process.cwd());
	fallback.updateResult(result, false); click(fallback);
	assert(nonempty(fallback).join("\n").includes("plain fallback"));
	assertFrame(fallback);
	// Long/wide summaries must reserve a visible top rule even when arguments are truncated.
	const longHeader = new ToolExecutionComponent("custom", "long", { path: "模型🙂".repeat(100) },
		{ showImages: false }, resolver("custom", () => undefined), ui, process.cwd());
	longHeader.setExpanded(true);
	assert.equal(nonempty(longHeader).length, 1);
	assert(!hasOverline(longHeader), "expanded tools without a result have no orphan top border");
	longHeader.updateResult(result, false);
	for (const width of [0, 1, 4, 5, 10, 20, 40, 80, 120]) {
		assert(longHeader.render(width).every((line) => visibleWidth(line) <= width));
		if (width >= 5) assertFrame(longHeader, width);
		else assert(!hasOverline(longHeader, width), "tiny widths drop the frame");
	}
	assert(longHeader.handleMouse({ type: "click", button: "left", x: 118, y: 1, width: 120,
		height: longHeader.render(120).length, shift: false, alt: false, ctrl: false })?.handled,
		"clicking the heading still toggles expansion");
	assert.equal(nonempty(longHeader).length, 1);
	assert(!hasOverline(longHeader), "collapsed headers have no border suffix");
	longHeader.setExpanded(true);
	assertFrame(longHeader);
	longHeader.updateResult(result, true);
	assertFrame(longHeader);
	longHeader.setExpanded(false);
	assert(!hasOverline(longHeader), "streaming collapse clears the top rule");
	// Pi retains a tool's result once received; the next result-less call is a new component.
	const nextPending = new ToolExecutionComponent("custom", "next-pending", {}, { showImages: false },
		resolver("custom", () => undefined), ui, process.cwd());
	nextPending.setExpanded(true);
	assert.equal(nonempty(nextPending).length, 1);
	assert(!hasOverline(nextPending), "panel state cannot leak to the next result-less tool");
	assert(nextPending.render(120).every((line) => !line.includes(panelBackground())),
		"result-less calls keep the terminal background even when expanded");
	let nativeClick;
	const interactive = new ToolExecutionComponent("interactive", "i", {}, { showImages: false }, resolver("interactive", () => ({
		renderResult() {
			return { render: (width) => new Text("CLICKABLE 模型🙂", 0, 0).render(width), invalidate() {},
				handleMouse(event) { nativeClick = event; return { handled: true }; } };
		},
	})), ui, process.cwd());
	interactive.updateResult(result, false); click(interactive);
	assertFrame(interactive);
	const mouse = { type: "click", button: "left", width: 120, height: interactive.render(120).length,
		shift: false, alt: false, ctrl: false, screenX: 13, screenY: 24, x: 3, y: 4 };
	assert(interactive.handleMouse(mouse)?.handled);
	assert.equal(nativeClick.x, 1); assert.equal(nativeClick.y, 0);
	assert.equal(nativeClick.width, 116); assert.equal(nativeClick.height, 1);
	assert.equal(nativeClick.screenX, 13); assert.equal(nativeClick.screenY, 24);
	assert(nonempty(interactive)[0].startsWith("▾"), "native interactive content does not collapse the tool");
	assert(interactive.handleMouse({ ...mouse, x: 0, y: 2 })?.handled, "border click still reaches Pi's collapse handler");
	assert.equal(nonempty(interactive).length, 1, "collapsed tools have no frame");
	assert(interactive.render(120).every((line) => !line.includes(panelBackground())),
		"collapsed tools have no panel background");
	setTheme(theme === "light" ? "dark" : "light");
	fallback.invalidate();
	assertFrame(fallback);
	selectTheme(theme);
	terminalBackground = rgbColor(55, 61, 72);
	setTerminalColors({ background: { r: 55, g: 61, b: 72 }, foreground: { r: 229, g: 231, b: 235 } });
	fallback.invalidate();
	assertFrame(fallback); // The cached default-color Theme must pick up late terminal replies.
	terminalBackground = rgbColor(40, 44, 52);
	setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });

	// Consecutive collapsed tool calls render back-to-back with zero blank lines.
	const container = new Container();
	const defBash1 = withBuiltInRenderers({ name: "bash" }, resolver("bash", () => ({ renderShell: "self" })));
	const defBash2 = withBuiltInRenderers({ name: "bash" }, resolver("bash", () => ({ renderShell: "self" })));
	const defRead = withBuiltInRenderers({ name: "read" }, resolver("read", () => ({ renderShell: "self" })));
	const t1 = new ToolExecutionComponent("bash", "call-1", { command: "git status" }, {}, defBash1, ui, "/tmp");
	const t2 = new ToolExecutionComponent("bash", "call-2", { command: "git diff" }, {}, defBash2, ui, "/tmp");
	const t3 = new ToolExecutionComponent("read", "call-3", { path: "src/index.ts" }, {}, defRead, ui, "/tmp");
	t1.updateResult({ content: [{ type: "text", text: "clean" }] });
	t2.updateResult({ content: [{ type: "text", text: "no diff" }] });
	t3.updateResult({ content: [{ type: "text", text: "export const x = 1;" }] });
	container.addChild(t1);
	container.addChild(t2);
	container.addChild(t3);

	const denseLines = container.render(120);
	assert.equal(denseLines.length, 4, "first tool call has leading spacer, adjacent tool calls sit on consecutive lines");
	assert.equal(denseLines[0], "");
	assert(plain(denseLines[1]).includes("▸ bash git status"));
	assert(plain(denseLines[2]).includes("▸ bash git diff"));
	assert(plain(denseLines[3]).includes("▸ read src/index.ts"));

	// Mouse click on line 2 (t2) expands it
	assert(container.handleMouse({ type: "click", button: "left", x: 2, y: 2, width: 120, height: 4 })?.handled);
	assert.equal(t2.expanded, true);
	const expLines = container.render(120);
	assert.equal(expLines[0], "");
	assert(plain(expLines[1]).includes("▸ bash git status"));
	assert.equal(expLines[2], "", "expanded tool call has leading spacer for breathing room");
	assert(plain(expLines[3]).includes("▾ bash git diff"));
	assert(expLines.some((line) => line.includes(panelBackground())), "expanded tool call shows framed body");

	// Clicking t2 header again (at y=3) collapses it back to zero spacing
	assert(container.handleMouse({ type: "click", button: "left", x: 2, y: 3, width: 120, height: expLines.length })?.handled);
	assert.equal(t2.expanded, false);
	const collapsedAgain = container.render(120);
	assert.equal(collapsedAgain.length, 4);
	assert(plain(collapsedAgain[2]).includes("▸ bash git diff"));

	// Realistic chat transcript structure where AssistantMessageComponents sit between tool calls.
	const transcript = new Container();
	const a1 = new AssistantMessageComponent({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } }] });
	const a2 = new AssistantMessageComponent({ role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "git diff" } }] });
	const a3 = new AssistantMessageComponent({ role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "read", arguments: { path: "src/index.ts" } }] });
	transcript.addChild(a1);
	transcript.addChild(t1);
	transcript.addChild(a2);
	transcript.addChild(t2);
	transcript.addChild(a3);
	transcript.addChild(t3);

	const transcriptLines = transcript.render(120);
	assert.equal(transcriptLines.length, 4, "intervening empty AssistantMessageComponents do not break adjacent tool call dense packing");
	assert.equal(transcriptLines[0], "");
	assert(plain(transcriptLines[1]).includes("▸ bash git status"));
	assert(plain(transcriptLines[2]).includes("▸ bash git diff"));
	assert(plain(transcriptLines[3]).includes("▸ read src/index.ts"));

	console.log(`PASS ${theme}: one-line calls, interior-only background/30% tint, native overline rules below unshaded heading, native foreground preservation, theme changes, native clicks/Ctrl+O, streaming/errors, widths, unchanged model data`);
}
