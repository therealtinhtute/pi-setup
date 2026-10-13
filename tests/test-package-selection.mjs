// Run: node tests/test-package-selection.mjs
// Pure template checks: no package installation, credentials, or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(
	new URL("../config/settings.json", import.meta.url), "utf8",
));
const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry.source);
const packageIds = sources.map((source) => source.startsWith("npm:")
	? source.replace(/@[^@/]+$/, "") : source);
assert.equal(new Set(packageIds).size, packageIds.length, "package identities must not be duplicated");
for (const source of [
	"npm:pi-diff-review@0.1.27",
	"npm:pi-lsp-extension@1.4.0",
	"npm:pi-subagents@0.77.0",
]) {
	assert(sources.includes(source), `${source} must remain pinned`);
}
assert(sources.includes("npm:@narumitw/pi-goal"), "the standalone goal package must be enabled");
for (const alternate of ["npm:@tintinweb/pi-subagents", "npm:@gotgenes/pi-subagents"]) {
	assert(!packageIds.includes(alternate), "only one subagent implementation may be enabled");
}
for (const inactive of [
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
assert.equal(settings.theme, "system");
assert.equal(settings.lastChangelogVersion, "1.2.0");
assert(sources.includes("npm:pi-browser-use"), "browser extension must remain enabled");
assert.equal(settings.defaultProvider, "openai-codex");
assert.equal(settings.defaultModel, "gpt-6.1-sol");
assert.equal(settings.defaultThinkingLevel, "high");
assert.deepEqual(settings.extensions, ["-builtin:mcp"], "the MCP adapter replaces builtin MCP");
assert(!sources.some((source) => source === "git:github.com/ttttmr/pi-devin-oauth"),
	"the inactive Devin provider must not be reintroduced");
assert(!Object.hasOwn(settings["pi-browser-use"] ?? {}, "executablePath"),
	"shared browser config must use automatic discovery, not a machine-specific executablePath");
console.log("PASS: synced packages, standalone goal/subagents, Codex defaults, browser autodetection, removed packages absent");
