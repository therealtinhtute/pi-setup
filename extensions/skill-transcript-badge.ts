import { homedir } from "node:os";
import {
	type ExtensionAPI,
	SkillInvocationMessageComponent,
	type Theme,
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
	if (tokens >= 10000) return `${Math.floor(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function shortenPath(location: string): string {
	const home = homedir();
	if (location.startsWith(`${home}/`) || location === home) {
		return `~${location.slice(home.length)}`;
	}
	return location;
}

export function installSkillBadgeHook(): void {
	if (!SkillInvocationMessageComponent) return;
	const proto = SkillInvocationMessageComponent.prototype as any;
	// Replace the previous hook on /reload, but retain Pi's original fallback.
	const origUpdateDisplay = (proto._origUpdateDisplay ??= proto.updateDisplay);

	proto.updateDisplay = function (): void {
		this.clear();
		this.paddingY = 0;
		this.paddingX = 0;
		this.setBgFn?.(undefined);

		const block = this.skillBlock;
		if (!block) {
			origUpdateDisplay.call(this);
			return;
		}

		const name = block.name ?? "unknown";
		const label = name.includes("➔") || name.includes("->") ? "PIPELINE" : "SKILL";
		const location = block.location ? shortenPath(block.location) : "";
		const linesCount = block.content ? block.content.split("\n").length : 0;
		const estTokens = block.content ? Math.max(1, Math.round(block.content.length / 4)) : 0;
		const tokenStr = formatTokens(estTokens);
		const expanded = this.expanded;
		const content = new Container();

		const header: Component = {
			render(width: number): string[] {
				const theme = resolveTheme();
				const marker = `${expanded ? "▾" : "▸"} 💡 ${label}`;
				const title = theme.bold(theme.fg("syntaxVariable", marker))
					+ "  " + theme.bold(theme.fg("text", name));
				// Prefer a readable skill name over metadata on narrow terminals.
				const stats = ` · ≈${tokenStr} tokens`;
				const row = title + (visibleWidth(title + stats) <= width ? theme.fg("muted", stats) : "");
				const clipped = truncateToWidth(row, Math.max(0, width));
				const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
				const headerRow = theme.bg("customMessageBg", clipped + padding);
				if (!expanded) return [headerRow];

				const metadata = `  ${location ? `${location} · ` : ""}${linesCount} lines`;
				return [
					headerRow,
					truncateToWidth(theme.fg("dim", metadata), Math.max(0, width)),
					"",
				];
			},
			invalidate() {},
		};
		content.addChild(header);

		if (expanded) {
			const md = new Markdown(block.content ?? "", 0, 0, this.markdownTheme, {
				color: (text: string) => resolveTheme().fg("customMessageText", text),
			});
			// Adapt indentation so even very narrow terminals stay width-safe.
			content.addChild({
				render(width: number): string[] {
					const indent = " ".repeat(Math.min(2, Math.max(0, width - 1)));
					return md.render(Math.max(1, width - indent.length)).map((line) =>
						truncateToWidth(indent + line, Math.max(0, width)),
					);
				},
				invalidate() { md.invalidate(); },
			});
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	};
}

export default function (pi: ExtensionAPI) {
	installSkillBadgeHook();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			activeTheme = ctx.ui.theme;
		}
	});
}
