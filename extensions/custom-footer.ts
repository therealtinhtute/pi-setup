import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseColor, truncateToWidth } from "@earendil-works/pi-tui";

const BAR_CELLS = 8;
const MODEL_COLOR = parseColor(208);
const EFFORT_COLOR = parseColor(5); // ANSI magenta (SGR 35), matching Claude's statusline.
const TPM_COLOR = parseColor(11); // Bright yellow (SGR 93).
const CONTEXT_GRAY = parseColor("#9e9e9e"); // ANSI 247 matching Claude's statusline.
const CONTEXT_YELLOW = parseColor("#facc15"); // Bright yellow matching Claude's statusline.
const CONTEXT_RED = parseColor("#f87171"); // Bright red matching Claude's statusline.

function contextColor(percent: number) {
	if (percent >= 75) return CONTEXT_RED;
	if (percent >= 50) return CONTEXT_YELLOW;
	return CONTEXT_GRAY;
}

// Model names and branch names are labels, never terminal control sequences.
function label(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function latestCacheHitRate(ctx: ExtensionContext): number | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) return undefined;
		const tokens = [usage.input, usage.cacheRead, usage.cacheWrite];
		if (!tokens.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
		const total = usage.input + usage.cacheRead + usage.cacheWrite;
		if (total <= 0 || !Number.isFinite(total)) return undefined;
		const hit = (usage.cacheRead * 100) / total;
		return Number.isFinite(hit) ? hit : undefined;
	}
	return undefined;
}

function totalSessionTokens(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage = entry.type === "message"
			? (entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined)
			: (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined);
		if (usage && [usage.input, usage.output].every((value) => Number.isFinite(value) && value >= 0)) {
			total += usage.input + usage.output;
		}
	}
	return Number.isFinite(total) ? total : 0;
}

function formatTpm(tpm: number): string {
	if (tpm >= 10000) return `${Math.floor(tpm / 1000)}k`;
	if (tpm >= 1000) return `${Math.floor(tpm / 1000)}.${Math.floor((tpm % 1000) / 100)}k`;
	return String(tpm);
}

export default function (pi: ExtensionAPI) {
	const applyFooter = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const requestRender = () => tui.requestRender();
			const unsubscribe = [
				footerData.onBranchChange(requestRender),
				pi.on("model_select", requestRender),
				pi.on("thinking_level_select", requestRender),
			];
			let disposed = false;
			let cacheSession: string | undefined;
			let cacheLeaf: string | null | undefined;
			let cacheHit: number | undefined;
			let tokenTotal = 0;
			let sessionStartedAt = NaN;

			return {
				invalidate() { cacheSession = undefined; },
				dispose() {
					if (disposed) return;
					disposed = true;
					for (const unsub of unsubscribe) unsub();
				},
				render(width: number): string[] {
					const model = label(ctx.model?.name || ctx.model?.id || "no model");
					const thinking = pi.getThinkingLevel();
					const usage = ctx.getContextUsage()?.percent;
					const percent = typeof usage === "number" && Number.isFinite(usage)
						? Math.max(0, Math.min(100, usage))
						: undefined;
					const filled = Math.round(((percent ?? 0) / 100) * BAR_CELLS);
					const bar = "━".repeat(filled) + "─".repeat(BAR_CELLS - filled);
					const context = percent === undefined
						? theme.style(`${bar} ?%`, { fg: CONTEXT_GRAY })
						: theme.style(`${bar} ${Math.round(percent)}%`, { fg: contextColor(percent) });
					const separator = theme.fg("dim", " · ");
					const parts = [
						theme.style(`👾 ${model}`, { fg: MODEL_COLOR, bold: true }),
						theme.style(thinking, { fg: EFFORT_COLOR }),
						context,
					];
					const session = ctx.sessionManager.getSessionId();
					const leaf = ctx.sessionManager.getLeafId();
					if (session !== cacheSession || leaf !== cacheLeaf) {
						cacheHit = latestCacheHitRate(ctx);
						tokenTotal = totalSessionTokens(ctx);
						sessionStartedAt = Date.parse(ctx.sessionManager.getHeader()?.timestamp ?? "");
						cacheSession = session;
						cacheLeaf = leaf;
					}
					const elapsed = Date.now() - sessionStartedAt;
					const tpm = elapsed > 0 ? Math.floor((tokenTotal * 60000) / elapsed) : 0;
					if (Number.isFinite(tpm) && tpm > 0) {
						parts.push(`${theme.style("ϟ", { fg: TPM_COLOR })} ${theme.fg("dim", `${formatTpm(tpm)} tpm`)}`);
					}
					if (cacheHit !== undefined) {
						const hit = Math.floor(cacheHit);
						const color = cacheHit === 0 ? "dim"
							: hit >= 90 ? "success" : hit >= 70 ? "warning" : "error";
						parts.push(theme.fg(color, `★ ${hit}%`));
					}
					const branch = footerData.getGitBranch();
					if (branch) parts.push(theme.fg("syntaxVariable", `⌥ ${label(branch)}`));

					return [truncateToWidth(` ${parts.join(separator)}`, Math.max(0, width))];
				},
			};
		});
	};

	pi.on("session_start", (_event, ctx) => applyFooter(ctx));

	pi.registerCommand("custom-footer", {
		description: "Show compact model, thinking, context, TPM, cache hit, and Git footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			applyFooter(ctx);
			ctx.ui.notify("Custom footer restored", "info");
		},
	});

	pi.registerCommand("builtin-footer", {
		description: "Restore the built-in Pi footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			ctx.ui.setFooter(undefined);
			ctx.ui.notify("Built-in footer restored", "info");
		},
	});
}
