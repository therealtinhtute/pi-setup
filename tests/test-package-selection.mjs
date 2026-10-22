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
	"npm:pi-lsp-extension@1.4.0",
	"npm:pi-memory",
	"npm:pi-subagents@0.77.0",
	"npm:@narumitw/pi-goal",
	// On trial (2026-10-21): pi-lens adds post-edit LSP/lint/format feedback on top of
	// pi-lsp-extension's tools, at the cost of a second LSP client pool. Java support
	// needs scripts/install-java-lsp.sh.
	"npm:pi-lens",
	// On trial (2026-10-21): context-mode for tool-output sandboxing. Neither trial has
	// proven itself yet — see the dropped list below for what already lost that bet.
	"npm:context-mode",
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
assert.equal(settings.theme, "system");
assert.equal(settings.lastChangelogVersion, "1.4.0");
assert.equal(settings.defaultProvider, "opencode-go");
assert.equal(settings.defaultModel, "deepseek-v4.1-flash");
assert.equal(settings.defaultThinkingLevel, "high");
assert(!Object.hasOwn(settings, "extensions"), "builtin MCP must not stay disabled now that the adapter is gone");
assert(!Object.hasOwn(settings, "pi-browser-use"), "no browser config may linger in the template");
assert(!sources.some((source) => source === "git:github.com/ttttmr/pi-devin-oauth"),
	"the inactive Devin provider must not be reintroduced");
assert(!Object.hasOwn(settings["pi-browser-use"] ?? {}, "executablePath"),
	"shared browser config must use automatic discovery, not a machine-specific executablePath");
// models.json carries compat overrides only; credentials stay in auth.json.
const providers = Object.entries(models.providers ?? {});
assert(providers.length > 0, "models.json must configure at least one provider");
for (const [id, provider] of providers) {
	assert(provider.apiKey === undefined, `${id}: credentials must not be committed`);
	assert(provider.baseUrl === undefined, `${id}: the provider endpoint comes from Pi, not the repo`);
	const overrides = Object.entries(provider.modelOverrides ?? {});
	assert(overrides.length > 0, `${id}: expected model-scoped compat overrides`);
	for (const [model, override] of overrides) {
		assert.deepEqual(Object.keys(override), ["compat"], `${id}/${model}: only compat may be overridden here`);
		assert(override.compat.sendSessionAffinityHeaders === true, `${id}/${model}: session affinity stays enabled`);
	}
}
assert(models.providers["opencode-go"]?.modelOverrides?.["deepseek-v4.1-flash"],
	"the default model keeps its session-affinity override");
console.log("PASS: synced packages, standalone goal/subagents, opencode-go defaults, models.json compat, "
	+ "browser autodetection, removed packages absent");
