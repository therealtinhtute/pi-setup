// Locate the node_modules trees that hold pi's own runtime (@earendil-works/* and jiti).
//
// The tests drive real extension TypeScript through jiti with pi's packages aliased in,
// so they need those exact files. pi ships in two layouts, and the files are not all
// in one directory:
//
//   1. Installer layout (~/.pi/agent/install): releases/<version>/node_modules holds
//      everything flat.
//   2. A global package install (Homebrew, mise, nvm, npm -g): @earendil-works/
//      pi-coding-agent/ sits in <prefix>/lib/node_modules, while pi-tui and jiti live
//      in that package's own nested node_modules.
//
// So each required file is resolved independently across every candidate root.
// Override the search with PI_NODE_MODULES=/path/to/node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const installDir = join(homedir(), ".pi/agent/install");

function fromInstallerLayout() {
	const versionFile = join(installDir, "current-version");
	if (!existsSync(versionFile)) return [];
	const version = readFileSync(versionFile, "utf8").trim();
	return [join(installDir, "releases", version, "node_modules")];
}

function fromPiBinary() {
	let bin;
	try {
		bin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
	} catch {
		return [];
	}
	if (!bin) return [];
	// <prefix>/bin/pi is usually a symlink into the package, so follow it first.
	let real;
	try {
		real = realpathSync(bin);
	} catch {
		real = resolve(bin);
	}
	const marker = join("@earendil-works", "pi-coding-agent");
	const at = real.indexOf(marker);
	if (at === -1) return [];
	const packageDir = real.slice(0, at + marker.length);
	// <prefix>/lib/node_modules resolves pi-coding-agent itself; the package's own
	// node_modules holds pi-tui and jiti, which are not hoisted next to it.
	return [dirname(dirname(packageDir)), packageDir, join(packageDir, "node_modules")];
}

const roots = [
	...(process.env.PI_NODE_MODULES ? [process.env.PI_NODE_MODULES] : []),
	...fromInstallerLayout(),
	...fromPiBinary(),
].filter((root, index, all) => all.indexOf(root) === index);

/** First root containing `rel`, or undefined. */
function find(rel) {
	return roots.find((root) => existsSync(join(root, rel)));
}

function require(rel, label) {
	const root = find(rel);
	if (!root) {
		console.error(
			[
				`Cannot find ${label} (${rel}). Searched:`,
				...roots.map((root) => `  - ${root}`),
				"",
				"Point the tests at the right tree:",
				"  PI_NODE_MODULES=/path/to/node_modules node tests/test-rewind.mjs",
			].join("\n"),
		);
		process.exit(1);
	}
	return join(root, rel);
}

const piCodingAgent = "@earendil-works/pi-coding-agent";
const piTui = "@earendil-works/pi-tui";

export const piAgentEntry = require(join(piCodingAgent, "dist/index.js"), "pi-coding-agent");
export const piTuiEntry = require(join(piTui, "dist/index.js"), "pi-tui");
export const jitiEntry = require("jiti/lib/jiti.mjs", "jiti");

/** Aliases every jiti instance in these tests needs. */
export const piAliases = {
	[piCodingAgent]: piAgentEntry,
	[piTui]: piTuiEntry,
};

/** Absolute path to a file inside pi's packages (name is the @earendil-works subpackage). */
export const pkgFile = (name, file) => {
	const rel = join("@earendil-works", name, file);
	const root = find(rel);
	if (!root) throw new Error(`cannot locate @earendil-works/${name}/${file} in ${roots.join(", ")}`);
	return join(root, rel);
};

export const load = (file) => import(new URL(`file://${file}`).href);

/** `stat -c` is GNU-only; macOS BSD stat spells the permission format `-f %Lp`. */
export function fileMode(file) {
	try {
		return execFileSync("stat", ["-c", "%a", file], { encoding: "utf8" }).trim();
	} catch {
		return execFileSync("stat", ["-f", "%Lp", file], { encoding: "utf8" }).trim();
	}
}

/** Repo root, resolved from this file's location (tests/lib/ -> ..). */
export const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
