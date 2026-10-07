import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	loadSkills,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Skill invocation chip above the prompt editor.
 *
 * Mirrors the invocation banner style — a glyph, the skill name, and the live
 * session state — styled with Pi's own theme tokens so it matches the
 * transcript's `[skill]` block instead of inventing a second visual language:
 *
 *     💡 git · check · think +2  |  SWE-2 · max
 *
 * Layout, left to right:
 *
 *   - `💡` in teal (`syntaxVariable`), the invocation marker.
 *   - Skill names in the label colour (`customMessageLabel`), capped with a
 *     `+N` overflow so the strip stays one line.
 *   - A dim `|` separator, then model and thinking level in muted text.
 *
 * Everything sits on the `customMessageBg` surface Pi already uses for the
 * `[skill]` block, so the inline prompt and the transcript read as one idea.
 *
 * This is the public-API companion to `skill-highlight-editor.ts`: it cannot
 * paint inline text, but it replaces no editor and does no ANSI work, so it
 * keeps working regardless of how the editor is implemented.
 *
 * Recognises both invocation forms:
 *
 *   - `/skill:<name>` — the canonical form Pi expands.
 *   - `$<name>`       — the alias the `dollar-skill` extension rewrites.
 */

const WIDGET_KEY = "skill-invoke-chip";
const SKILL_TOKEN = /(?:\/skill:([a-zA-Z0-9-]+)|\$([a-zA-Z0-9-]+))/g;
const CACHE_TTL_MS = 5000;
const DEBOUNCE_MS = 50;
/** Names shown before collapsing the rest into `+N`, to keep the chip one line. */
const MAX_NAMES = 3;
/** The invocation marker. Monochrome and single-width in most terminal fonts. */
const GLYPH = "💡";

/** Every known skill the line invokes, in source order, de-duplicated. */
function invokedNames(text: string, known: Set<string>): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(SKILL_TOKEN)) {
		const name = match[1] ?? match[2];
		if (name && known.has(name.toLowerCase()) && !names.includes(name)) names.push(name);
	}
	return names;
}

/** `SWE-2 · max` — the session state shown after the separator. */
function sessionState(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	try {
		// `getSettings()` lives on the extension API, not the context; it returns the
		// effective settings with project overrides already merged.
		const settings = pi.getSettings();
		const model = ctx.model?.id ?? settings.defaultModel;
		const level = ctx.thinkingLevel ?? settings.defaultThinkingLevel;
		const parts = [model, level].filter((part): part is string => typeof part === "string" && part.length > 0);
		return parts.length > 0 ? parts.join(" · ") : undefined;
	} catch {
		return undefined;
	}
}

function discoverSkillPaths(cwd: string): string[] {
	const paths: string[] = [];
	const userAgents = join(homedir(), ".agents", "skills");
	if (existsSync(userAgents)) paths.push(userAgents);
	let cur = cwd;
	while (true) {
		const proj = join(cur, ".agents", "skills");
		if (proj !== userAgents && existsSync(proj)) paths.push(proj);
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return paths;
}

export default function skillInvokeChip(pi: ExtensionAPI) {
	let known = new Set<string>();
	let loadedAt = 0;

	let active: ExtensionContext | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let lastChip: string | undefined;

	const refresh = (cwd: string): void => {
		try {
			const skillPaths = discoverSkillPaths(cwd);
			const result = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths, includeDefaults: true });
			known = new Set(result.skills.map((skill) => skill.name.toLowerCase()));
			loadedAt = Date.now();
		} catch {
			// Keep the previous set rather than dropping every chip on a transient error.
		}
	};

	/** The rendered chip line, or undefined when nothing is invoked. */
	const chipFor = (names: string[], text: string, ctx: ExtensionContext): string | undefined => {
		if (names.length === 0) return undefined;

		const theme = ctx.ui.theme;
		const shown = names.slice(0, MAX_NAMES);
		const overflow = names.length - shown.length;
		const isPipeline = names.length > 1 && /(?:\$|\/skill:)[a-zA-Z0-9-]+\s*(?:->|➔|=>|\|)\s*(?:\$|\/skill:)/.test(text);
		const separator = isPipeline ? " ➔ " : " · ";
		const label = (isPipeline ? "Pipeline: " : "") + shown.join(separator) + (overflow > 0 ? ` +${overflow}` : "");

		const glyph = theme.fg("syntaxVariable", GLYPH);
		const name = theme.fg("customMessageLabel", label);
		const state = sessionState(pi, ctx);
		const tail = state === undefined
			? ""
			: ` ${theme.fg("dim", "|")} ${theme.fg("muted", state)}`;

		return theme.bg("customMessageBg", `${glyph} ${name}${tail}`);
	};

	const update = (): void => {
		const ctx = active;
		if (!ctx) return;

		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch {
			return;
		}

		if (Date.now() - loadedAt > CACHE_TTL_MS) refresh(ctx.cwd);

		let chip: string | undefined;
		try {
			chip = chipFor(invokedNames(text, known), text, ctx);
		} catch {
			return;
		}

		// Widget writes re-render the transcript, so only touch the widget when
		// the chip actually changed.
		if (chip === lastChip) return;
		lastChip = chip;

		try {
			ctx.ui.setWidget(WIDGET_KEY, chip === undefined ? undefined : [chip], { placement: "aboveEditor" });
		} catch {
			// Never let a cosmetic widget break typing.
		}
	};

	const schedule = (): void => {
		if (pending !== undefined) return;
		pending = setTimeout(() => {
			pending = undefined;
			update();
		}, DEBOUNCE_MS);
	};

	const detach = (): void => {
		if (pending !== undefined) clearTimeout(pending);
		pending = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		active = undefined;
		lastChip = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		// A resumed or forked session fires session_start again; drop the previous
		// listener first so they cannot accumulate.
		detach();
		if (ctx.mode !== "tui") return;

		active = ctx;
		refresh(ctx.cwd);

		// Keystrokes reach this listener before the focused editor consumes them,
		// so the chip is one event behind the newest character; the debounce makes
		// that gap invisible while keeping the render cost off the keystroke path.
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			schedule();
			return undefined;
		});
	});

	// Registered once, not per session: an `input` event covers changes that
	// never pass through the terminal listener (skill commands, restored drafts).
	pi.on("input", () => {
		schedule();
		return { action: "continue" };
	});

	pi.on("session_shutdown", () => {
		detach();
		known.clear();
		loadedAt = 0;
	});
}

/** Exported for tests: the chip must never exceed the terminal width. */
export function chipFits(chip: string, width: number): boolean {
	return visibleWidth(chip) <= width;
}
