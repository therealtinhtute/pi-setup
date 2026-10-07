import {
	type ExtensionAPI,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Markdown,
	MouseRegion,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

let activeTheme: Theme | undefined;

export function setActiveTheme(theme: Theme | undefined): void {
	activeTheme = theme;
}

function resolveTheme(): {
	fg: (token: string, text: string) => string;
	bg: (token: string, text: string) => string;
	bold: (text: string) => string;
} {
	if (activeTheme) return activeTheme;
	const globalTheme = (globalThis as any)?.__pi_theme;
	if (globalTheme) return globalTheme;
	return {
		fg: (_token, text) => text,
		bg: (_token, text) => text,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
	if (tokens >= 10000) return `${Math.floor(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

interface SummaryCardConfig {
	titleGlyph: string;
	titleName: string;
	collapsedMeta: string;
	detailHeader: string;
	contentMarkdown: string;
}

function createSummaryCardComponent(
	host: {
		expanded: boolean;
		setExpanded: (v: boolean) => void;
		markdownTheme?: any;
	},
	config: SummaryCardConfig,
): Component {
	const theme = resolveTheme();
	const content = new Container();

	if (!host.expanded) {
		const badge: Component = {
			render(width: number): string[] {
				const title = ` ${config.titleGlyph} ${config.titleName} `;
				const hint = " [▾ expand] ";

				let meta = config.collapsedMeta ? ` ${config.collapsedMeta} ` : "";
				let innerSpace = width - visibleWidth(title) - visibleWidth(meta) - visibleWidth(hint) - 6;
				if (innerSpace < 1 && meta) {
					meta = "";
					innerSpace = width - visibleWidth(title) - visibleWidth(hint) - 6;
				}

				const fill = "─".repeat(Math.max(1, innerSpace));
				const row = theme.fg("syntaxVariable", "──")
					+ theme.bold(theme.fg("customMessageLabel", title))
					+ theme.fg("borderMuted", fill)
					+ (meta ? theme.fg("dim", meta) : "")
					+ theme.fg("muted", hint)
					+ theme.fg("syntaxVariable", "──");

				return [theme.bg("customMessageBg", truncateToWidth(row, Math.max(0, width)))];
			},
			invalidate() {},
		};
		content.addChild(badge);
	} else {
		// Expanded card with title mounted on the top-left border
		const topBorder: Component = {
			render(width: number): string[] {
				const title = ` ${config.titleGlyph} ${config.titleName} `;
				const hint = " [▴ collapse] ";
				const space = Math.max(1, width - visibleWidth(title) - visibleWidth(hint) - 4);
				const row = theme.fg("syntaxVariable", "╭─")
					+ theme.bold(theme.fg("customMessageLabel", title))
					+ theme.fg("syntaxVariable", "─".repeat(space))
					+ theme.fg("muted", hint)
					+ theme.fg("syntaxVariable", "─╮");
				return [truncateToWidth(row, Math.max(0, width))];
			},
			invalidate() {},
		};
		content.addChild(topBorder);

		const metaRow: Component = {
			render(width: number): string[] {
				const text = ` 📦 ${config.detailHeader} `;
				const space = Math.max(0, width - visibleWidth(text) - 2);
				const row = theme.fg("syntaxVariable", "│")
					+ theme.fg("dim", text)
					+ " ".repeat(space)
					+ theme.fg("syntaxVariable", "│");
				return [truncateToWidth(row, Math.max(0, width))];
			},
			invalidate() {},
		};
		content.addChild(metaRow);

		const divider: Component = {
			render(width: number): string[] {
				const fill = "─".repeat(Math.max(0, width - 4));
				const row = theme.fg("syntaxVariable", `├─${fill}─┤`);
				return [truncateToWidth(row, Math.max(0, width))];
			},
			invalidate() {},
		};
		content.addChild(divider);

		const bodyContainer = new Container();
		bodyContainer.addChild(
			new Markdown(config.contentMarkdown, 2, 0, host.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		content.addChild(bodyContainer);

		const bottomBorder: Component = {
			render(width: number): string[] {
				const fill = "─".repeat(Math.max(0, width - 4));
				const row = theme.fg("syntaxVariable", `╰─${fill}─╯`);
				return [truncateToWidth(row, Math.max(0, width))];
			},
			invalidate() {},
		};
		content.addChild(bottomBorder);
	}

	return new MouseRegion(content, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		host.setExpanded(!host.expanded);
		return { handled: true };
	});
}

export function installSummaryCardsHook(): void {
	// 1. Hook CompactionSummaryMessageComponent
	if (CompactionSummaryMessageComponent) {
		const proto = CompactionSummaryMessageComponent.prototype as any;
		if (!proto._summaryCardHookInstalled) {
			proto._summaryCardHookInstalled = true;
			const origUpdateDisplay = (proto._origUpdateDisplay ??= proto.updateDisplay);

			proto.updateDisplay = function (): void {
				this.clear();
				this.paddingY = 0;
				this.paddingX = 0;
				this.setBgFn?.(undefined);

				const message = this.message;
				if (!message) {
					origUpdateDisplay.call(this);
					return;
				}

				const tokensNum = message.tokensBefore ?? 0;
				const tokenStr = formatTokens(tokensNum);
				const config: SummaryCardConfig = {
					titleGlyph: "🗜️",
					titleName: "Context Compaction",
					collapsedMeta: `${tokenStr} tokens · context refreshed`,
					detailHeader: `Compacted from ${tokensNum.toLocaleString()} tokens · context refreshed`,
					contentMarkdown: message.summary ?? "Context compacted successfully.",
				};

				this.addChild(createSummaryCardComponent(this, config));
			};
		}
	}

	// 2. Hook BranchSummaryMessageComponent
	if (BranchSummaryMessageComponent) {
		const proto = BranchSummaryMessageComponent.prototype as any;
		if (!proto._summaryCardHookInstalled) {
			proto._summaryCardHookInstalled = true;
			const origUpdateDisplay = (proto._origUpdateDisplay ??= proto.updateDisplay);

			proto.updateDisplay = function (): void {
				this.clear();
				this.paddingY = 0;
				this.paddingX = 0;
				this.setBgFn?.(undefined);

				const message = this.message;
				if (!message) {
					origUpdateDisplay.call(this);
					return;
				}

				const fromIdStr = message.fromId ? `#${message.fromId.slice(0, 7)}` : "previous turn";
				const config: SummaryCardConfig = {
					titleGlyph: "🌿",
					titleName: "Branch Handoff",
					collapsedMeta: `Navigated from ${fromIdStr} · summary preserved`,
					detailHeader: `Navigated from ${fromIdStr} · summary preserved`,
					contentMarkdown: message.summary ?? "Branch summary generated.",
				};

				this.addChild(createSummaryCardComponent(this, config));
			};
		}
	}
}

export default function transcriptSummaryCardsExtension(pi: ExtensionAPI): void {
	installSummaryCardsHook();
	pi.on("session_start", (_event, ctx) => {
		setActiveTheme(ctx.ui.theme);
		installSummaryCardsHook();
	});
}
