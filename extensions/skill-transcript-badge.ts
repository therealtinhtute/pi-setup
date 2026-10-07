import { homedir } from "node:os";
import {
	type ExtensionAPI,
	SkillInvocationMessageComponent,
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
	if (tokens >= 10000) return `${Math.floor(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function shortenPath(location: string): string {
	const home = homedir();
	if (location.startsWith(home)) {
		return `~${location.slice(home.length)}`;
	}
	return location;
}

export function installSkillBadgeHook(): void {
	if (!SkillInvocationMessageComponent) return;
	const proto = SkillInvocationMessageComponent.prototype as any;
	if (proto._skillBadgeHookInstalled) return;
	proto._skillBadgeHookInstalled = true;

	const origUpdateDisplay = (proto._origUpdateDisplay ??= proto.updateDisplay);

	proto.updateDisplay = function (): void {
		this.clear();
		this.paddingY = 0;
		this.paddingX = 0;
		this.setBgFn?.(undefined);

		const theme = resolveTheme();
		const block = this.skillBlock;
		if (!block) {
			origUpdateDisplay.call(this);
			return;
		}

		const name = block.name ?? "unknown";
		const location = block.location ? shortenPath(block.location) : "";
		const linesCount = block.content ? block.content.split("\n").length : 0;
		const estTokens = block.content ? Math.max(1, Math.round(block.content.length / 4)) : 0;
		const tokenStr = formatTokens(estTokens);

		const content = new Container();

		if (!this.expanded) {
			const isPipeline = name.includes("➔") || name.includes("->");
			const prefix = isPipeline ? "⚡ Pipeline: 💡 " : "⚡ Skill: 💡 ";
			const badge: Component = {
				render(width: number): string[] {
					const title = ` ${prefix}${name} `;
					const hint = " [▾ expand] ";

					// Adaptively include metadata based on terminal width
					let meta = ` ${tokenStr} tokens · ${linesCount} lines · ${location} `;
					let innerSpace = width - visibleWidth(title) - visibleWidth(meta) - visibleWidth(hint) - 6;
					if (innerSpace < 1) {
						meta = ` ${tokenStr} tokens · ${location} `;
						innerSpace = width - visibleWidth(title) - visibleWidth(meta) - visibleWidth(hint) - 6;
					}
					if (innerSpace < 1) {
						meta = ` ${tokenStr} tokens `;
						innerSpace = width - visibleWidth(title) - visibleWidth(meta) - visibleWidth(hint) - 6;
					}
					if (innerSpace < 1) {
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
			const header: Component = {
				render(width: number): string[] {
					const title = ` ⚡ Skill: 💡 ${name} `;
					const hint = " [▴ collapse] ";
					const fill = "─".repeat(Math.max(1, width - visibleWidth(title) - visibleWidth(hint) - 4));
					const top = theme.fg("syntaxVariable", "╭─")
						+ theme.bold(theme.fg("customMessageLabel", title))
						+ theme.fg("borderMuted", fill)
						+ theme.fg("muted", hint)
						+ theme.fg("syntaxVariable", "─╮");

					const metaText = `📍 ${location}  ·  📦 ${linesCount} lines (~${tokenStr} tokens)`;
					const metaInner = " ".repeat(Math.max(1, width - visibleWidth(metaText) - 4));
					const metaRow = theme.fg("syntaxVariable", "│ ")
						+ theme.fg("dim", metaText)
						+ metaInner
						+ theme.fg("syntaxVariable", " │");

					const sep = theme.fg("syntaxVariable", "├─")
						+ theme.fg("borderMuted", "─".repeat(Math.max(1, width - 4)))
						+ theme.fg("syntaxVariable", "─┤");

					return [
						truncateToWidth(top, Math.max(0, width)),
						truncateToWidth(metaRow, Math.max(0, width)),
						truncateToWidth(sep, Math.max(0, width)),
					];
				},
				invalidate() {},
			};
			content.addChild(header);

			// Markdown body with customMessageText styling
			const md = new Markdown(block.content ?? "", 2, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			});
			content.addChild(md);

			const footer: Component = {
				render(width: number): string[] {
					const fill = "─".repeat(Math.max(1, width - 4));
					const bottom = theme.fg("syntaxVariable", "╰─")
						+ theme.fg("borderMuted", fill)
						+ theme.fg("syntaxVariable", "─╯");
					return [truncateToWidth(bottom, Math.max(0, width))];
				},
				invalidate() {},
			};
			content.addChild(footer);
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
