// Run from the repo root: node tests/test-account-pool.mjs
// For other install layouts: PI_NODE_MODULES=/path/to/node_modules node tests/test-account-pool.mjs
//
// Covers the account-pool extension end to end without touching the real agent
// dir: ranking/cooldown logic, error classification, credential switching, and
// the agent_end handler that reacts to a quota wall.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { jitiEntry, load, piAliases } from "./lib/pi-modules.mjs";

const root = mkdtempSync(join(tmpdir(), "account-pool-"));
process.env.PI_ACCOUNT_POOL_DIR = root;

const { createJiti } = await load(jitiEntry);
const jiti = createJiti(import.meta.url, { alias: piAliases });

const quota = await jiti.import(resolve("extensions/account-pool/lib/quota.ts"));
const rank = await jiti.import(resolve("extensions/account-pool/lib/rank.ts"));
const store = await jiti.import(resolve("extensions/account-pool/lib/store.ts"));
const { default: accountPool } = await jiti.import(resolve("extensions/account-pool/index.ts"));

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures += 1;
		console.error(`  FAIL ${name}\n       ${error.message}`);
	}
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const NOW = Date.parse("2026-10-21T12:00:00Z");
const accounts = {
	alpha: { accountId: "alpha", email: "alpha@example.com", access: "tok-alpha", projectId: "proj-alpha", lastUsedAt: NOW - 5_000 },
	beta: { accountId: "beta", email: "beta@example.com", access: "tok-beta", projectId: "proj-beta", lastUsedAt: NOW - 900_000 },
	gamma: { accountId: "gamma", email: "gamma@example.com", access: "tok-gamma", projectId: "proj-gamma", lastUsedAt: NOW - 1_800_000 },
};

function writeFixtures(active = "alpha") {
	writeFileSync(
		join(root, "antigravity-accounts.json"),
		JSON.stringify({ version: 1, activeAccountId: active, accounts }, null, 2),
	);
	writeFileSync(
		join(root, "auth.json"),
		JSON.stringify({
			antigravity: { type: "oauth", access: accounts[active].access, projectId: accounts[active].projectId, email: accounts[active].email },
			"opencode-go": { type: "api_key", key: "unrelated" },
		}, null, 2),
	);
	rmSync(join(root, "account-pool-state.json"), { force: true });
}

writeFixtures();

// ── quota classification ─────────────────────────────────────────────────────
console.log("quota classification");

test("hard wall with reset hint", () => {
	const verdict = quota.classifyQuotaWall(
		"Antigravity API error (429, endpoint=https://x, project=p, runtimeModel=gemini-3.8-flash, matched=none, available=x): Quota reached. Please wait 4h 12m. Next: switch models or retry later.",
		NOW,
	);
	assert.equal(verdict.wall, true);
	assert.equal(verdict.modelId, "gemini-3.8-flash");
	assert.equal(verdict.resetAt, NOW + (4 * 60 + 12) * 60_000);
});

test("hard wall without reset hint", () => {
	const verdict = quota.classifyQuotaWall("Quota reached. Please wait for reset. Next: switch models or try again after reset.", NOW);
	assert.equal(verdict.wall, true);
	assert.equal(verdict.resetAt, undefined);
});

test("transient throttle is not a wall", () => {
	const verdict = quota.classifyQuotaWall(
		"Rate limited by Antigravity (429 ResourceExhausted). Next: retrying automatically; if it persists, switch models.",
		NOW,
	);
	assert.equal(verdict.wall, false);
});

test("dead model is not a wall", () => {
	const verdict = quota.classifyQuotaWall(
		"This model is unavailable right now (Resource has been exhausted (e.g. check quota).). Next: switch to gemini-3.8-flash or another Flash model. This is not necessarily an account quota wall.",
		NOW,
	);
	assert.equal(verdict.wall, false);
});

test("reset hint variants", () => {
	assert.equal(quota.parseResetAt("Resets in 47m", NOW), NOW + 47 * 60_000);
	assert.equal(quota.parseResetAt("Resets in 90 seconds", NOW), NOW + 90_000);
	assert.equal(quota.parseResetAt("resets in 1d 2h", NOW), NOW + (24 + 2) * 3_600_000);
	assert.equal(quota.parseResetAt("no hint here", NOW), undefined);
});

// ── ranking and cooldown ─────────────────────────────────────────────────────
console.log("ranking and cooldown");

test("sticky while the active account is healthy", () => {
	const state = { ...rank.emptyState(), activeAccountId: "alpha" };
	const picked = pickFor(accounts, state);
	assert.equal(picked.reason, "sticky");
	assert.equal(picked.account.accountId, "alpha");
});

test("rotates off a blocked account to the least recently used", () => {
	let state = { ...rank.emptyState(), activeAccountId: "alpha" };
	state = rank.applyBlock(state, "alpha", NOW + 600_000, "wall", "gemini-3.8-flash");
	const picked = pickFor(accounts, state, "gemini-3.8-flash");
	assert.equal(picked.reason, "rotated");
	assert.equal(picked.account.accountId, "gamma", "gamma is older than beta");
});

test("model-scoped block does not disable another model", () => {
	let state = { ...rank.emptyState(), activeAccountId: "alpha" };
	state = rank.applyBlock(state, "alpha", NOW + 600_000, "wall", "gemini-3.8-flash");
	assert.equal(pickFor(accounts, state, "claude-sonnet").account.accountId, "alpha");
	assert.equal(pickFor(accounts, state, "gemini-3.8-flash").account.accountId, "gamma");
});

test("wildcard block disables every model", () => {
	let state = { ...rank.emptyState(), activeAccountId: "alpha" };
	state = rank.applyBlock(state, "alpha", NOW + 600_000, "wall");
	assert.equal(pickFor(accounts, state, "claude-sonnet").account.accountId, "gamma");
});

test("all blocked reports no candidate", () => {
	let state = rank.emptyState();
	for (const id of Object.keys(accounts)) state = rank.applyBlock(state, id, NOW + 600_000);
	const picked = pickFor(accounts, state);
	assert.equal(picked.reason, "all-blocked");
	assert.equal(picked.account, undefined);
});

test("heal drops expired blocks and keeps live ones", () => {
	let state = rank.emptyState();
	state = rank.applyBlock(state, "alpha", NOW - 1_000, "expired");
	state = rank.applyBlock(state, "beta", NOW + 60_000, "live");
	const healed = rank.heal(state, NOW);
	assert.deepEqual(healed.healed, ["alpha:*"]);
	assert.equal(healed.state.blocks.alpha, undefined);
	assert.ok(healed.state.blocks.beta);
});

function pickFor(list, state, modelId) {
	return rank.pickAccount(Object.values(list), state, NOW, modelId);
}

// ── credential switching ────────────────────────────────────────────────────
console.log("credential switching");

test("switchActive rewrites auth.json and the pool's active id", () => {
	writeFixtures("alpha");
	const switched = store.switchActive("beta");
	assert.equal(switched.accountId, "beta");

	const auth = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
	assert.equal(auth.antigravity.access, "tok-beta");
	assert.equal(auth.antigravity.projectId, "proj-beta");
	assert.equal(auth["opencode-go"].key, "unrelated", "other providers survive the write");

	const pool = JSON.parse(readFileSync(join(root, "antigravity-accounts.json"), "utf8"));
	assert.equal(pool.activeAccountId, "beta");
	assert.ok(pool.accounts.alpha, "the previous account stays in the pool");
});

test("auth.json is written private (0600)", () => {
	writeFixtures("alpha");
	store.switchActive("gamma");
	const mode = statSync(join(root, "auth.json")).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("state file never contains credentials", () => {
	writeFixtures("alpha");
	let state = rank.emptyState();
	state = rank.applyBlock(state, "alpha", NOW + 60_000, "quota wall", "gemini-3.8-flash");
	store.saveState(state);
	const raw = readFileSync(join(root, "account-pool-state.json"), "utf8");
	assert.ok(!/tok-alpha|tok-beta|tok-gamma/.test(raw), "no access tokens in state");
	assert.ok(!/proj-/.test(raw), "no project ids in state");
});

// ── extension wiring ────────────────────────────────────────────────────────
console.log("extension wiring");

function fakePi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		pi: {
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, []);
				handlers.get(name).push(handler);
				return () => {};
			},
			registerCommand(name, options) {
				commands.set(name, options);
			},
		},
		handlers,
		commands,
	};
}

function fakeCtx(notices) {
	return {
		hasUI: true,
		mode: "tui",
		model: { id: "gemini-3.8-flash", provider: "antigravity" },
		ui: { notify: (text, type) => notices.push({ text, type }) },
	};
}

test("agent_end blocks the walled account and switches away from it", async () => {
	writeFixtures("alpha");
	const { pi, handlers } = fakePi();
	accountPool(pi);
	const notices = [];
	const handler = handlers.get("agent_end")[0];

	await handler(
		{
			type: "agent_end",
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					stopReason: "error",
					errorMessage:
						"Antigravity API error (429): Quota reached. Please wait 2h. Next: switch models or retry later.",
				},
			],
		},
		fakeCtx(notices),
	);

	const state = JSON.parse(readFileSync(join(root, "account-pool-state.json"), "utf8"));
	assert.ok(state.blocks.alpha, "walled account is recorded");
	assert.equal(state.blocks.alpha["*"].until > Date.now(), true);

	const auth = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
	assert.notEqual(auth.antigravity.projectId, "proj-alpha", "credential moved off the walled account");
	assert.ok(notices.some((notice) => /out of quota/.test(notice.text)));
	assert.ok(notices.some((notice) => /switched to/.test(notice.text)));
});

test("agent_end ignores non-quota failures", async () => {
	writeFixtures("alpha");
	const { pi, handlers } = fakePi();
	accountPool(pi);
	const notices = [];
	await handlers.get("agent_end")[0](
		{ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "Antigravity had an internal server error." }] },
		fakeCtx(notices),
	);
	assert.equal(existsSync(join(root, "account-pool-state.json")), false, "no state written");
	const auth = JSON.parse(readFileSync(join(root, "auth.json"), "utf8"));
	assert.equal(auth.antigravity.projectId, "proj-alpha", "still on the same account");
});

test("/pool status renders without leaking tokens", async () => {
	writeFixtures("alpha");
	const { pi, commands } = fakePi();
	accountPool(pi);
	const notices = [];
	await commands.get("pool").handler("", fakeCtx(notices));
	const text = notices[0].text;
	assert.match(text, /Antigravity account pool/);
	assert.match(text, /alpha\*\*\*@example\.com/);
	assert.ok(!/tok-alpha|proj-alpha/.test(text), "no credentials in the table");
	for (const account of Object.values(accounts)) {
		assert.ok(!text.includes(account.access), "no access token in the table");
	}
});

test("/pool disambiguates logins that share a masked prefix", async () => {
	writeFileSync(
		join(root, "antigravity-accounts.json"),
		JSON.stringify({
			version: 1,
			activeAccountId: "d1",
			accounts: {
				d1: { accountId: "d1", email: "day.one@example.com", access: "t1", projectId: "p1", lastUsedAt: NOW },
				d2: { accountId: "d2", email: "day.two@example.com", access: "t2", projectId: "p2", lastUsedAt: NOW },
				d3: { accountId: "d3", email: "day.three@example.com", access: "t3", projectId: "p3", lastUsedAt: NOW },
			},
		}, null, 2),
	);
	const { pi, commands } = fakePi();
	accountPool(pi);
	const notices = [];
	await commands.get("pool").handler("", fakeCtx(notices));
	const text = notices[0].text;
	assert.match(text, /day\.one@example\.com/, "colliding labels fall back to the full address");
	assert.match(text, /day\.two@example\.com/);
	assert.match(text, /day\.three@example\.com/);
	assert.ok(!/tok-|\bt1\b/.test(text), "still no tokens");
});

test("extension ships as a loadable directory with an index.ts", () => {
	const dir = resolve("extensions/account-pool");
	assert.ok(existsSync(join(dir, "index.ts")), "index.ts is the pi entry point");
	mkdirSync(join(root, "noop"), { recursive: true });
});

test("the installer never leaves a discoverable copy of a directory extension", () => {
	const installer = readFileSync(resolve("setup/install.sh"), "utf8");
	// Pi loads any subdirectory of extensions/ that has an index.ts, so a
	// `<name>.backup.<ts>/` sibling would register duplicate commands and hooks.
	assert.match(installer, /backups\/extensions/, "directory backups must land outside extensions/");
	const syncTree = /sync_tree\(\) \{([\s\S]*?)\n\}/.exec(installer)?.[1] ?? "";
	assert.match(syncTree, /backup_tree "\$dest"/, "sync_tree must use the out-of-tree backup");
	assert.ok(!/^\s*backup "\$dest"$/m.test(syncTree), "sync_tree must not use the in-tree file backup");
	const strays = [...readdirSync(join(process.env.HOME, ".pi/agent/extensions"), { withFileTypes: true })]
		.filter((entry) => entry.isDirectory() && entry.name.includes(".backup."))
		.map((entry) => entry.name);
	assert.deepEqual(strays, [], "installed extensions dir holds no backup copies");
});

rmSync(root, { recursive: true, force: true });

console.log(failures === 0 ? "\naccount-pool: all checks passed" : `\naccount-pool: ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
