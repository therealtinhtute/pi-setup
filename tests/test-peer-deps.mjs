// Run: node tests/test-peer-deps.mjs
// Pure file checks: no installation, credentials, or network calls.
//
// Some packages import a dependency they only declare as a *peer*. npm does not
// install peers transitively and pi's package manager does not either, so the
// extension dies with "Cannot find module" at load and its tool silently never
// registers — no error in the TUI, the tool just is not there.
//
// `@juicesharp/rpiv-ask-user-question` needs `typebox` exactly this way: without
// it `ask_user_question` disappears, which is invisible until you need to ask the
// user something. This test keeps install.sh installing it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const settings = JSON.parse(read("config/settings.json"));
const sources = settings.packages.map((entry) => (typeof entry === "string" ? entry : entry.source));

// Every package listed here declares one of these as a peerDependency, so its
// module graph cannot load until the peer is installed next to it.
const PEER_REQUIRED = [
	{ matches: /rpiv-ask-user-question/, peer: "typebox" },
	{ matches: /rpiv-todo/, peer: "typebox" },
];

const needed = new Set();
for (const source of sources) {
	for (const rule of PEER_REQUIRED) if (rule.matches.test(source)) needed.add(rule.peer);
}

if (needed.size === 0) {
	console.log("PASS: no peer-dependent package selected, nothing to install");
	process.exit(0);
}

const install = read("setup/install.sh");

// install.sh must know the mapping and actually install into pi's npm tree.
for (const peer of needed) {
	assert(
		install.includes(peer),
		`install.sh must install the ${peer} peer dependency (a selected package imports it but only declares it as a peer)`,
	);
}
assert(/npm install[^\n]*"\$spec"/.test(install), "install.sh must run npm install for the peer dependency");
assert(
	install.includes("PEER_DIR=\"$PI_DIR/npm\"") || install.includes("PEER_DIR=$PI_DIR/npm"),
	"the peer must be installed into pi's own npm tree ($PI_DIR/npm), not a scratch dir",
);
assert(
	/settings\.json/.test(install) && /packages/.test(install),
	"install.sh must derive the peer list from the selected packages, not hardcode it for every user",
);

// The version has to match the copy pi bundles: two TypeBox schema builders in
// one process means the registered parameter schema is not the one pi validates
// against, and the tool registers but never reaches the model.
assert(
	/pi_bundled_typebox_version/.test(install) || /pi_bundled_.*_version/.test(install),
	"install.sh must pin the peer to the version pi already bundles rather than taking npm's latest",
);

// The package that needs it must be present, otherwise this test is dead weight.
assert(
	sources.some((source) => /rpiv-ask-user-question/.test(source)),
	"the ask-user-question package must stay selected while this guard exists",
);

console.log(`PASS: peer dependencies installed by setup/install.sh (${[...needed].join(", ")})`);
