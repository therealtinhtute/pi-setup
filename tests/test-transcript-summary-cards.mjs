import assert from "node:assert/strict";
import { createJiti } from "/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent":
			"/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
		"@earendil-works/pi-tui":
			"/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-tui/dist/index.js",
	},
});

const {
	initTheme,
	setTheme,
	theme,
} = await import("/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");

const { stripTerminalSequences, visibleWidth } = await import(
	"/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-tui/dist/index.js"
);

const {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
} = await import("/home/tinhpt/.pi/agent/install/releases/1.0.4/node_modules/@earendil-works/pi-coding-agent/dist/index.js");

const { default: extension, setActiveTheme } = await jiti.import(
	"../extensions/transcript-summary-cards.ts",
);

function plain(text) {
	return stripTerminalSequences(text);
}

for (const themeName of ["dark", "light"]) {
	initTheme();
	setTheme(themeName);
	setActiveTheme(theme);
	extension({ on: () => {} });

	// =========================================================================
	// 1. CompactionSummaryMessageComponent Tests
	// =========================================================================
	const compactionMsg = {
		tokensBefore: 168400,
		summary: "Explored and tested transcript UI components.\n\n## Decisions\n- Border-mounted title",
		timestamp: "2026-10-07T12:00:00Z",
	};

	const compComponent = new CompactionSummaryMessageComponent(compactionMsg);

	// A. Collapsed State
	assert.equal(compComponent.expanded, false);
	const compCollapsed = compComponent.render(120);
	assert.equal(compCollapsed.length, 1, "collapsed compaction renders as exactly 1 line");
	assert.equal(compComponent.paddingY, 0, "paddingY is reset to 0 in collapsed state");
	assert.equal(compComponent.paddingX, 0, "paddingX is reset to 0 in collapsed state");

	const compCollapsedText = plain(compCollapsed[0]);
	assert(!compCollapsedText.includes("╭─"), "collapsed badge does not have corner bracket ╭─");
	assert(!compCollapsedText.includes("─╮"), "collapsed badge does not have corner bracket ─╮");
	assert(compCollapsedText.startsWith("──"), "collapsed badge starts with flat rule ──");
	assert(compCollapsedText.trimEnd().endsWith("──"), "collapsed badge ends with flat rule ──");
	assert(compCollapsed[0].includes("\u001b[48;2;"), "collapsed badge has subtle customMessageBg background");
	assert(compCollapsedText.includes("🗜️ Context Compaction"), "contains compaction title with glyph");
	assert(compCollapsedText.includes("168k tokens"), "contains formatted tokens count");
	assert(compCollapsedText.includes("[▾ expand]"), "contains expand action hint");

	// Responsive truncation at different widths
	for (const width of [120, 80, 50, 30]) {
		const rendered = compComponent.render(width);
		assert.equal(rendered.length, 1);
		assert(visibleWidth(rendered[0]) <= width, `collapsed line fits within width ${width}`);
	}

	// B. Mouse Click Toggles to Expanded State
	const handledCompExpand = compComponent.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
	assert.equal(handledCompExpand?.handled, true);
	assert.equal(compComponent.expanded, true);

	// C. Expanded State Assertions
	const compExpanded = compComponent.render(120);
	assert(compExpanded.length >= 5, "expanded card has top border, meta, divider, content, and bottom border");

	const compTopBorder = plain(compExpanded[0]);
	assert(compTopBorder.startsWith("╭─ 🗜️ Context Compaction"), "title is mounted on top-left border");
	assert(compTopBorder.trimEnd().endsWith("[▴ collapse] ─╮"), "collapse hint is mounted on top-right border");

	const compMetaRow = plain(compExpanded[1]);
	assert(compMetaRow.startsWith("│ 📦 Compacted from 168,400 tokens"), "metadata line shows exact token count");
	assert(compMetaRow.trimEnd().endsWith("│"), "metadata line ends with border right │");

	const compDivider = plain(compExpanded[2]);
	assert(compDivider.startsWith("├─"), "divider starts with ├─");
	assert(compDivider.trimEnd().endsWith("─┤"), "divider ends with ─┤");

	const compBottomBorder = plain(compExpanded.at(-1));
	assert(compBottomBorder.startsWith("╰─"), "bottom border starts with ╰─");
	assert(compBottomBorder.trimEnd().endsWith("─╯"), "bottom border ends with ─╯");

	// D. Mouse Click Toggles Back to Collapsed
	const handledCompCollapse = compComponent.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
	assert.equal(handledCompCollapse?.handled, true);
	assert.equal(compComponent.expanded, false);

	// =========================================================================
	// 2. BranchSummaryMessageComponent Tests
	// =========================================================================
	const branchMsg = {
		fromId: "7f3a9b2c8d1e",
		summary: "Branch exploration of custom themes.\n- Verified TrueColor support",
		timestamp: "2026-10-07T13:00:00Z",
	};

	const branchComponent = new BranchSummaryMessageComponent(branchMsg);

	// A. Collapsed State
	assert.equal(branchComponent.expanded, false);
	const branchCollapsed = branchComponent.render(120);
	assert.equal(branchCollapsed.length, 1, "collapsed branch renders as exactly 1 line");

	const branchCollapsedText = plain(branchCollapsed[0]);
	assert(!branchCollapsedText.includes("╭─"), "collapsed branch badge does not have corner bracket ╭─");
	assert(branchCollapsedText.startsWith("──"), "collapsed branch badge starts with flat rule ──");
	assert(branchCollapsedText.trimEnd().endsWith("──"), "collapsed branch badge ends with flat rule ──");
	assert(branchCollapsed[0].includes("\u001b[48;2;"), "collapsed branch badge has subtle background");
	assert(branchCollapsedText.includes("🌿 Branch Handoff"), "contains branch title with glyph");
	assert(branchCollapsedText.includes("#7f3a9b2"), "contains shortened branch commit hash");
	assert(branchCollapsedText.includes("[▾ expand]"), "contains expand action hint");

	// B. Mouse Click Toggles to Expanded State
	const handledBranchExpand = branchComponent.handleMouse({ type: "click", button: "left", x: 2, y: 0 });
	assert.equal(handledBranchExpand?.handled, true);
	assert.equal(branchComponent.expanded, true);

	// C. Expanded State Assertions
	const branchExpanded = branchComponent.render(120);
	assert(branchExpanded.length >= 5);

	const branchTopBorder = plain(branchExpanded[0]);
	assert(branchTopBorder.startsWith("╭─ 🌿 Branch Handoff"), "title is mounted on top-left border");
	assert(branchTopBorder.trimEnd().endsWith("[▴ collapse] ─╮"), "collapse hint is mounted on top-right border");

	const branchMetaRow = plain(branchExpanded[1]);
	assert(branchMetaRow.includes("#7f3a9b2"), "metadata line contains branch id");
	assert(branchMetaRow.trimEnd().endsWith("│"), "metadata line ends with border right │");

	const branchBottomBorder = plain(branchExpanded.at(-1));
	assert(branchBottomBorder.startsWith("╰─"), "bottom border starts with ╰─");
	assert(branchBottomBorder.trimEnd().endsWith("─╯"), "bottom border ends with ─╯");

	// D. Programmatic setExpanded(false)
	branchComponent.setExpanded(false);
	assert.equal(branchComponent.expanded, false);
	assert.equal(branchComponent.render(120).length, 1);

	console.log(`PASS ${themeName}: compaction & branch cards with border-mounted titles, responsive collapse/expand, click toggle`);
}
