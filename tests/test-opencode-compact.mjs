// Run: node tests/test-opencode-compact.mjs
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
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
} });

const { default: extension } = await jiti.import(resolve("extensions/compact-tools.ts"));
const { Container, stripTerminalSequences, visibleWidth } = await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { initTheme, setTerminalColors } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
const { ToolExecutionComponent, UserMessageComponent } = await load(join(agent, "dist/index.js"));

initTheme("system", false);
setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });

const handlers = new Map();
const commands = new Map();
let resolver;

extension({
	registerToolRenderer: (fn) => { resolver = fn; },
	on: (name, fn) => handlers.set(name, fn),
	registerCommand: (name, def) => commands.set(name, def),
});

const plain = stripTerminalSequences;
const ui = { requestRender() {}, notify() {} };
const cwd = process.cwd();

// --- 1. User Message Left Accent Bar ---
const userMsg = new UserMessageComponent("ok, brainstorm to plan hết đi cl");
const userLines = userMsg.render(60);
assert.equal(userLines.length, 3);
for (const line of userLines) {
	assert.equal(visibleWidth(plain(line)), 60, "line must fit target width");
	assert(plain(line).startsWith("▌"), "every line must begin with the accent bar ▌");
}
console.log("PASS: User prompt box left accent bar");

// Turn Events & OpenCode Aggregated Summary ---
handlers.get("agent_start")?.({}, { mode: "tui" });
handlers.get("turn_start")?.({ turnIndex: 1, timestamp: 1000 }, { mode: "tui" });

// Assistant message with 2 thoughts and 3 tool calls
handlers.get("message_update")({
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Analyzing git status" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
			{ type: "thinking", thinking: "Checking git diff" },
			{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "git diff" } },
			{ type: "toolCall", id: "call-3", name: "read", arguments: { path: "src/index.ts" } },
		],
	},
}, { mode: "tui" });

// Create Tool components with compact-tools renderer
const r1 = resolver("bash", () => ({}));
const t1 = new ToolExecutionComponent("bash", "call-1", { command: "git status" }, {}, r1, ui, cwd);
const r2 = resolver("bash", () => ({}));
const t2 = new ToolExecutionComponent("bash", "call-2", { command: "git diff" }, {}, r2, ui, cwd);
const r3 = resolver("read", () => ({}));
const t3 = new ToolExecutionComponent("read", "call-3", { path: "src/index.ts" }, {}, r3, ui, cwd);

const chat = new Container();
chat.addChild(userMsg);
chat.addChild(t1);
chat.addChild(t2);
chat.addChild(t3);

// Running state before tool execution ends
handlers.get("tool_execution_start")({ toolCallId: "call-1", toolName: "bash", args: { command: "git status" } }, { mode: "tui" });
t1.markExecutionStarted();

let chatLines = chat.render(80).map(plain).filter((l) => l.trim());
assert(chatLines.some((l) => l.includes("3 commands, 2 thoughts")), "shows total commands and thoughts");
assert(chatLines.some((l) => l.includes("bash")), "shows active running tool name");
console.log("PASS: Real-time running summary with spinner and active tool");

// Complete tools
t1.updateResult({ content: [{ type: "text", text: "On branch main" }], isError: false });
handlers.get("tool_execution_end")({ toolCallId: "call-1", isError: false }, { mode: "tui" });

t2.updateResult({ content: [{ type: "text", text: "diff output" }], isError: false });
handlers.get("tool_execution_end")({ toolCallId: "call-2", isError: false }, { mode: "tui" });

t3.updateResult({ content: [{ type: "text", text: "file content" }], isError: false });
handlers.get("tool_execution_end")({ toolCallId: "call-3", isError: false }, { mode: "tui" });

handlers.get("turn_end")?.({ turnIndex: 1 }, { mode: "tui" });
handlers.get("agent_end")?.({ messages: [] }, { mode: "tui" });

// Collapsed state: exactly ONE line under user message
chatLines = chat.render(80).map(plain).filter((l) => l.trim());
const toolLines = chatLines.filter((l) => !l.startsWith("▌"));
assert.equal(toolLines.length, 1, "all 3 tools must be collapsed into exactly 1 summary row");
assert.equal(toolLines[0], "⋮ 3 commands, 2 thoughts", "summary text matches OpenCode v2 format");
console.log("PASS: Collapsed turn action bar: single summary line");

// --- 3. Click Interaction: Expand / Collapse ---
// Click the leader (t1) at line offset
t1.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 2, shift: false, alt: false, ctrl: false });
let expandedLines = chat.render(80).map(plain).filter((l) => l.trim());
assert(expandedLines.some((l) => l.includes("▾ 3 commands, 2 thoughts")), "expanded header visible");
assert(expandedLines.some((l) => l.includes("On branch main")), "t1 output visible");
assert(expandedLines.some((l) => l.includes("diff output")), "t2 output visible");
assert(expandedLines.some((l) => l.includes("file content")), "t3 output visible");
console.log("PASS: Clicking leader expands all tools in turn");

// Second click collapses back to 1 line
t1.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 2, shift: false, alt: false, ctrl: false });
let collapsedAgain = chat.render(80).map(plain).filter((l) => l.trim());
const collapsedTools = collapsedAgain.filter((l) => !l.startsWith("▌"));
assert.equal(collapsedTools.length, 1, "second click collapses back to 1 line");
assert.equal(collapsedTools[0], "⋮ 3 commands, 2 thoughts");
console.log("PASS: Second click collapses back to single line");

// --- 4. Tool Error Indication ---
handlers.get("agent_start")?.({}, { mode: "tui" });
handlers.get("turn_start")?.({ turnIndex: 2, timestamp: 2000 }, { mode: "tui" });
handlers.get("message_update")({
	message: {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "err-1", name: "bash", arguments: { command: "failing-cmd" } },
			{ type: "toolCall", id: "err-2", name: "read", arguments: { path: "missing.ts" } },
		],
	},
}, { mode: "tui" });

const te1 = new ToolExecutionComponent("bash", "err-1", { command: "failing-cmd" }, {}, resolver("bash", () => ({})), ui, cwd);
const te2 = new ToolExecutionComponent("read", "err-2", { path: "missing.ts" }, {}, resolver("read", () => ({})), ui, cwd);

te1.updateResult({ content: [{ type: "text", text: "command not found" }], isError: true });
handlers.get("tool_execution_end")({ toolCallId: "err-1", isError: true }, { mode: "tui" });

te2.updateResult({ content: [{ type: "text", text: "file content" }], isError: false });
handlers.get("tool_execution_end")({ toolCallId: "err-2", isError: false }, { mode: "tui" });

handlers.get("turn_end")?.({ turnIndex: 2 }, { mode: "tui" });
handlers.get("agent_end")?.({ messages: [] }, { mode: "tui" });

const errContainer = new Container();
errContainer.addChild(te1);
errContainer.addChild(te2);

const errLines = errContainer.render(80).map(plain).filter((l) => l.trim());
assert.equal(errLines.length, 1, "error turn collapses to 1 line");
assert(errLines[0].includes("2 commands (1 failed)"), "highlights failure count");
console.log("PASS: Failed tool calls reflected in summary bar");

// --- 5. Historical Reconstruction from Branch ---
const fakeBranch = [
	{ type: "message", message: { role: "user", content: "Historical prompt" }, timestamp: 500 },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering" },
				{ type: "toolCall", id: "hist-1", name: "bash", arguments: { command: "ls" } },
			],
		},
		timestamp: 600,
	},
	{ type: "message", message: { role: "toolResult", toolCallId: "hist-1", isError: false }, timestamp: 700 },
];

handlers.get("session_start")({}, { mode: "tui", sessionManager: { getBranch: () => fakeBranch }, ui });
const th1 = new ToolExecutionComponent("bash", "hist-1", { command: "ls" }, {}, resolver("bash", () => ({})), ui, cwd);
th1.updateResult({ content: [{ type: "text", text: "file1 file2" }], isError: false });

const histContainer = new Container();
histContainer.addChild(th1);
const histLines = histContainer.render(80).map(plain).filter((l) => l.trim());
assert.equal(histLines.length, 1);
assert.equal(histLines[0], "⋮ 1 command, 1 thought", "reconstructed from session history");
console.log("PASS: Historical turn reconstruction");

// --- 6. Command /compact-mode ---
const cmdDef = commands.get("compact-mode");
assert(cmdDef, "compact-mode command must be registered");
let notifiedMsg = "";
const mockCmdCtx = {
	ui: {
		notify(msg) { notifiedMsg = msg; },
	},
};

// Switch to lines mode
await cmdDef.handler("lines", mockCmdCtx);
assert.equal(notifiedMsg, "Compact mode: lines");

// Switch to opencode mode
await cmdDef.handler("opencode", mockCmdCtx);
assert.equal(notifiedMsg, "Compact mode: opencode");

// Toggle with no args
await cmdDef.handler("", mockCmdCtx);
assert.equal(notifiedMsg, "Compact mode: lines");
await cmdDef.handler("", mockCmdCtx);
assert.equal(notifiedMsg, "Compact mode: opencode");
console.log("PASS: /compact-mode command handler");

console.log("ALL OPENCODE COMPACT TESTS PASSED!");
