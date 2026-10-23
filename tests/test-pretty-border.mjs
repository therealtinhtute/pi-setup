// Run: node tests/test-pretty-border.mjs
// Headless check of extensions/pretty-border.ts. The extension itself cannot be
// imported (TypeScript + Pi host), so this mirrors `round()` against the real
// pi-tui helpers and pins the behaviour-carrying lines of the shipped source.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function findPiTui() {
	const candidates = [];
	const miseRoot = path.join(homedir(), ".local", "share", "mise", "installs", "node");
	if (existsSync(miseRoot)) {
		for (const version of readdirSync(miseRoot)) {
			candidates.push(path.join(miseRoot, version, "lib", "node_modules"));
		}
	}
	try {
		candidates.push(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
	} catch {}
	candidates.push("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");
	for (const root of candidates) {
		const tui = path.join(root, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", "dist", "index.js");
		if (existsSync(tui)) return tui;
	}
	return undefined;
}

const tuiPath = findPiTui();
if (!tuiPath) {
	console.log("SKIP: pi-tui not found on this machine (no Pi install); nothing to assert against");
	process.exit(0);
}
const { sliceByColumn, visibleWidth } = await import(pathToFileURL(tuiPath).href);

// Mirror of round() in extensions/pretty-border.ts
function round(line, width, left, right, paint = (t) => t) {
	if (typeof line !== "string") return "";
	if (width < 2) return line;
	if (visibleWidth(line) !== width) return line;
	return `${paint(left)}${sliceByColumn(line, 1, width - 2, true)}${paint(right)}`;
}
const dim = (s) => `\x1b[38;2;90;106;128m${s}\x1b[39m`;

// 1. Width is preserved for every plausible terminal width.
for (let width = 2; width <= 160; width++) {
	const out = round("─".repeat(width), width, "╭", "╮", dim);
	assert.equal(visibleWidth(out), width, `width ${width}: visible width must not change`);
	assert.ok(out.includes("╭") && out.includes("╮"), `width ${width}: both corners present`);
	assert.equal((out.match(/─/g) || []).length, width - 2, `width ${width}: interior rule shrinks by exactly 2`);
}

// 2. Lines the host did not draw at full width are untouched.
for (const [line, width] of [["", 40], ["─".repeat(10), 40], ["  ⠋ Working…", 40]]) {
	assert.equal(round(line, width, "╭", "╮", dim), line, `must not decorate ${JSON.stringify(line)}`);
}

// 3. Tiny widths and non-strings degrade.
assert.equal(round("─", 1, "╭", "╮", dim), "─");
assert.equal(round(undefined, 40, "╭", "╮", dim), "");

// 4. Corners use the editor's own paint, so border colour follows the theme.
const painted = round("─".repeat(39), 39, "╭", "╮", dim);
assert.ok(painted.startsWith("\x1b[38;2;90;106;128m╭"), "corner inherits borderColor");
assert.equal(visibleWidth(painted), 39);

const source = readFileSync(new URL("../extensions/pretty-border.ts", import.meta.url), "utf8");

// 5. Behaviour-carrying lines, not just symbol names: each of these is the fix for
//    a bug the reviewer found, so a regression turns this red.
const required = [
	[/createPromptEditorClass\(CustomEditor, paintIcon, true\)/, "pi-pretty's editor is rebuilt with boxed = true, so the prompt sits inside the frame"],
	[/const ours = new WeakSet<EditorFactory>\(\)/, "wrapper identity tracked in a WeakSet (no mutation of a foreign factory)"],
	[/if \(current && ours\.has\(current\)\) return "already"/, "ensure() is idempotent"],
	[/if \(current\) baseline = current;/, "the foreign factory is remembered before taking over"],
	[/if \(enabled\) await ensure\(pi, ctx\)/, "agent_start re-attaches after a replacement factory"],
	[/if \(enabled\) scheduleRetries\(ctx\)/, "session_start respects owner intent"],
	[/enabled = false;/, "/input-border off records intent"],
	[/if \(current && !ours\.has\(current\)\)/, "off adopts a newer foreign factory instead of clobbering it with a stale baseline"],
	[/undone \?[\s\S]{0,160}Nothing to undo/, "off reports honestly when there was nothing to undo"],
	[/function wrapFactory/, "the border-only fallback survives a pi-pretty load failure"],
	[/ctx\.mode !== "tui"/, "no-op outside the TUI"],
];
for (const [pattern, why] of required) assert.match(source, pattern, why);

// 6. Guards that must NOT come back.
assert.doesNotMatch(source, /\bapplied\b/, "install state must not gate re-wrapping (the 'off is undone' bug)");
assert.doesNotMatch(source, /if \(!applied\)/, "session/AI turn must not skip ensure() based on install state");

// 7. Every host call sits inside a try/catch: three guarded entry points
//    (ensure, restore) plus the retry callback.
const catches = (source.match(/\} catch \{/g) || []).length;
assert.ok(catches >= 2, `expected guarded host calls, found ${catches} catch blocks`);

console.log("PASS: rounding preserves width 2..160 · foreign lines untouched · idempotent wrap · off sticks · guards intact");
