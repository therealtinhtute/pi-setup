// Run: node tests/test-worker-agent.mjs
// Pure file checks: no package installation, credentials, or network calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
	new URL("../agents/worker-lsp.md", import.meta.url), "utf8",
);

const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
assert(match, "agents/worker-lsp.md must start with YAML frontmatter");

const [, frontmatter, prompt] = match;
const fields = new Map();
for (const line of frontmatter.split("\n")) {
	if (!line.trim() || line.startsWith("#")) continue;
	const index = line.indexOf(":");
	assert(index > 0, `unparseable frontmatter line: ${line}`);
	fields.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
}

const list = (name) => (fields.get(name) ?? "")
	.split(",").map((entry) => entry.trim()).filter(Boolean);

assert.equal(fields.get("name"), "worker-lsp");
assert.equal(fields.get("acceptanceRole"), "writer", "a worker edits files");
assert.equal(fields.get("inheritSkills"), "true", "the worker must see the repo skills");
assert.equal(fields.get("inheritProjectContext"), "true", "AGENTS.md instructions stay in force");

// The strict allowlist is the whole point: it must stay narrow, and it must carry the
// code-intelligence tools the bundled worker lacks.
const tools = list("tools");
for (const required of ["read", "edit", "write", "bash", "contact_supervisor",
	"lens_diagnostics", "symbol_search", "module_report", "read_symbol",
	"lsp_navigation", "memory_search"]) {
	assert(tools.includes(required), `tools must allowlist ${required}`);
}
for (const forbidden of ["memory_write", "subagent", "web_search", "ast_grep_replace"]) {
	assert(!tools.includes(forbidden), `tools must not grant ${forbidden} to a child`);
}

// An allowlisted name does not load the provider that registers it, and foreground
// children never load ambient extensions — so both providers must be listed here.
const extensions = list("extensions");
assert(extensions.length === 2, "exactly the code-intelligence and memory providers are declared");
assert(extensions.some((entry) => entry.endsWith("pi-lens/dist/index.js")),
	"the code-intelligence provider path must point at its dist entry point");
assert(extensions.some((entry) => entry.endsWith("pi-memory/index.ts")),
	"the memory provider path must point at its entry file");
for (const entry of extensions) {
	assert(entry.startsWith("~/") || entry.startsWith("/"),
		`extension path must be absolute or ~-relative: ${entry}`);
}

// Cost and quality gates: a child needs a deadline and an acceptance level.
const timeoutMs = Number(fields.get("timeoutMs"));
assert(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_600_000,
	"timeoutMs must be a positive deadline of at most one hour");
assert.equal(fields.get("acceptance"), "checked", "a run must pass acceptance, not just claim success");

assert(prompt.includes("lens_diagnostics"), "the prompt must tell the worker to run diagnostics");
assert(/\n## Final response shape/.test(prompt), "the prompt must define the final response shape");

console.log("PASS: worker-lsp allowlist, explicit extension providers, run deadline, acceptance level");
