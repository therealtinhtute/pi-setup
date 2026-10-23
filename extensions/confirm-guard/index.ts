// Confirm gate for destructive commands.
//
// The agent runs `bash` freely. Some commands are not worth running by accident —
// `git push` publishes to a remote, and there is no local undo. This extension
// makes `tool_call` ask before those commands execute:
//
//   • patterns live in a JSON file, so adding one is not a code change;
//   • matching is literal substring, case-sensitive — no regex, no shell;
//   • declining blocks the call and hands the model a reason instead of failing
//     silently;
//   • without a UI (`pi -p`, scripts) nothing is blocked, because there is nobody
//     to ask and a hang is worse than a prompt.
//
// Ordering note: another extension's `tool_call` handler can still mutate
// `event.input` after this one runs. This gate reads the command as it exists when
// it is called; it does not attempt to re-verify afterwards.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmWithBox } from "./box.ts";

/** Used when the config file is missing or unusable. */
export const DEFAULT_PATTERNS: readonly string[] = ["git push"];

export const CONFIG_FILE_NAME = "confirm-guard.json";

/** Longest command echoed in a dialog or a block reason. */
const COMMAND_DISPLAY_LIMIT = 300;

export interface GuardConfig {
	patterns: string[];
	/** Where the patterns came from, for the status command. */
	source: "file" | "default";
	/** Set when the file existed but could not be used. */
	problem?: string;
}

export function configPath(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), CONFIG_FILE_NAME);
}

/**
 * Read the guard config. Never throws: a missing file, invalid JSON, or a wrong
 * shape falls back to the default patterns, and the reason is reported so
 * `/confirm-guard status` can show it rather than failing silently.
 */
export function loadGuardConfig(agentDir?: string): GuardConfig {
	const path = configPath(agentDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		// A missing file is the normal case. Anything else (EACCES, EISDIR) must be
		// reported: the operator has to know the defaults are running, not their list.
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return { patterns: [...DEFAULT_PATTERNS], source: "default" };
		}
		return {
			patterns: [...DEFAULT_PATTERNS],
			source: "default",
			problem: `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			patterns: [...DEFAULT_PATTERNS],
			source: "default",
			problem: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const list = (parsed as { patterns?: unknown } | null)?.patterns;
	if (!Array.isArray(list)) {
		return { patterns: [...DEFAULT_PATTERNS], source: "default", problem: "expected { \"patterns\": string[] }" };
	}

	const patterns = list.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
	if (patterns.length === 0) {
		return { patterns: [...DEFAULT_PATTERNS], source: "default", problem: "patterns list was empty" };
	}
	return { patterns, source: "file" };
}

/**
 * Collapse whitespace runs so `git  push` and `git\tpush` cannot slip past a
 * `git push` pattern. Command names never contain whitespace, so this adds no
 * shell semantics — it only removes formatting as an escape hatch.
 */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** First pattern contained in `command`, or undefined. Literal and case-sensitive. */
export function matchPattern(command: string, patterns: readonly string[]): string | undefined {
	const haystack = normalize(command);
	return patterns.find((pattern) => haystack.includes(normalize(pattern)));
}

/**
 * Make a command safe to print. Commands are agent-authored, so they may carry
 * control bytes; since the dialog *is* the safety mechanism, a repaintable dialog
 * would be a bypass.
 */
export function displayCommand(command: string): string {
	const flattened = command.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return flattened.length > COMMAND_DISPLAY_LIMIT
		? `${flattened.slice(0, COMMAND_DISPLAY_LIMIT)}…`
		: flattened;
}

/** Pull the command string out of a bash tool input without trusting its shape. */
export function commandOf(input: unknown): string | undefined {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : undefined;
}

export interface GuardDecision {
	block: boolean;
	reason?: string;
}

/**
 * The one decision path, shared by the handler and the tests so a test cannot pass
 * against code the extension does not actually run. `confirm` is injected: it
 * returns true when the user accepts, and may throw if the dialog cannot open.
 */
export async function decide(
	command: string | undefined,
	patterns: readonly string[],
	confirm: (matched: string) => Promise<boolean>,
): Promise<GuardDecision> {
	if (!command) return { block: false };
	const matched = matchPattern(command, patterns);
	if (!matched) return { block: false };

	const shown = displayCommand(command);
	let accepted: boolean;
	try {
		accepted = await confirm(matched);
	} catch {
		// A dialog that cannot open must not silently approve the command.
		return {
			block: true,
			reason: `Blocked by confirm-guard: could not ask for confirmation about "${matched}".`,
		};
	}

	if (accepted) return { block: false };
	return {
		block: true,
		reason:
			`Blocked by confirm-guard: "${matched}" requires confirmation and was declined.\n` +
			`Command: ${shown}\n` +
			"Do not retry it on your own. Ask the operator what they want instead.",
	};
}

/**
 * The tool_call handler body, exported so tests exercise the same path the extension
 * registers. `hasUI` and the UI are the only host surface it touches.
 */
export async function handleToolCall(
	event: { toolName: string; input: unknown },
	ctx: {
		mode: string;
		signal?: AbortSignal;
		cwd?: string;
		ui: {
			confirm: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean>;
			custom?: Parameters<typeof confirmWithBox>[0]["ui"]["custom"];
		};
	},
	patterns: readonly string[],
): Promise<GuardDecision | undefined> {
	if (event.toolName !== "bash") return;
	// Only the TUI has a human at the keyboard. RPC also reports hasUI, but its
	// confirm waits for a reply that may never come, so pass through there.
	if (ctx.mode !== "tui") return;

	const command = commandOf(event.input);
	// The dialog is drawn by confirm-box; the decision stays in `decide`.
	const decision = await decide(command, patterns, async (matched) =>
		confirmWithBox({ ui: ctx.ui }, {
			pattern: matched,
			command: displayCommand(command ?? ""),
			cwd: ctx.cwd,
			note: "This command matches a confirm-guard pattern.",
		}),
	);
	return decision.block ? decision : undefined;
}

export default function confirmGuard(pi: ExtensionAPI): void {
	let config = loadGuardConfig();

	pi.on("tool_call", async (event, ctx) => handleToolCall(event, ctx, config.patterns));

	// Reload the pattern list without restarting Pi, and show what is active.
	pi.registerCommand("confirm-guard", {
		description: "Show or reload the confirm-guard patterns (reload | status)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const action = args.trim().toLowerCase();
			if (action === "reload") {
				config = loadGuardConfig();
				ctx.ui.notify(`confirm-guard: ${config.patterns.length} pattern(s) from ${config.source}`, "info");
				return;
			}
			const lines = [`patterns (${config.source}):`, ...config.patterns.map((p) => `  • ${p}`)];
			if (config.problem) lines.push(`config problem: ${config.problem}`);
			lines.push(`file: ${configPath()}`);
			ctx.ui.notify(lines.join("\n"), config.problem ? "warning" : "info");
		},
	});
}
