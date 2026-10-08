// Offline static check. With no local TypeScript: npm exec --package=typescript@5.9.3 -- node scripts/typecheck-decision-compact.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases",
	readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const require = createRequire(import.meta.url);
const candidates = [process.env.PI_TYPESCRIPT && join(process.env.PI_TYPESCRIPT, "lib/typescript.js"),
	resolve("node_modules/typescript/lib/typescript.js"), join(modules, "typescript/lib/typescript.js")];
for (const directory of (process.env.PATH || "").split(":")) {
	const tsc = join(directory, "tsc");
	if (existsSync(tsc)) candidates.push(join(dirname(realpathSync(tsc)), "../lib/typescript.js"));
}
const compiler = candidates.find((path) => path && existsSync(path));
if (!compiler) throw new Error("TypeScript not found. Use the npm exec command in this file, or set PI_TYPESCRIPT to a TypeScript package directory.");
const ts = require(compiler);
const paths = Object.fromEntries(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"]
	.map((name) => [name, [join(modules, name, "dist/index.d.ts")]]));
const program = ts.createProgram([resolve("extensions/decision-compact.ts")], {
	strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler,
	noEmit: true, allowImportingTsExtensions: true, types: ["node"], typeRoots: [join(modules, "@types")], paths,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
	console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (path) => path, getNewLine: () => "\n",
	}));
	process.exitCode = 1;
} else console.log(`PASS strict TypeScript ${ts.version}: extensions/decision-compact.ts (dependency declarations skipLibCheck)`);
