// Offline only. Run: node tests/test-decision-compact.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases",
	readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const agent = join(modules, "@earendil-works/pi-coding-agent");
const load = (path) => import(pathToFileURL(path).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(agent, "dist/index.js"),
	"@earendil-works/pi-ai": join(modules, "@earendil-works/pi-ai/dist/index.js"),
} });
const { SessionManager, estimateTokens, buildSessionProjection } = await load(join(agent, "dist/index.js"));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content) => ({ role: "assistant", content, api: "openai-responses", provider: "openai",
	model: "fixture", usage, stopReason: "toolUse", timestamp: 2 });
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "read",
	content: [{ type: "text", text }], isError: false, timestamp: 3 });
const manager = SessionManager.inMemory("/tmp/decision-compact-fixture");
manager.appendMessage({ role: "user", content: "Keep exact paths", timestamp: 1 });
const callId = manager.appendMessage(assistant([{ type: "text", text: "Inspect src/a.ts" },
	{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } }]));
const resultId = manager.appendMessage(result("c1", "contents"));
const raw = JSON.stringify(manager.getEntry(resultId));
manager.appendContextEdit(resultId, { content: [{ type: "text", text: "short" }] });
assert.equal(JSON.stringify(manager.getEntry(resultId)), raw);
assert.equal(manager.buildSessionProjection().messages.at(-1).content[0].text, "short");
const leafBeforeDrop = manager.getLeafId();
manager.appendContextEdit(callId, { content: [{ type: "text", text: "Inspect src/a.ts" }] });
manager.appendContextEdit(resultId, null);
assert.deepEqual(manager.buildSessionProjection().messages.at(-1).content, [{ type: "text", text: "Inspect src/a.ts" }]);
manager.branch(leafBeforeDrop);
assert.equal(manager.buildSessionProjection().messages.at(-1).content[0].text, "short");
assert.equal(typeof estimateTokens(manager.buildSessionProjection().messages[0]), "number");
assert.deepEqual(buildSessionProjection(manager.getBranch()).messages, manager.buildSessionProjection().messages);
assert.equal(manager.getEntry(callId).message.content[1].type, "toolCall");
console.log("PASS public API: append-only edits, projection, branch replay, metadata and token estimator");

// The extension only receives a readonly session surface. This test harness models
// Pi's commit boundary; appendContextEdit is called by the host, never by the extension.
function commit(sm, drafts) {
	for (const draft of drafts) {
		if (draft.type === "context_edit") sm.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom") sm.appendCustomEntry(draft.customType, draft.data);
		else throw new Error(`Unsupported fixture draft: ${draft.type}`);
	}
}
