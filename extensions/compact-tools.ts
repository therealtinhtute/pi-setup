import {
	createReadToolDefinition,
	getLanguageFromPath,
	highlightCode,
	Theme,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { numberlessDiff, renderWithCodeBlockPaint, toolCodeBlock, type ToolRenderContext } from "./code-block.ts";
import { backgroundAnsi, Box, Container, mixColors, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

interface NativeState {
	state: Record<string, unknown>;
	call?: Component;
	result?: Component;
}

const EMPTY: Component = { render: () => [], invalidate() {} };

const builtInRead = createReadToolDefinition("");

function isBuiltInRead(tool: string, def?: { renderCall?: unknown; renderResult?: unknown }): boolean {
	return tool === "read" && def?.renderCall === builtInRead.renderCall && def?.renderResult === builtInRead.renderResult;
}

function readRange(args: Record<string, unknown>): string {
	if (args.offset == null && args.limit == null) return "";
	const start = args.offset != null && !Number.isNaN(Number(args.offset)) ? Number(args.offset) : 1;
	const end = args.limit != null && !Number.isNaN(Number(args.limit)) ? start + Number(args.limit) - 1 : "";
	return `:${start}${end !== "" ? `-${end}` : ""}`;
}

function readOverflow(args: Record<string, unknown>, theme: Theme): Component {
	const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
	const target = `${rawPath}${readRange(args)}`;
	return {
		render(width) {
			if (!target || width >= visibleWidth(target) + 12) return [];
			return new Text(theme.fg("dim", target), 0, 0).render(width);
		},
		invalidate() {},
	};
}

function summary(args: Record<string, unknown>, toolName?: string): string {
	if (toolName === "read") {
		const rawPath = typeof args.file_path === "string" ? args.file_path
			: typeof args.path === "string" ? args.path : "";
		if (rawPath) {
			return (rawPath + readRange(args)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
		}
	}
	for (const key of ["path", "file_path", "command", "query", "url", "task", "claim", "pattern"]) {
		const value = args[key];
		if (typeof value === "string") return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	}
	if (Array.isArray(args.queries)) {
		return args.queries.filter((value) => typeof value === "string").join(" · ")
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	}
	return "";
}

function nativeState(context: ToolRenderContext): NativeState {
	return context.state.compactToolsNative ??= { state: {} };
}

const PANEL_OPACITY = 0.3;
const terminalDefaults = new Map<string, Theme>();

function panelBackground(theme: Theme): string {
	const key = `${theme.appearance}:${theme.getColorMode()}`;
	let defaults = terminalDefaults.get(key);
	if (!defaults) {
		// A public Theme with default tokens resolves Pi's already-reported terminal
		// colors (and its documented fallback). No extra OSC queries or private APIs.
		const foregrounds = Object.fromEntries(
			Object.keys(theme.colors).map((token) => [token, ""]),
		) as ConstructorParameters<typeof Theme>[0];
		defaults = new Theme(foregrounds, {
			selectedBg: "", searchMatchBg: "", userMessageBg: "", customMessageBg: "",
			toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
		}, theme.getColorMode(), { appearance: theme.appearance });
		terminalDefaults.set(key, defaults);
	}
	const tint = mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb");
	return backgroundAnsi(mixColors(defaults.colors.toolPendingBg, tint, PANEL_OPACITY, "srgb"), theme.getColorMode());
}

function paintPanelLine(line: string, background: string, ownedCodeRow?: string): string {
	// A known CodeBlock owns its whole row, including its unpainted border cells.
	// Other native/plugin output still uses the single parent panel background.
	const start = ownedCodeRow ? line.indexOf(ownedCodeRow) : -1;
	if (start >= 0 && ownedCodeRow) {
		return paintPanelLine(line.slice(0, start), background) + "\x1b[49m" + ownedCodeRow + "\x1b[49m"
			+ paintPanelLine(line.slice(start + ownedCodeRow.length), background);
	}
	// Flatten native background layers into this one surface, retaining foreground
	// syntax/diff colors. Parse color parameters so RGB values are not mistaken for SGR codes.
	const text = line.replace(/\x1b\[([\d;]*)m/g, (sequence, parameters: string) => {
		const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
		const kept: number[] = [];
		let restore = false;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 38 || code === 48) {
				const count = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
				if (code === 38) kept.push(...codes.slice(i, i + count));
				else restore = true;
				i += count - 1;
			} else if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) restore = true;
			else { kept.push(code); if (code === 0) restore = true; }
		}
		if (!restore) return sequence;
		return (kept.length ? `\x1b[${kept.join(";")}m` : "") + background;
	});
	return background + text + "\x1b]8;;\x07\x1b[0m" + background + "\x1b[49m";
}

function horizontalRule(width: number, theme: Theme): string {
	// Terminal-native top-edge decoration on spaces: no missing-font glyphs.
	return theme.fg("borderMuted", "\x1b[59;53m" + " ".repeat(width) + "\x1b[55m");
}

function bordered(content: Component, theme: Theme): Component {
	// Edge-aligned strokes meet the filled interior at character-cell boundaries.
	// Border cells remain unshaded so no tint extends outside the frame.
	const safeContent: Component = {
		render: (width) => content.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(0, width))),
		invalidate: () => content.invalidate(),
		handleMouse: (event) => content.handleMouse?.(event),
	};
	const layout = new Box(1, 0);
	layout.addChild(safeContent);
	return {
		render(width) {
			const background = panelBackground(theme);
			if (width < 5) return safeContent.render(width).map((line) =>
				paintPanelLine(line + " ".repeat(Math.max(0, width - visibleWidth(line))), background));
			const rule = horizontalRule(width - 2, theme);
			const top = theme.fg("borderMuted", "▕") + paintPanelLine(rule, background) + theme.fg("borderMuted", "▏");
			const scoped = renderWithCodeBlockPaint(() => layout.render(width - 2));
			const body = scoped.lines.map((line) =>
				theme.fg("borderMuted", "▕") + paintPanelLine(line, background, scoped.ownedRows.get(line.trim())) + theme.fg("borderMuted", "▏"));
			return [top, ...body, " " + rule + " "];
		},
		invalidate() { layout.invalidate(); },
		handleMouse(event) {
			if (event.width < 5) return safeContent.handleMouse?.(event);
			if (event.x < 1 || event.x >= event.width - 1 || event.y < 1 || event.y >= event.height - 1) return;
			return layout.handleMouse({ ...event, x: event.x - 1, y: event.y - 1,
				width: event.width - 2, height: event.height - 2 });
		},
	};
}

// ============================================================================
// Prompt Run & OpenCode State Tracking
// ============================================================================

interface ToolCallEntry {
	id: string;
	name: string;
	args: Record<string, unknown>;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	durationMs?: number;
}

interface PromptRunState {
	id: number;
	startTime: number;
	endTime?: number;
	thoughtCount: number;
	tools: ToolCallEntry[];
	expanded: boolean;
	completed: boolean;
}

const promptRuns = new Map<number, PromptRunState>();
const toolCallToPromptRun = new Map<string, PromptRunState>();
const componentByToolCallId = new Map<string, ToolExecutionComponent>();
let currentActiveRun: PromptRunState | null = null;
let promptRunCounter = 0;
let compactMode: "opencode" | "lines" = (process.env.COMPACT_TOOLS_STYLE as "opencode" | "lines") || "opencode";
let globalTheme: Theme | null = null;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function invalidateLeader(run: PromptRunState | null): void {
	if (!run || run.tools.length === 0) return;
	const leaderId = run.tools[0].id;
	const leaderComp = componentByToolCallId.get(leaderId);
	leaderComp?.invalidate();
}

function renderOpenCodeSummary(run: PromptRunState, theme: Theme, expanded: boolean): string {
	const cmdCount = run.tools.length;
	const thoughtCount = run.thoughtCount;
	const failedCount = run.tools.filter((t) => t.isError).length;
	// Pick the currently active running tool (last one executing)
	const runningTool = [...run.tools].reverse().find((t) => t.isPartial && t.executionStarted);

	const cmdText = cmdCount === 1 ? "1 command" : `${cmdCount} commands`;
	const failedText = failedCount > 0 ? " " + theme.fg("error", `(${failedCount} failed)`) : "";
	const thoughtText = thoughtCount > 0 ? `, ${thoughtCount === 1 ? "1 thought" : `${thoughtCount} thoughts`}` : "";

	if (expanded) {
		return `${theme.fg("dim", "▾")} ${theme.fg("dim", cmdText)}${failedText}${theme.fg("dim", thoughtText)}`;
	}

	if (runningTool) {
		const spinnerChar = SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];
		return `${theme.fg("warning", spinnerChar)} ${theme.fg("dim", cmdText)}${failedText}${theme.fg("dim", thoughtText)} ${theme.fg("dim", "·")} ${theme.fg("accent", runningTool.name)}`;
	}

	return `${theme.fg("dim", "⋮")} ${theme.fg("dim", cmdText)}${failedText}${theme.fg("dim", thoughtText)}`;
}

function processAssistantMessage(message: any, run: PromptRunState | null): void {
	if (!run || message?.role !== "assistant" || !Array.isArray(message.content)) return;
	let thoughts = 0;
	for (let i = 0; i < message.content.length; i++) {
		const part = message.content[i];
		if (part.type === "thinking") {
			thoughts++;
			while (i + 1 < message.content.length && message.content[i + 1].type === "thinking") i++;
		} else if (part.type === "toolCall") {
			toolCallToPromptRun.set(part.id, run);
			let existing = run.tools.find((t) => t.id === part.id);
			if (!existing) {
				existing = { id: part.id, name: part.name, args: part.arguments ?? {} };
				run.tools.push(existing);
			} else {
				existing.args = part.arguments ?? existing.args;
			}
		}
	}
	if (thoughts > 0 && thoughts > run.thoughtCount) {
		run.thoughtCount = thoughts;
	}
	invalidateLeader(run);
}

function reconstructTurnsFromBranch(entries: any[]): void {
	promptRuns.clear();
	toolCallToPromptRun.clear();
	let currentHistoricalRun: PromptRunState | null = null;
	let runIdx = 0;

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "user") {
				currentHistoricalRun = {
					id: ++runIdx,
					startTime: entry.timestamp ?? Date.now(),
					thoughtCount: 0,
					tools: [],
					expanded: false,
					completed: true,
				};
				promptRuns.set(currentHistoricalRun.id, currentHistoricalRun);
			} else if (msg.role === "assistant" && currentHistoricalRun) {
				processAssistantMessage(msg, currentHistoricalRun);
			} else if (msg.role === "toolResult" && currentHistoricalRun) {
				const tool = currentHistoricalRun.tools.find((t) => t.id === msg.toolCallId);
				if (tool) {
					tool.isError = msg.isError === true;
				}
			}
		}
	}
}

// ============================================================================
// Hooks
// ============================================================================

function installUserMessageAccentHook(): void {
	if ((UserMessageComponent as any)?._opencodeAccentHookInstalled) return;
	if (UserMessageComponent) (UserMessageComponent as any)._opencodeAccentHookInstalled = true;

	const origRender = UserMessageComponent?.prototype?.render;
	if (!origRender) return;

	UserMessageComponent.prototype.render = function (width: number): string[] {
		const lines = origRender.call(this, width);
		if (lines.length === 0 || compactMode !== "opencode") return lines;
		const accent = "\x1b[38;2;198;120;221m▌\x1b[39m"; // Magenta accent from OpenCode v2
		return lines.map((line) => {
			const oscPrefixMatch = line.match(/^((?:\x1b\]133;[^\x07]*\x07)+)/);
			const oscPrefix = oscPrefixMatch ? oscPrefixMatch[1] : "";
			let rest = line.slice(oscPrefix.length);
			let replaced = false;
			rest = rest.replace(/^((?:\x1b\[[\d;]*m)*) /, (_m, esc) => {
				replaced = true;
				return esc + accent;
			});
			if (!replaced) rest = accent + rest;
			return oscPrefix + rest;
		});
	};
}

function installSetExpandedHook(): void {
	if ((ToolExecutionComponent as any)?._opencodeSetExpandedHookInstalled) return;
	if (ToolExecutionComponent) (ToolExecutionComponent as any)._opencodeSetExpandedHookInstalled = true;

	const origSetExpanded = ToolExecutionComponent?.prototype?.setExpanded;
	if (!origSetExpanded) return;

	ToolExecutionComponent.prototype.setExpanded = function (expanded: boolean): void {
		origSetExpanded.call(this, expanded);
		const run = toolCallToPromptRun.get((this as any).toolCallId);
		if (compactMode === "opencode" && run && run.tools[0]?.id === (this as any).toolCallId) {
			run.expanded = expanded;
			for (let i = 1; i < run.tools.length; i++) {
				const peer = componentByToolCallId.get(run.tools[i].id);
				if (peer && (peer as any).expanded !== expanded) {
					origSetExpanded.call(peer, expanded);
				}
			}
		}
	};
}

function installToolSpacingHook(): void {
	if ((ToolExecutionComponent as any)?._compactSpacingHookInstalled) return;
	if (ToolExecutionComponent) (ToolExecutionComponent as any)._compactSpacingHookInstalled = true;

	const origRender = ToolExecutionComponent?.prototype?.render;
	const origHandleMouse = ToolExecutionComponent?.prototype?.handleMouse;
	if (!origRender || !origHandleMouse) return;

	Container.prototype.render = function (width: number): string[] {
		let lastVisibleChild: any = null;
		const lines: string[] = [];
		const mouseChildren: Array<{ component: any; height: number }> = [];
		for (const child of this.children) {
			if (child && typeof child === "object") {
				(child as any).parent = this;
				(child as any)._prevVisibleSibling = lastVisibleChild;
			}
			const childLines: string[] = child.render(width);
			mouseChildren.push({ component: child, height: childLines.length });
			for (const line of childLines) {
				lines.push(line);
			}
			if (childLines.length > 0) {
				lastVisibleChild = child;
			}
		}
		(this as any).mouseLayout = { width, children: mouseChildren };
		return lines;
	};

	ToolExecutionComponent.prototype.render = function (width: number): string[] {
		if ((this as any).hideComponent) return [];
		componentByToolCallId.set((this as any).toolCallId, this);

		const run = toolCallToPromptRun.get((this as any).toolCallId);
		const isOpenCode = compactMode === "opencode" && run && run.tools.length > 0;
		const isLeader = isOpenCode && run.tools[0]?.id === (this as any).toolCallId;
		const isPeer = isOpenCode && !isLeader;

		// Peers in OpenCode mode hide completely when collapsed
		if (isPeer && !(this as any).expanded) {
			(this as any).selfRenderHeight = 0;
			(this as any)._hasTopSpacer = false;
			return [];
		}

		if ((this as any).hasRendererDefinition?.() && (this as any).getRenderShell?.() === "self") {
			// If leader and collapsed in OpenCode mode:
			if (isLeader && !(this as any).expanded) {
				const activeTheme = globalTheme ?? (this as any).theme;
				const summaryLine = activeTheme ? renderOpenCodeSummary(run, activeTheme, false) : "⋮ commands";
				const prev = (this as any)._prevVisibleSibling;
				const isPrevCollapsedTool = prev instanceof ToolExecutionComponent && !(prev as any).expanded;
				const hasTopSpacer = !(isPrevCollapsedTool && !(this as any).expanded);
				(this as any)._hasTopSpacer = hasTopSpacer;
				(this as any).selfRenderHeight = 1;
				const line = truncateToWidth(summaryLine, Math.max(0, width));
				return hasTopSpacer ? ["", line] : [line];
			}

			const contentLines = (this as any).selfRenderContainer.render(width);
			(this as any).selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && (this as any).imageComponents.length === 0) return [];

			const prev = (this as any)._prevVisibleSibling;
			const isPrevCollapsedTool = prev instanceof ToolExecutionComponent && !(prev as any).expanded;

			const hasTopSpacer = !(isPrevCollapsedTool && !(this as any).expanded);
			(this as any)._hasTopSpacer = hasTopSpacer;

			const lines: string[] = [];
			// If leader and expanded in OpenCode mode: add the group header
			if (isLeader && (this as any).expanded) {
				const activeTheme = globalTheme ?? (this as any).theme;
				const headerLine = activeTheme ? renderOpenCodeSummary(run, activeTheme, true) : "▾ commands";
				if (hasTopSpacer) lines.push("");
				lines.push(truncateToWidth(headerLine, Math.max(0, width)));
				lines.push("");
				lines.push(...contentLines);
			} else {
				if (contentLines.length > 0) {
					if (hasTopSpacer) lines.push("");
					lines.push(...contentLines);
				}
			}
			for (let i = 0; i < (this as any).imageComponents.length; i++) {
				const spacer = (this as any).imageSpacers[i];
				if (spacer) lines.push(...spacer.render(width));
				const imageComponent = (this as any).imageComponents[i];
				if (imageComponent) lines.push(...imageComponent.render(width));
			}
			return lines;
		}
		return origRender.call(this, width);
	};

	ToolExecutionComponent.prototype.handleMouse = function (event: any): any {
		const run = toolCallToPromptRun.get((this as any).toolCallId);
		const isOpenCode = compactMode === "opencode" && run && run.tools.length > 0;
		const isLeader = isOpenCode && run.tools[0]?.id === (this as any).toolCallId;

		if (isLeader && event.type === "click" && event.button === "left") {
			const offset = (this as any)._hasTopSpacer ? 1 : 0;
			if (event.y === offset) {
				(this as any).setExpanded(!(this as any).expanded);
				return { handled: true };
			}
		}

		if (!(this as any).hasRendererDefinition?.() || (this as any).getRenderShell?.() !== "self") {
			return origHandleMouse.call(this, event);
		}
		const offset = (this as any)._hasTopSpacer ? 1 : 0;
		const headerOffset = isLeader && (this as any).expanded ? 2 : 0;
		const totalOffset = offset + headerOffset;
		if (event.y < totalOffset || event.y >= (this as any).selfRenderHeight + totalOffset) return undefined;
		return (this as any).selfRenderContainer.handleMouse({
			...event,
			y: event.y - totalOffset,
			height: (this as any).selfRenderHeight,
		});
	};
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
	installUserMessageAccentHook();
	installSetExpandedHook();
	installToolSpacingHook();

	pi.registerToolRenderer((toolName, next) => {
		const original = next();
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				globalTheme = theme;
				const marker = context.expanded ? "▾" : "▸";
				const color = context.isError ? "error" : context.isPartial ? "warning" : "success";
				const detail = summary(args as Record<string, unknown>, toolName);
				const status = context.isError ? theme.fg("error", " · error")
					: context.isPartial && context.executionStarted ? theme.fg("dim", " · running") : "";
				const row = `${theme.fg(color, marker)} ${theme.bold(theme.fg("toolTitle", toolName))}${detail ? ` ${theme.fg("dim", detail)}` : ""}${status}`;
				return {
					render: (width) => [truncateToWidth(row, Math.max(0, width))],
					invalidate() {},
				};
			},
			renderResult(result, options, theme, context) {
				globalTheme = theme;
				if (!options.expanded) return EMPTY;
				const native = nativeState(context);
				const args = context.args as Record<string, unknown>;
				const content = new Container();
				let call: Component | undefined;
				try {
					call = original?.renderCall?.(context.args, theme, {
						...context, state: native.state, lastComponent: native.call,
					});
				} catch { /* Fall back to plain arguments if a plugin renderer fails. */ }
				if (!call) call = new Text(theme.fg("dim", JSON.stringify(context.args, null, 2)), 0, 0);
				native.call = call;
				if (toolName === "write" && !context.isError && typeof args.content === "string") {
					const path = args.path ?? args.file_path;
					const language = typeof path === "string" ? getLanguageFromPath(path) : undefined;
					const text = args.content.replace(/\t/g, "   ");
					const body = new Text((language ? highlightCode(text, language) : [theme.fg("toolOutput", text)]).join("\n"), 0, 0);
					// Only use our write body when the code-block extension is active.
					const block = toolCodeBlock(body, args.content, toolName, context, theme);
					content.addChild(block === body ? call : block);
				} else if (toolName === "edit" && typeof result.details?.diff === "string" && !context.isError) {
					// Keep native preview state intact, but show a clean, number-free diff surface.
					const source = numberlessDiff(result.details.diff);
					const lines = source.replace(/\t/g, "   ").split("\n").map((line) =>
						theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line));
					const body = new Text(lines.join("\n"), 0, 0);
					const block = toolCodeBlock(body, source, toolName, context, theme);
					content.addChild(block === body ? call : block);
				} else if (isBuiltInRead(toolName, original)) {
					content.addChild(readOverflow(args, theme));
				} else content.addChild(call);
				let output: Component | undefined;
				try {
					output = original?.renderResult?.(result, options, theme, {
						...context, state: native.state, lastComponent: native.result,
					});
				} catch { /* Keep the tool output accessible even if a plugin renderer fails. */ }
				if (!output) {
					const text = result.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
					output = new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0);
				}
				native.result = output;
				const source = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				content.addChild(["read", "bash"].includes(toolName) && source && !result.content.some((block) => block.type === "image")
					? toolCodeBlock(output, source, toolName, context, theme) : output);
				return bordered(content, theme);
			},
		};
	});

	pi.on("agent_start", () => {
		currentActiveRun = {
			id: ++promptRunCounter,
			startTime: Date.now(),
			thoughtCount: 0,
			tools: [],
			expanded: false,
			completed: false,
		};
		promptRuns.set(currentActiveRun.id, currentActiveRun);
	});

	pi.on("turn_start", () => {
		if (!currentActiveRun) {
			currentActiveRun = {
				id: ++promptRunCounter,
				startTime: Date.now(),
				thoughtCount: 0,
				tools: [],
				expanded: false,
				completed: false,
			};
			promptRuns.set(currentActiveRun.id, currentActiveRun);
		}
	});

	pi.on("message_update", (event) => {
		processAssistantMessage(event.message, currentActiveRun);
	});

	pi.on("message_end", (event) => {
		processAssistantMessage(event.message, currentActiveRun);
	});

	pi.on("tool_execution_start", (event) => {
		const run = toolCallToPromptRun.get(event.toolCallId) ?? currentActiveRun;
		if (run) {
			let tool = run.tools.find((t) => t.id === event.toolCallId);
			if (!tool) {
				tool = { id: event.toolCallId, name: event.toolName, args: event.args ?? {} };
				run.tools.push(tool);
				toolCallToPromptRun.set(event.toolCallId, run);
			}
			tool.executionStarted = true;
			tool.isPartial = true;
			invalidateLeader(run);
		}
	});

	pi.on("tool_execution_end", (event: any) => {
		const run = toolCallToPromptRun.get(event.toolCallId) ?? currentActiveRun;
		if (run) {
			const tool = run.tools.find((t) => t.id === event.toolCallId);
			if (tool) {
				tool.isPartial = false;
				if (event.isError) tool.isError = true;
				if (event.durationMs) tool.durationMs = event.durationMs;
			}
			invalidateLeader(run);
		}
	});

	pi.on("agent_end", () => {
		if (currentActiveRun) {
			currentActiveRun.completed = true;
			currentActiveRun.endTime = Date.now();
			invalidateLeader(currentActiveRun);
		}
		currentActiveRun = null;
	});

	pi.on("turn_end", () => {
		if (currentActiveRun) {
			invalidateLeader(currentActiveRun);
		}
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			ctx.ui.setToolsExpanded?.(false);
			ctx.ui.setHiddenThinkingLabel?.("");
		}
		if ((ctx as any).sessionManager) {
			reconstructTurnsFromBranch((ctx as any).sessionManager.getBranch());
		}
	});

	pi.registerCommand?.("compact-mode", {
		description: "Switch compact tool style (opencode: single summary bar, lines: individual one-line tools)",
		handler: async (args, ctx) => {
			const style = args.trim().toLowerCase();
			if (style === "lines" || style === "opencode") {
				compactMode = style as "opencode" | "lines";
			} else {
				compactMode = compactMode === "opencode" ? "lines" : "opencode";
			}
			ctx.ui.notify(`Compact mode: ${compactMode}`);
			for (const comp of componentByToolCallId.values()) {
				comp.invalidate();
			}
		},
	});
}
