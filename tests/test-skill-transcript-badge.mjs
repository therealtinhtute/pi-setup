// Run from the repository root: node tests/test-skill-transcript-badge.mjs
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
const { default: extension, setActiveTheme, installSkillBadgeHook } = await jiti.import(
	process.env.SKILL_BADGE_SOURCE || resolve("extensions/skill-transcript-badge.ts"));
const { getThemeByName, initTheme } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
initTheme();
const { SkillInvocationMessageComponent } = await load(join(agent, "dist/modes/interactive/components/skill-invocation-message.js"));

const plain = stripTerminalSequences;
const assertNoFrame = (lines) => assert(!lines.map(plain).join("\n").match(/[─╭╮╰╯├┤│]/), "badge has no frame or divider");
const click = (component, button = "left") => component.handleMouse({
	type: "click", button, x: 2, y: 0, width: 120, height: component.render(120).length,
});

for (const themeName of ["dark", "light"]) {
	const theme = getThemeByName(themeName);
	setActiveTheme(theme);
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn) });
	handlers.get("session_start")?.({}, { mode: "tui", ui: { theme } });

	const block = {
		name: "think",
		location: join(homedir(), ".agents", "skills", "think", "SKILL.md"),
		content: "Turns rough ideas into approved plans before coding.\n\n## Phase 1: Explore\n- Step A\n- Step B",
		userMessage: "help me plan",
	};
	const tokens = Math.round(block.content.length / 4);
	const component = new SkillInvocationMessageComponent(block);

	assert.equal(component.expanded, false);
	const collapsed = component.render(120);
	assert.equal(collapsed.length, 1, "collapsed badge occupies exactly one row");
	assert.equal(component.paddingY, 0);
	assert.equal(component.paddingX, 0);
	assertNoFrame(collapsed);
	assert.equal(plain(collapsed[0]).trimEnd(), `▸ 💡 SKILL  think · ≈${tokens} tokens`);
	assert(!plain(collapsed[0]).includes("SKILL.md"), "location is hidden until expanded");
	assert(!plain(collapsed[0]).includes("lines"), "line count is hidden until expanded");
	assert(collapsed[0].includes(theme.bold(theme.fg("syntaxVariable", "▸ 💡 SKILL"))), "teal invocation label is bold");
	assert(collapsed[0].includes(theme.bold(theme.fg("text", "think"))), "skill name is bold primary text");
	assert(collapsed[0].includes(theme.fg("muted", ` · ≈${tokens} tokens`)), "estimated tokens are muted");
	assert(collapsed[0].includes("\u001b[48;2;"), "header has a theme-native background");

	assert.equal(click(component, "right"), undefined, "right click does not toggle");
	assert.equal(component.expanded, false);
	assert(click(component)?.handled, "left click expands badge");
	assert.equal(component.expanded, true);
	const expanded = component.render(120);
	assertNoFrame(expanded);
	assert.equal(plain(expanded[0]).trimEnd(), `▾ 💡 SKILL  think · ≈${tokens} tokens`);
	assert.equal(plain(expanded[1]).trimEnd(), "  ~/.agents/skills/think/SKILL.md · 5 lines");
	assert(expanded[1].includes(theme.fg("dim", "  ~/.agents/skills/think/SKILL.md · 5 lines")), "location metadata is dim");
	assert.equal(plain(expanded[2]).trim(), "", "one blank row separates metadata from instructions");
	const body = expanded.slice(3).map(plain).join("\n");
	assert(body.includes("  Turns rough ideas into approved plans"), "Markdown content stays indented");
	assert(body.includes("Phase 1: Explore"));
	assert(body.includes("Step A"));

	assert(click(component)?.handled, "left click collapses badge");
	assert.equal(component.expanded, false);
	assert.equal(component.render(120).length, 1);
	component.setExpanded(true);
	assert.equal(component.expanded, true, "native Ctrl+O expansion API is preserved");
	assert(component.render(120).length > 3);
	component.setExpanded(false);
	assert.equal(component.render(120).length, 1);

	// Labels must remain consistent in collapsed AND expanded pipelines.
	for (const name of ["think ➔ work", "think -> work"]) {
		const pipe = new SkillInvocationMessageComponent({ ...block, name, location: `Pipeline: ${name}` });
		assert(plain(pipe.render(120)[0]).startsWith(`▸ 💡 PIPELINE  ${name}`));
		pipe.setExpanded(true);
		assert(plain(pipe.render(120)[0]).startsWith(`▾ 💡 PIPELINE  ${name}`));
		assertNoFrame(pipe.render(120));
	}

	// Narrow terminals drop token metadata before truncating the skill name.
	assert.equal(plain(component.render(20)[0]).trimEnd(), "▸ 💡 SKILL  think");
	for (const unusual of [
		block,
		{ ...block, name: "技能-💡-e\u0301-".repeat(12), location: "/var/tmp/" + "path/".repeat(25) + "SKILL.md" },
		{ ...block, name: "bare", location: "", content: "" },
	]) {
		const responsive = new SkillInvocationMessageComponent(unusual);
		for (const expanded of [false, true]) {
			responsive.setExpanded(expanded);
			for (const width of [1, 2, 3, 4, 8, 20, 30, 50, 80, 120]) {
				const lines = responsive.render(width);
				if (!expanded) assert.equal(lines.length, 1);
				for (const line of lines) assert(visibleWidth(line) <= width, `line fits ${width} columns (${themeName}, expanded=${expanded})`);
			}
		}
	}
	const bare = new SkillInvocationMessageComponent({ ...block, name: "bare", content: "", location: "" });
	assert(plain(bare.render(80)[0]).includes("≈0 tokens"));
	bare.setExpanded(true);
	assert.equal(plain(bare.render(80)[1]).trim(), "0 lines", "missing location has no dangling separator");

	// Theme invalidation refreshes colors without losing expansion state.
	const otherTheme = getThemeByName(themeName === "dark" ? "light" : "dark");
	component.setExpanded(true);
	setActiveTheme(otherTheme);
	component.invalidate();
	assert.equal(component.expanded, true);
	assert(component.render(120)[0].includes(otherTheme.bold(otherTheme.fg("syntaxVariable", "▾ 💡 SKILL"))));
	setActiveTheme(theme);
	component.invalidate();

	console.log(`PASS ${themeName}: compact styled header, borderless expansion, pipelines, narrow/Unicode/empty content, mouse & Ctrl+O, theme invalidation`);
}

// Extension reload should replace a stale hook, not keep the previous renderer.
const proto = SkillInvocationMessageComponent.prototype;
const original = proto._origUpdateDisplay;
proto.updateDisplay = () => { throw new Error("stale renderer survived reload"); };
installSkillBadgeHook();
assert.equal(proto._origUpdateDisplay, original, "reload preserves Pi's original fallback renderer");
const reloaded = new SkillInvocationMessageComponent({ name: "reload", location: "", content: "", userMessage: "" });
assert(plain(reloaded.render(80)[0]).startsWith("▸ 💡 SKILL  reload"));
console.log("PASS reload: stale render hook replaced without stacking patches");
