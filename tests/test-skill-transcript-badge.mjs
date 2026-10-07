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
const { default: extension, setActiveTheme } = await jiti.import(
	process.env.SKILL_BADGE_SOURCE || resolve("extensions/skill-transcript-badge.ts"));
const { getThemeByName, initTheme } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
initTheme();
const { SkillInvocationMessageComponent } = await load(join(agent, "dist/modes/interactive/components/skill-invocation-message.js"));

const plain = stripTerminalSequences;

for (const themeName of ["dark", "light"]) {
	const theme = getThemeByName(themeName);
	setActiveTheme(theme);

	const handlers = new Map();
	extension({
		on: (name, fn) => handlers.set(name, fn),
	});

	// Trigger session_start to set active theme
	handlers.get("session_start")?.({}, { mode: "tui", ui: { theme } });

	const sampleLocation = join(homedir(), ".agents", "skills", "think", "SKILL.md");
	const sampleContent = "Turns rough ideas into approved plans before coding.\n\n## Phase 1: Explore\n- Step A\n- Step B";
	const block = {
		name: "think",
		location: sampleLocation,
		content: sampleContent,
		userMessage: "help me plan",
	};

	const component = new SkillInvocationMessageComponent(block);

	// 1. Collapsed state assertions
	assert.equal(component.expanded, false);
	const collapsedLines = component.render(120);
	assert.equal(collapsedLines.length, 1, "collapsed badge renders as exactly one line without empty padding rows");
	assert.equal(component.paddingY, 0, "paddingY is reset to 0 in collapsed state");
	assert.equal(component.paddingX, 0, "paddingX is reset to 0 in collapsed state");

	const collapsedText = plain(collapsedLines[0]);
	assert(!collapsedText.includes("╭─"), "collapsed badge does not have corner bracket ╭─");
	assert(!collapsedText.includes("─╮"), "collapsed badge does not have corner bracket ─╮");
	assert(collapsedText.startsWith("──"), "collapsed badge starts with flat rule ──");
	assert(collapsedText.trimEnd().endsWith("──"), "collapsed badge ends with flat rule ──");
	assert(collapsedLines[0].includes("\u001b[48;2;"), "collapsed badge has subtle customMessageBg background");
	assert(collapsedText.includes("⚡ Skill: 💡 think"), "contains skill name with glyph");
	assert(collapsedText.includes("tokens"), "contains estimated tokens");
	assert(collapsedText.includes("5 lines"), "contains line count");
	assert(collapsedText.includes("~/.agents/skills/think/SKILL.md"), "contains shortened home path");
	assert(collapsedText.includes("[▾ expand]"), "contains expand action hint");

	// Pipeline badge format
	const pipeBlock = { name: "think ➔ work", location: "Pipeline: think ➔ work", content: "Stage 1\nStage 2", userMessage: "test" };
	const pipeComp = new SkillInvocationMessageComponent(pipeBlock);
	const pipeText = plain(pipeComp.render(120)[0]);
	assert(pipeText.includes("⚡ Pipeline: 💡 think ➔ work"), "pipeline badge has pipeline prefix");
	assert(!pipeText.includes("╭─"));
	assert(pipeComp.render(120)[0].includes("\u001b[48;2;"));

	// Responsive truncation at different widths
	for (const width of [120, 80, 50, 30]) {
		const rendered = component.render(width);
		assert.equal(rendered.length, 1);
		assert(visibleWidth(rendered[0]) <= width, `collapsed line fits within width ${width}`);
	}

	// 2. Mouse click toggles to expanded state
	const handledExpand = component.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
	assert(handledExpand?.handled, "click on collapsed badge expands it");
	assert.equal(component.expanded, true, "component is now expanded");

	// 3. Expanded state assertions
	const expandedLines = component.render(120);
	assert(expandedLines.length >= 6, "expanded panel renders header, metadata, separator, body, and footer");

	const topRow = plain(expandedLines[0]);
	assert(topRow.includes("╭─"), "has top-left border curve");
	assert(topRow.includes("⚡ Skill: 💡 think"), "has skill title in header");
	assert(topRow.includes("[▴ collapse]"), "has collapse hint in header");

	const metaRow = plain(expandedLines[1]);
	assert(metaRow.includes("📍 ~/.agents/skills/think/SKILL.md"), "has location metadata");
	assert(metaRow.includes("5 lines"), "has line count metadata");

	const sepRow = plain(expandedLines[2]);
	assert(sepRow.includes("├─"), "has middle divider row");

	const bodyText = expandedLines.slice(3, -1).map(plain).join("\n");
	assert(bodyText.includes("Turns rough ideas into approved plans"), "body renders markdown content");
	assert(bodyText.includes("Phase 1: Explore"), "body renders headings and list items");

	const bottomRow = plain(expandedLines.at(-1));
	assert(bottomRow.includes("╰─"), "has bottom border curve");

	for (const width of [120, 80, 50]) {
		const rendered = component.render(width);
		for (const line of rendered) {
			assert(visibleWidth(line) <= width, `expanded line fits within width ${width}`);
		}
	}

	// 4. Mouse click toggles back to collapsed state
	const handledCollapse = component.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
	assert(handledCollapse?.handled, "click on expanded panel collapses it");
	assert.equal(component.expanded, false, "component is collapsed again");
	assert.equal(component.render(120).length, 1, "collapsed back to 1 line");

	// 5. Programmatic setExpanded (Ctrl+O keybinding support)
	component.setExpanded(true);
	assert.equal(component.expanded, true);
	assert(component.render(120).length >= 6);

	component.setExpanded(false);
	assert.equal(component.expanded, false);
	assert.equal(component.render(120).length, 1);

	// 6. Graceful handling of empty/unusual content
	const minimalBlock = {
		name: "bare",
		location: "/var/tmp/SKILL.md",
		content: "",
		userMessage: undefined,
	};
	const minimalComp = new SkillInvocationMessageComponent(minimalBlock);
	assert.equal(minimalComp.render(80).length, 1);
	assert(plain(minimalComp.render(80)[0]).includes("💡 bare"));

	console.log(`PASS ${themeName}: 1-line collapsed badge, token & line metadata, responsive widths, mouse click toggle, expanded header/meta/body/footer, programmatic setExpanded`);
}
