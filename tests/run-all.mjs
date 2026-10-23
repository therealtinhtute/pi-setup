#!/usr/bin/env node
// Run every test in this directory. Each file is a standalone script that prints
// PASS and exits 0, or throws and exits non-zero.
//
//   node tests/run-all.mjs
//
// Pi's runtime modules are located automatically (installer layout, or a global
// package install such as Homebrew/mise/nvm). Override with PI_NODE_MODULES.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
	.filter((f) => f.startsWith("test-") && f.endsWith(".mjs"))
	.sort();

if (files.length === 0) {
	console.error("no test-*.mjs files found in", here);
	process.exit(1);
}

let failed = 0;
for (const file of files) {
	const started = Date.now();
	const run = spawnSync(process.execPath, [join(here, file)], { encoding: "utf8" });
	const ms = Date.now() - started;
	const ok = run.status === 0;
	if (!ok) failed += 1;
	const label = file.padEnd(30);
	if (ok) {
		console.log(`  ok   ${label} ${ms}ms`);
	} else {
		console.log(`  FAIL ${label} ${ms}ms`);
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd();
		for (const line of output.split("\n").slice(0, 25)) console.log(`       ${line}`);
	}
}

console.log("");
if (failed) {
	console.log(`${failed} of ${files.length} test files failed`);
	process.exit(1);
}
console.log(`all ${files.length} test files passed`);
