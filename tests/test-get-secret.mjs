#!/usr/bin/env node
// get-secret.sh contract: the exported variable wins over the env file, so a one-off
// `HIVE_API_KEY=... pi` overrides the stored key without editing ~/.env. Anything that
// reads a secret through this script relies on that precedence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fileMode } from "./lib/pi-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, "../scripts/get-secret.sh");
assert(existsSync(script), `missing ${script}`);
// Git only records the executable bit, so a checkout is 755 no matter what. The
// secret-printer contract (mode 700) is enforced where it takes effect: install.sh
// chmods the destination, which is what pi actually invokes.
assert.equal(fileMode(script), "755",
	"get-secret.sh must be executable in the repo (git only stores 755)");
const installed = join(process.env.HOME ?? "", ".pi/agent/scripts/get-secret.sh");
if (existsSync(installed)) {
	assert.equal(fileMode(installed), "700",
		"the installed get-secret.sh must be mode 700: it prints a secret");
}

const dir = mkdtempSync(join(tmpdir(), "get-secret-test-"));
const envFile = join(dir, "env");
writeFileSync(envFile, [
	"FROM_FILE=file-value",
	'QUOTED="quoted-value"',
	"SINGLE='single-value'",
	"EMPTY=",
	"ALSO_FILE=shadowed",
	"",
].join("\n"));
chmodSync(envFile, 0o600);

/** Run the script with a controlled environment (no inherited secrets). */
function run(args, env = {}) {
	const base = { PATH: process.env.PATH, HOME: dir };
	try {
		const out = execFileSync("sh", [script, ...args], {
			env: { ...base, ...env },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out: out.replace(/\n$/, "") };
	} catch (error) {
		return { code: error.status ?? -1, out: String(error.stdout ?? "").trim() };
	}
}

try {
	// 1. The exported variable wins.
	assert.equal(run(["ALSO_FILE", envFile], { ALSO_FILE: "env-value" }).out, "env-value",
		"an exported variable must win over the env file");

	// 2. Without it, the file is used.
	assert.equal(run(["ALSO_FILE", envFile]).out, "shadowed", "the env file is the fallback");

	// 3. Quotes are stripped, in both styles.
	assert.equal(run(["QUOTED", envFile]).out, "quoted-value", "double quotes are stripped");
	assert.equal(run(["SINGLE", envFile]).out, "single-value", "single quotes are stripped");

	// 4. An exported empty string counts as unset, so the file still answers.
	assert.equal(run(["FROM_FILE", envFile], { FROM_FILE: "" }).out, "file-value",
		"an empty exported value must fall through to the file");

	// 5. A variable that is neither exported nor in the file prints nothing.
	assert.equal(run(["NOPE", envFile]).out, "", "a missing key prints nothing");
	assert.equal(run(["NOPE", envFile]).out, "", "a missing key does not leak the file contents");

	// 6. Bad names are rejected before they reach sed, so they cannot act as a regex.
	for (const bad of ["", "bad-key", "1LEADING", "with space", "a/b"]) {
		assert.equal(run([bad, envFile]).code, 2, `key ${JSON.stringify(bad)} must be rejected with exit 2`);
	}

	// 7. No key and no file is exit 3, not a silent empty success.
	assert.equal(run(["MISSING"], { HOME: join(dir, "nope") }).code, 3, "a missing env file is exit 3");

	// 8. The default path is $HOME/.env, the file the setup documents.
	const homeEnv = join(dir, ".env");
	writeFileSync(homeEnv, "DEFAULT_PATH=from-default\n");
	chmodSync(homeEnv, 0o600);
	assert.equal(run(["DEFAULT_PATH"], { HOME: dir }).out, "from-default", "the default file is $HOME/.env");

	console.log("PASS: get-secret.sh — env wins, file falls back, quotes stripped, bad names rejected");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
