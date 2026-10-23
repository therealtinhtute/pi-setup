// Run: node tests/test-package-selection.mjs
// Pure template checks: no package installation, credentials, or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(
	new URL("../config/settings.json", import.meta.url), "utf8",
));
const models = JSON.parse(readFileSync(
	new URL("../config/models.json", import.meta.url), "utf8",
));
const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry.source);
const packageIds = sources.map((source) => source.startsWith("npm:")
	? source.replace(/@[^@/]+$/, "") : source);
assert.equal(new Set(packageIds).size, packageIds.length, "package identities must not be duplicated");
// The minimal set: one provider, one web layer, one tool each for todo/ask/memory/lsp,
// one delegation layer, one goal layer. Anything else has to earn its tool schema.
const expected = [
	"npm:pi-antigravity",
	"npm:pi-web-access",
	"npm:@juicesharp/rpiv-ask-user-question",
	"npm:@juicesharp/rpiv-todo",
	"npm:pi-memory",
	"npm:pi-subagents@0.81.0",
	"npm:@narumitw/pi-goal",
	// Swapped in on 2026-10-23 for pi-lsp-extension + context-mode. Both covered jobs
	// the TUI never used: pi-lens carries diagnostics, symbol search and the structural
	// ast-grep tools in one package, so the second LSP client pool is gone and the
	// tool-output sandbox (which overlapped /rewind and pi-memory) with it.
	"npm:pi-lens",
	// Vendored 2026-10-23: pi-pretty was forked into extensions/pi-pretty so its
	// renderer can be changed (working-indicator split, gradient work) without
	// shipping a private npm package. Upstream v0.8.0, MIT. It adds no tool of its
	// own (it re-registers read/edit) and owns neither ctx.ui.setHeader nor
	// ctx.ui.setFooter, so custom-banner.ts and custom-footer.ts keep their jobs.
	"extensions/pi-pretty",
];
assert.deepEqual([...sources].sort(), [...expected].sort(), "the package list is exactly the tracked set");

// Each of these was removed on 2026-10-21 after measuring real tool usage: browser-use
// alone contributed 34 of 71 tools for 23 lifetime calls.
for (const dropped of [
	"npm:pi-browser-use",
	"npm:pi-mcp-adapter",
	"npm:@latentminds/pi-quotas",
	"npm:pi-context-view",
	"npm:pi-cache-optimizer",
	"npm:@tmustier/pi-session-recap",
	"npm:pi-simplify",
	"npm:pi-diff-review@0.1.27",
	"npm:pi-condense",
	// pi-lsp-extension and context-mode were both dropped on 2026-10-23. pi-lens now
	// owns code intelligence (lens_diagnostics, symbol_search, ast_grep_*) and pi-memory
	// already owns memory, so neither had a job left.
	"npm:pi-lsp-extension",
	"npm:context-mode",
	// pi-pigment (render-only decorators for the eight built-in tool renderers) was
	// added to the template on 2026-10-21 and reverted on 2026-10-22. It hooks the
	// same internal renderer surface that retired code-block.ts, and it was never
	// installed on the machine, so the template only carried drift.
	"npm:pi-pigment",
]) {
	assert(!sources.includes(dropped), `${dropped} was trimmed and must not come back silently`);
}
assert(!Object.hasOwn(settings, "contextPrune"),
	"pi-condense config must not linger after the package was removed");
assert(sources.includes("npm:@narumitw/pi-goal"), "the standalone goal package must be enabled");
for (const alternate of ["npm:@tintinweb/pi-subagents", "npm:@gotgenes/pi-subagents"]) {
	assert(!packageIds.includes(alternate), "only one subagent implementation may be enabled");
}
for (const inactive of [
	"npm:pi-browser-use",
	"npm:pi-mcp-adapter",
	"npm:pi-advisor-flow",
	"npm:pi-smart-fetch",
	"npm:pi-devin-local",
	"npm:@gotgenes/pi-permission-system",
	"npm:@plannotator/pi-extension",
]) {
	assert(!packageIds.includes(inactive), `${inactive} is not selected in the synced setup`);
}
assert(!sources.some((source) => source.includes("mitsuhiko/agent-stuff") || source.startsWith("npm:mitsupi")),
	"the old mitsupi bundle must not overlap with the standalone goal/subagent packages");
// UI packages must stay render-only: a footer owner or a second tool renderer can
// silently displace extensions/custom-footer.ts or bloat the tool schema.
assert(!packageIds.some((id) => /powerline|slate|pi-coder|arnative|cc-extensions|footer/.test(id)),
	"only custom-footer.ts owns the footer; no second footer/TUI suite may be installed");
assert.equal(settings.theme, "cyan", "custom cyan theme is selected");
const cyanTheme = JSON.parse(readFileSync(
	new URL("../themes/cyan.json", import.meta.url), "utf8",
));
assert.equal(cyanTheme.name, "cyan");
assert.equal(cyanTheme.colors.accent, "cyan");
// The cursor belongs to the terminal: Pi positions the hardware cursor (which also keeps
// IME composition anchored) instead of hiding it and painting a reverse-video block.
assert.equal(settings.showHardwareCursor, true,
	"the terminal draws the cursor, not Pi's fake block cursor");
assert.equal(settings.lastChangelogVersion, "1.4.0");
// Default is hive because its credential comes from auth.json via /login, exactly like
// opencode-go's — neither is committed, so neither is more portable than the other.
assert.equal(settings.defaultProvider, "hive");
assert.equal(settings.defaultModel, "deepseek-ai/deepseek-v4.1-flash-1017");
assert.equal(settings.defaultThinkingLevel, "high");
assert(!Object.hasOwn(settings, "extensions"), "builtin MCP must not stay disabled now that the adapter is gone");
assert(!Object.hasOwn(settings, "pi-browser-use"), "no browser config may linger in the template");
assert(!sources.some((source) => source === "git:github.com/ttttmr/pi-devin-oauth"),
	"the inactive Devin provider must not be reintroduced");
assert(!Object.hasOwn(settings["pi-browser-use"] ?? {}, "executablePath"),
	"shared browser config must use automatic discovery, not a machine-specific executablePath");
// models.json may carry compat overrides for a built-in provider, or a whole custom
// provider definition. Either way credentials never live here: a custom provider must
// name an environment variable (`$VAR`), never a literal key.
const providers = Object.entries(models.providers ?? {});
assert(providers.length > 0, "models.json must configure at least one provider");
for (const [id, provider] of providers) {
	if (provider.modelOverrides) {
		assert(provider.apiKey === undefined, `${id}: override-only providers must not declare credentials`);
		assert(provider.baseUrl === undefined, `${id}: the provider endpoint comes from Pi, not the repo`);
		const overrides = Object.entries(provider.modelOverrides ?? {});
		assert(overrides.length > 0, `${id}: expected model-scoped compat overrides`);
		for (const [model, override] of overrides) {
			assert.deepEqual(Object.keys(override), ["compat"], `${id}/${model}: only compat may be overridden here`);
			assert(override.compat.sendSessionAffinityHeaders === true, `${id}/${model}: session affinity stays enabled`);
		}
		continue;
	}
	// Full custom provider: endpoint and model list are declared, the key is not.
	assert(typeof provider.baseUrl === "string" && /^https:\/\//.test(provider.baseUrl),
		`${id}: a custom provider needs an https baseUrl`);
	if (provider.apiKey !== undefined) {
		// pi resolves two non-literal forms: `$VAR` (read from the process environment)
		// and `!command` (run it, use stdout). Anything else would be a committed secret.
		const isEnvRef = /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(provider.apiKey);
		const isCommand = provider.apiKey.startsWith("!");
		assert(isEnvRef || isCommand,
			`${id}: apiKey must be $MY_KEY or !command, never a literal secret`);
		assert(!/^(sk-|ghp_|AIza)/.test(provider.apiKey), `${id}: apiKey looks like a literal secret`);
	}
	assert(Array.isArray(provider.models) && provider.models.length > 0,
		`${id}: a custom provider needs at least one model entry`);
	for (const model of provider.models) {
		assert(typeof model.id === "string" && model.id.length > 0, `${id}: every model needs an id`);
	}
}
assert(models.providers["opencode-go"]?.modelOverrides?.["deepseek-v4.1-flash"],
	"the default model keeps its session-affinity override");
// hive is a custom provider whose credential lives in auth.json, configured once with
// /login — the same place opencode-go keeps its key. models.json must therefore not carry
// an apiKey for it: a second source would silently take over if auth.json lost the entry,
// hiding the fact that nobody had logged in.
const hive = models.providers.hive;
if (hive) {
	assert(!Object.hasOwn(hive, "apiKey"),
		"hive: no apiKey in models.json — the key belongs in auth.json via /login");
}
console.log("PASS: synced packages, standalone goal/subagents, hive default, models.json compat, "
	+ "browser autodetection, removed packages absent, no literal secrets");
