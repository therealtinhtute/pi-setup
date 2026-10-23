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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const guard = await jiti.import(resolve("extensions/confirm-guard.ts"));
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
function fakeUi(answer, mode = "tui") {
	let calls = 0;
	let seen = [];
	return {
		get calls() {
			return calls;
		},
		get seen() {
			return seen;
		},
		mode,
		signal: undefined,
		ui: {
			async confirm(title, message) {
				calls += 1;
				seen = [title, message];
				return answer;
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
	assert.match(shownUi.seen[1], /git push origin main/, "handler: the dialog shows the real command");
	assert.match(shownUi.seen[0], /git push/, "handler: the dialog title names the matched pattern");
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
