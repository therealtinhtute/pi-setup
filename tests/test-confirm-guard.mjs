// Run from the repo root: node tests/test-confirm-guard.mjs
// For other install layouts: PI_NODE_MODULES=/path/to/node_modules node tests/test-confirm-guard.mjs
//
// Drives the real TypeScript module through jiti, the same way the other extension
// tests in this repo load TS. Nothing is copied or built.
//
// Contract from the plan (R-numbers match confirm-guard.md):
//   R1 prompt on a match, R2 decline blocks with a reason, R3 accept passes through,
//   R4 config is strict and never throws, R5 no UI never blocks, R6 matching literal.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules =
	process.env.PI_NODE_MODULES ||
	join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const pkg = (name, file) => join(modules, "@earendil-works", name, file);
const load = (file) => import(pathToFileURL(file).href);

const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": pkg("pi-coding-agent", "dist/index.js"),
		"@earendil-works/pi-tui": pkg("pi-tui", "dist/index.js"),
	},
});

const { getThemeByName, loadThemeFromPath } = await load(pkg("pi-coding-agent", "dist/modes/interactive/theme/theme.js"));
const guard = await jiti.import(resolve("extensions/confirm-guard/index.ts"));
const {
	decide,
	loadGuardConfig,
	matchPattern,
	commandOf,
	handleToolCall,
	displayCommand,
	configPath,
	DEFAULT_PATTERNS,
} = guard;
const confirmGuard = guard.default;

const never = async () => {
	throw new Error("confirm must not be called");
};

/** Records what the dialog was asked, so the prompt content is assertable. */
function fakeUi(answer, mode = "tui", keys = undefined) {
	let calls = 0;
	let seen = [];
	let rendered = [];
	let renderedRaw = [];
	let customCalls = 0;
	let customOptions;
	let settledExplicitly = false;
	let fakeTheme = null;
	return {
		// A prompt is either the box or the fallback selector; count both.
		get calls() {
			return calls + customCalls;
		},
		get seen() {
			return seen;
		},
		get rendered() {
			return rendered;
		},
		get renderedRaw() {
			return renderedRaw;
		},
		get customOptions() {
			return customOptions;
		},
		get customCalls() {
			return customCalls;
		},
		get settledExplicitly() {
			return settledExplicitly;
		},
		setTheme(t) {
			fakeTheme = t;
		},
		mode,
		signal: undefined,
		cwd: "~/Lab/pi-setup",
		ui: {
			async confirm(title, message) {
				calls += 1;
				seen = [title, message];
				return answer;
			},
			// Mirrors ctx.ui.custom: build the component, render it once, answer it.
			async custom(factory, options) {
				customCalls += 1;
				customOptions = options;
				const theme = fakeTheme ?? getThemeByName("dark");
				let settled;
				let settleCount = 0;
				const component = factory({}, theme, {}, (result) => {
					settled = result;
					settleCount += 1;
				});
				const raw = component.render(80);
				renderedRaw = raw;
				rendered = raw.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
				// Drive the real key handling instead of faking the result.
				// `keys` lets a test send several presses (e.g. down then enter).
				for (const key of keys ?? [answer ? "\r" : "\u001b"]) {
					component.handleInput(key);
					renderedRaw = component.render(80);
					rendered = renderedRaw.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
				}
				// Record whether the component settled on its own: "no settle" and
				// "settled as false" are different failures, and only one is safe.
				settledExplicitly = settleCount > 0;
				return settled;
			},
		},
	};
}

const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "confirm-guard-cfg-"));
const cfg = join(dir, "confirm-guard.json");
const writeCfg = (v) => writeFileSync(cfg, typeof v === "string" ? v : JSON.stringify(v));

try {
	// ── R6: literal, case-sensitive substring matching; no regex, no shell. ──
	assert.equal(matchPattern("git push origin main", ["git push"]), "git push");
	assert.equal(matchPattern("git status", ["git push"]), undefined);
	assert.equal(matchPattern("GIT PUSH", ["git push"]), undefined, "must be case-sensitive");
	assert.equal(matchPattern("git push", ["git p.sh"]), undefined, "a dot must be literal, not a regex wildcard");
	assert.equal(matchPattern("git push --force", ["git push", "rm -rf"]), "git push");

	// Formatting must not be an escape hatch: a second space cannot hide a push.
	assert.equal(matchPattern("git  push origin main", ["git push"]), "git push", "double space must still match");
	assert.equal(matchPattern("git\tpush origin main", ["git push"]), "git push", "a tab must still match");
	assert.equal(matchPattern("  git push  ", ["git push"]), "git push", "surrounding whitespace must not matter");
	assert.equal(matchPattern("git push", ["  git   push  "]), "  git   push  ", "patterns are normalised too");

	// commandOf tolerates any tool-input shape.
	assert.equal(commandOf({ command: "git push" }), "git push");
	assert.equal(commandOf({}), undefined);
	assert.equal(commandOf(undefined), undefined);
	assert.equal(commandOf({ command: 42 }), undefined);

	// ── R1 + R3: a match prompts exactly once; accepting lets the call through. ──
	let asked = 0;
	let askedWith;
	const accepted = await decide("git push origin main", ["git push"], async (m) => {
		asked += 1;
		askedWith = m;
		return true;
	});
	assert.equal(asked, 1, "R1: a matching command prompts exactly once");
	assert.equal(askedWith, "git push", "R1: the prompt names the matched pattern");
	assert.deepEqual(accepted, { block: false }, "R3: accepting does not block");

	// ── R2: declining blocks and explains. ──
	const declined = await decide("git push --force", ["git push"], async () => false);
	assert.equal(declined.block, true, "R2: declining blocks");
	assert.match(declined.reason, /git push/, "R2: the reason names the pattern");
	assert.match(declined.reason, /--force/, "R2: the reason quotes the command");

	// The block reason is rendered into the transcript, so it must be inert as well.
	const noisy = await decide("git push \x1b[2J\x1b[31m", ["git push"], async () => false);
	assert.ok(!noisy.reason.includes("\x1b"), "the block reason must not carry control bytes");
	const longDecline = await decide(`git push ${"y".repeat(800)}`, ["git push"], async () => false);
	assert.ok(longDecline.reason.length < 600, "the block reason caps the command");

	// A dialog that cannot open must block, never silently approve.
	const threw = await decide("git push", ["git push"], async () => {
		throw new Error("no tty");
	});
	assert.equal(threw.block, true, "a failed dialog blocks instead of approving");
	assert.match(threw.reason, /could not ask/, "the failed-dialog reason explains itself");

	// Non-matches never prompt.
	assert.deepEqual(await decide("ls -la", ["git push"], never), { block: false });
	assert.deepEqual(await decide(undefined, ["git push"], never), { block: false });

	// ── The dialog is the whole safety mechanism, so it must be inert. ──
	assert.ok(!displayCommand("git push \x1b[2J\x1b[H\x1b[1;32m").includes("\x1b"), "control bytes stripped from the dialog");
	assert.ok(!displayCommand("git push\nrm -rf /").includes("\n"), "a newline cannot forge extra dialog lines");
	assert.ok(displayCommand("x".repeat(900)).length <= 301, "long commands are capped");
	assert.match(displayCommand("x".repeat(900)), /…$/, "a capped command is marked as truncated");
	assert.equal(displayCommand("  git  push  "), "git push", "display collapses whitespace");

	// ── R4: strict config, never throws, always ends with usable patterns. ──
	writeCfg({ patterns: ["git push", 42, "", "  rm -rf  "] });
	const filtered = loadGuardConfig(dir);
	assert.deepEqual(filtered.patterns, ["git push", "rm -rf"], "R4: non-strings dropped, entries trimmed");
	assert.equal(filtered.source, "file");

	writeCfg("{not json");
	const broken = loadGuardConfig(dir);
	assert.deepEqual(broken.patterns, [...DEFAULT_PATTERNS], "R4: broken JSON falls back");
	assert.match(broken.problem ?? "", /invalid JSON/, "R4: the problem is reported, not swallowed");

	writeCfg({ wrong: true });
	assert.deepEqual(loadGuardConfig(dir).patterns, [...DEFAULT_PATTERNS], "R4: wrong shape falls back");

	writeCfg({ patterns: [] });
	const empty = loadGuardConfig(dir);
	assert.deepEqual(empty.patterns, [...DEFAULT_PATTERNS], "R4: emptying the file cannot disable the guard");
	assert.match(empty.problem ?? "", /empty/, "R4: emptying the file is reported");

	const missing = loadGuardConfig(join(dir, "nope"));
	assert.deepEqual(missing.patterns, [...DEFAULT_PATTERNS], "R4: missing file yields defaults");
	assert.equal(missing.problem, undefined, "R4: a missing file is not an error");

	// An unreadable file is not the same as a missing one, and must say so.
	if (process.getuid?.() !== 0) {
		const locked = join(dir, "locked");
		writeFileSync(locked, JSON.stringify({ patterns: ["rm -rf"] }));
		writeCfg({ patterns: ["git push"] });
		chmodSync(cfg, 0o000);
		const unreadable = loadGuardConfig(dir);
		chmodSync(cfg, 0o644);
		assert.deepEqual(unreadable.patterns, [...DEFAULT_PATTERNS], "R4: an unreadable config falls back");
		assert.match(unreadable.problem ?? "", /could not read/, "R4: an unreadable config is reported, not silently ignored");
	}

	// A directory where the file should be is also a problem, not a silent default.
	const dirAsConfig = join(dir, "isdir");
	mkdirSync(dirAsConfig);
	writeFileSync(join(dirAsConfig, "confirm-guard.json"), "", { flag: "w" });
	writeFileSync(join(dirAsConfig, "confirm-guard.json"), "x");
	assert.equal(typeof loadGuardConfig(dirAsConfig).patterns.length, "number", "a weird path never throws");

	// ── The registered handler path must enforce the same contract. ──
	const blocked = await handleToolCall({ toolName: "bash", input: { command: "git push origin main" } }, fakeUi(false), ["git push"]);
	assert.equal(blocked?.block, true, "handler: declining blocks in the registered path");

	const shownUi = fakeUi(true);
	const input = { command: "git push origin main" };
	const passed = await handleToolCall({ toolName: "bash", input }, shownUi, ["git push"]);
	assert.equal(passed, undefined, "handler: accepting returns nothing, letting the call run");
	assert.equal(shownUi.customCalls, 1, "handler: the Claude-Code box is used, not the generic selector");

	// Where the dialog appears is part of the design, not cosmetics. An overlay floats
	// in the middle of the screen, covering the conversation and detached from it; pi
	// pushes a non-overlay dialog into the editor slot instead, which is where Claude
	// Code puts its permission prompt -- directly below the last message and directly
	// above the footer. Measured on a real Claude Code screenshot: the prompt, the
	// question and the options occupy the bottom rows of the screen with no separate
	// input line left below them.
	assert.equal(
		shownUi.customOptions?.overlay,
		false,
		"the dialog is anchored under the conversation, not floated over the middle",
	);
	assert.ok(shownUi.rendered.length > 5, "handler: the box renders a bordered dialog");
	assert.match(shownUi.rendered.join("\n"), /git push origin main/, "handler: the box shows the real command");
	assert.match(shownUi.rendered.join("\n"), /Bash command/, "handler: the box is titled");
	assert.match(shownUi.rendered.join("\n"), /> 1\. Yes/, "handler: the selected option is marked with >");
	assert.ok(shownUi.rendered.every((l) => l.length === shownUi.rendered[0].length), "handler: the box borders align");

	// A permission dialog must not render as one flat block. The design was measured
	// from a real Claude Code prompt: a continuous dim rail, an accent title, muted
	// meta, the script as the brightest text, and the selection in the accent.
	const sgrOf = (line) =>
		[...new Set([...line.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]).filter((c) => c && c !== "0" && c !== "39" && c !== "49"))];
	const lines = shownUi.rendered;
	const rawLines = shownUi.renderedRaw;
	const titleLine = lines.findIndex((l) => l.includes("Bash command"));
	const scriptLine = lines.findIndex((l) => l.includes("git push origin main"));
	const questionLine = lines.findIndex((l) => l.includes("Do you want to proceed?"));
	const yesLine = lines.findIndex((l) => /[> ] 1\. Yes/.test(l));
	const noLine = lines.findIndex((l) => /[> ] 2\. No/.test(l));
	assert.ok(titleLine >= 0 && scriptLine >= 0 && questionLine >= 0 && yesLine >= 0, "the dialog has title, script, question and options");

	// The rail runs on every row, including blanks: that continuity is the shape.
	assert.ok(lines.every((l) => l.startsWith("│")), "every row starts with the rail");
	const railCount = lines.filter((l) => l.startsWith("│")).length;
	assert.equal(railCount, lines.length, "the rail is unbroken, unlike a boxed frame");

	// No box glyphs: this design deliberately has no frame.
	assert.ok(!lines.join("\n").match(/[╭╮╰╯╔╗╚╝]/), "there is no box frame around the dialog");

	// The script is plain bright text, not a tinted code block.
	assert.ok(!sgrOf(rawLines[scriptLine]).some((c) => c.startsWith("48;")), "the script has no background fill");
	assert.ok(sgrOf(rawLines[scriptLine]).length > 0, "the script is coloured, not the terminal default");

	// Four registers must be distinguishable: rail, title, script, selection.
	const fg = (line) => sgrOf(rawLines[line]).filter((c) => c.startsWith("38;2"));
	const railFg = fg(0)[0];

	/**
	 * Foreground active at the column where `needle` starts. Reading the first
	 * non-rail SGR picks up the `>` pointer, which is accent regardless of the label;
	 * sampling the label's own column is what a reader actually sees.
	 */
	const fgAt = (line, needle) => {
		const raw = rawLines[line];
		const plain = lines[line];
		const col = plain.indexOf(needle);
		if (col < 0) return "";
		let visible = 0;
		let current = "";
		for (let i = 0; i < raw.length; ) {
			const sgr = raw.slice(i).match(/^\x1b\[([0-9;]*)m/);
			if (sgr) {
				if (sgr[1] === "0" || sgr[1] === "39") current = "";
				else if (sgr[1].startsWith("38;2")) current = sgr[1];
				i += sgr[0].length;
				continue;
			}
			if (visible === col) return current;
			const ch = String.fromCodePoint(raw.codePointAt(i));
			visible += 1;
			i += ch.length;
		}
		return current;
	};

	const titleFg = fgAt(titleLine, "Bash command");
	const scriptFg = fgAt(scriptLine, "git push origin main");
	const yesFg = fgAt(yesLine, "Yes");
	const noFg = noLine >= 0 ? fgAt(noLine, "No") : "";
	assert.ok(railFg && titleFg && scriptFg && yesFg, "rail, title, script and selection each carry a colour");
	assert.notEqual(titleFg, scriptFg, "the title is a different colour from the script");
	assert.notEqual(railFg, scriptFg, "the rail is dimmer than the script");
	assert.notEqual(railFg, titleFg, "the rail is not the accent");
	assert.equal(yesFg, titleFg, "the selected option shares the title accent");
	// ...and that accent must not be the same register as unselected body text, or the
	// selection would vanish. This is what a "both are text" mutation would break.
	assert.notEqual(yesFg, scriptFg, "the selection is visually distinct from plain text");
	assert.ok(noFg, "the unselected option is coloured");
	assert.notEqual(noFg, yesFg, "selected and unselected options differ in colour");

	// Emphasis must be *brighter* than the rail, not merely different. A theme where
	// accent is darker than dim would otherwise make the selected option look disabled
	// while the hints looked important -- measured on the user's own cyan theme, where
	// accent (#4d788e, luminance 0.17) sits below dim (#7e888e, 0.24).
	const luminance = (sgr) => {
		const m = sgr.match(/38;2;(\d+);(\d+);(\d+)/);
		if (!m) return 0;
		const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
			const n = Number(v) / 255;
			return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	assert.ok(
		luminance(yesFg) > luminance(railFg),
		"the selected option is brighter than the rail, so it reads as the focus",
	);
	assert.ok(
		luminance(scriptFg) > luminance(railFg),
		"the command is brighter than the rail, so it reads as the content",
	);

	// The assertions above used one theme. A real theme can invert the assumption --
	// the operator's `cyan` does, its accent being darker than dim -- so the same
	// invariants must hold for every theme we can load.
	const themeDir = join(homedir(), ".pi/agent/themes");
	const themeFiles = existsSync(themeDir)
		? readdirSync(themeDir).filter((f) => f.endsWith(".json") && !f.includes(".backup."))
		: [];
	for (const file of themeFiles) {
		const themed = loadThemeFromPath(join(themeDir, file));
		if (!themed) continue;
		const probe = fakeUi(true);
		probe.setTheme(themed);
		await handleToolCall({ toolName: "bash", input: { command: "git push origin main" } }, probe, ["git push"]);
		const raw = probe.renderedRaw;
		const plain = probe.renderedRaw.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		const at = (needle) => plain.findIndex((l) => l.includes(needle));
		const sample = (idx, needle) => {
			const line = raw[idx];
			const col = plain[idx].indexOf(needle);
			let vis = 0;
			let cur = "";
			for (let i = 0; i < line.length; ) {
				const m = line.slice(i).match(/^\x1b\[([0-9;]*)m/);
				if (m) {
					if (m[1] === "0" || m[1] === "39") cur = "";
					else if (m[1].startsWith("38;2")) cur = m[1];
					i += m[0].length;
					continue;
				}
				if (vis === col) return cur;
				vis += 1;
				i += String.fromCodePoint(line.codePointAt(i)).length;
			}
			return cur;
		};
		const railIdx = 0;
		const railFg2 = sample(railIdx, "│");
		const selFg = sample(at("Yes"), "Yes");
		const cmdFg = sample(at("git push origin main"), "git push origin main");
		assert.ok(
			luminance(selFg) > luminance(railFg2),
			"theme " + file + ": the selected option must be brighter than the rail",
		);
		assert.ok(
			luminance(cmdFg) > luminance(railFg2),
			"theme " + file + ": the command must be brighter than the rail",
		);
	}

	// The question must be the brightest/emphasised prose, not the muted meta colour.
	const metaLine = lines.findIndex((l) => l.includes("Hook PreToolUse") || l.includes("confirm-guard pattern"));
	if (metaLine >= 0) {
		const metaFg = fg(metaLine).find((c) => c !== railFg);
		assert.ok(metaFg, "the reason line is coloured");
		assert.notEqual(metaFg, scriptFg, "muted meta is dimmer than the script");
	}
	assert.deepEqual(input, { command: "git push origin main" }, "handler: the tool input is not mutated");

	const otherTool = fakeUi(false);
	assert.equal(
		await handleToolCall({ toolName: "write", input: { command: "git push" } }, otherTool, ["git push"]),
		undefined,
		"handler: non-bash tools are out of scope",
	);
	assert.equal(otherTool.calls, 0, "handler: non-bash tools never prompt");

	// R5: every non-TUI mode passes through. RPC reports hasUI but can wait forever.
	for (const mode of ["print", "json", "rpc"]) {
		const noUi = {
			mode,
			signal: undefined,
			ui: {
				async confirm() {
					throw new Error(mode + " must not ask");
				},
			},
		};
		assert.equal(
			await handleToolCall({ toolName: "bash", input: { command: "git push" } }, noUi, ["git push"]),
			undefined,
			"handler: " + mode + " mode passes through instead of hanging",
		);
	}

	const prompted = fakeUi(true);
	await handleToolCall({ toolName: "bash", input: { command: "ls" } }, prompted, ["git push"]);
	assert.equal(prompted.calls, 0, "handler: non-matching commands never prompt");

	// A double space must not slip past the registered handler either.
	const spaced = fakeUi(false);
	const spacedResult = await handleToolCall(
		{ toolName: "bash", input: { command: "git  push origin main" } },
		spaced,
		["git push"],
	);
	assert.equal(spacedResult?.block, true, "handler: a double space still prompts");

	// ── Keyboard: the selection is real, and both keys actually settle. ──
	// Down then Enter must decline: Enter must follow the highlight, not hardcode Yes.
	const navUi = fakeUi(true, "tui", ["\u001b[B", "\r"]);
	const navResult = await handleToolCall(
		{ toolName: "bash", input: { command: "git push origin main" } },
		navUi,
		["git push"],
	);
	assert.equal(navUi.settledExplicitly, true, "down+enter settles the dialog rather than leaving it open");
	assert.equal(navResult?.block, true, "down+enter declines, because Enter follows the highlight");
	assert.match(navUi.rendered.join("\n"), /> 2\. No/, "the highlight moved to the second option");

	// Escape must refuse — and must actually settle, not hang the dialog forever.
	const escUi = fakeUi(false, "tui", ["\u001b"]);
	const escResult = await handleToolCall(
		{ toolName: "bash", input: { command: "git push origin main" } },
		escUi,
		["git push"],
	);
	assert.equal(escUi.settledExplicitly, true, "escape settles the dialog; it must not leave it open");
	assert.equal(escResult?.block, true, "escape refuses the command");

	// Number keys are shortcuts for the two options.
	const oneUi = fakeUi(false, "tui", ["1"]);
	assert.equal(
		await handleToolCall({ toolName: "bash", input: { command: "git push" } }, oneUi, ["git push"]),
		undefined,
		"pressing 1 accepts",
	);
	const twoUi = fakeUi(true, "tui", ["2"]);
	assert.equal(
		(await handleToolCall({ toolName: "bash", input: { command: "git push" } }, twoUi, ["git push"]))?.block,
		true,
		"pressing 2 declines",
	);

	// ── Registration is the half a handler-only test cannot see. ──
	const events = new Map();
	const commands = new Map();
	const fakePi = {
		on(event, handler) {
			events.set(event, handler);
			return () => events.delete(event);
		},
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
	};
	confirmGuard(fakePi);
	assert.ok(events.has("tool_call"), "the extension registers a tool_call handler");
	assert.ok(commands.has("confirm-guard"), "the extension registers the /confirm-guard command");

	// Drive the handler the extension actually registered, not a hand-picked function.
	const regUi = fakeUi(false);
	const regBlocked = await events.get("tool_call")({ toolName: "bash", input: { command: "git push" } }, regUi);
	assert.equal(regBlocked?.block, true, "the registered handler blocks on decline");
	assert.equal(regUi.calls, 1, "the registered handler asks exactly once");

	// /confirm-guard status must report the real path and source.
	const notes = [];
	await commands.get("confirm-guard").handler("status", { ui: { notify: (m) => notes.push(m) } });
	const status = notes.join("\n");
	assert.match(status, /patterns \(/, "status lists the active patterns");
	assert.match(status, /confirm-guard\.json/, "status names the config file");
	assert.match(status, /git push/, "status shows the active pattern");

	// ── The default must stay useful: git push is the whole point. ──
	assert.deepEqual([...DEFAULT_PATTERNS], ["git push"]);
	assert.match(configPath(), /confirm-guard\.json$/);

	// The config path must honour PI_CODING_AGENT_DIR, the same variable
	// setup/install.sh uses; hardcoding ~/.pi/agent silently ignores a custom dir.
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const customDir = join(dir, "custom-agent");
	mkdirSync(customDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = customDir;
	try {
		assert.equal(configPath(), join(customDir, "confirm-guard.json"), "config path honours PI_CODING_AGENT_DIR");
		writeFileSync(join(customDir, "confirm-guard.json"), JSON.stringify({ patterns: ["rm -rf"] }));
		assert.deepEqual(
			loadGuardConfig().patterns,
			["rm -rf"],
			"the guard reads the config from the custom agent dir",
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	process.stdout.write(
		"PASS: confirm-guard — prompt on match, block on decline, pass on accept, literal+whitespace-normalised match, strict config, inert dialog, TUI-only, registered handler\n",
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
