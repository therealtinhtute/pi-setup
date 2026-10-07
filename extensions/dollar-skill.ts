import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadSkills, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SkillItem {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

let cachedSkills: Array<SkillItem> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5000;

function discoverSkillPaths(cwd: string): string[] {
	const paths: string[] = [];
	const userAgents = join(homedir(), ".agents", "skills");
	if (existsSync(userAgents)) paths.push(userAgents);
	let cur = cwd;
	while (true) {
		const proj = join(cur, ".agents", "skills");
		if (proj !== userAgents && existsSync(proj)) paths.push(proj);
		const parent = dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return paths;
}

function refreshSkillsCache(cwd: string) {
	try {
		const skillPaths = discoverSkillPaths(cwd);
		const result = loadSkills({
			cwd,
			agentDir: getAgentDir(),
			skillPaths,
			includeDefaults: true,
		});
		cachedSkills = result.skills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
			baseDir: s.baseDir,
		}));
		lastCacheTime = Date.now();
	} catch {
		cachedSkills = cachedSkills || [];
	}
	return cachedSkills;
}

function getSkills(cwd: string): SkillItem[] {
	if (!cachedSkills || Date.now() - lastCacheTime > CACHE_TTL_MS) {
		return refreshSkillsCache(cwd);
	}
	return cachedSkills;
}

function isKnownSkill(cwd: string, skillName: string): boolean {
	const normalized = skillName.toLowerCase();
	let list = getSkills(cwd);
	if (list.some((s) => s.name.toLowerCase() === normalized)) return true;
	list = refreshSkillsCache(cwd);
	return list.some((s) => s.name.toLowerCase() === normalized);
}

export default function dollarSkillExtension(pi: ExtensionAPI) {
	// 1. Hook input: Chuyển $skill [args] hoặc pipeline $skill1 -> $skill2 [args]
	pi.on("input", async (event, ctx) => {
		const trimmed = event.text.trim();
		if (!trimmed.startsWith("$")) {
			return { action: "continue" };
		}

		// A. Kiểm tra chuỗi pipeline: vd "$think -> $work", "$think ➔ $work", "$think | $work"
		const pipelineRegex = /^(\$[a-zA-Z0-9-]+(?:\s*(?:->|➔|=>|\|)\s*\$[a-zA-Z0-9-]+)+)(?:\s+([\s\S]*))?$/;
		const pipeMatch = trimmed.match(pipelineRegex);
		if (pipeMatch) {
			const chain = pipeMatch[1];
			const userMessage = pipeMatch[2]?.trim() || "";
			const names = chain.split(/\s*(?:->|➔|=>|\|)\s*/).map((s) => s.replace(/^\$/, ""));
			const allSkills = getSkills(ctx.cwd);
			const found = names.map((n) => allSkills.find((s) => s.name.toLowerCase() === n.toLowerCase()));

			if (found.every(Boolean)) {
				const stages: string[] = [];
				for (let i = 0; i < found.length; i++) {
					const s = found[i]!;
					let content = "";
					try {
						content = readFileSync(s.filePath, "utf-8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
					} catch {
						content = s.description;
					}
					stages.push(`## Stage ${i + 1}: ${s.name}\nReferences are relative to ${s.baseDir}.\n\n${content}`);
				}
				const pipelineName = names.join(" ➔ ");
				const combinedContent = `# Pipeline: ${pipelineName}\n\nExecute the following skills sequentially as stages in a pipeline:\n\n${stages.join("\n\n---\n\n")}`;
				const transformed = `<skill name="${pipelineName}" location="Pipeline: ${pipelineName}">\n${combinedContent}\n</skill>${userMessage ? `\n\n${userMessage}` : ""}`;
				return { action: "transform", text: transformed };
			}
		}

		// B. Single skill: $skill [args]
		const withoutDollar = trimmed.slice(1).trim();
		if (!withoutDollar) {
			return { action: "continue" };
		}

		const spaceIndex = withoutDollar.indexOf(" ");
		const rawTarget = spaceIndex === -1 ? withoutDollar : withoutDollar.slice(0, spaceIndex);
		const args = spaceIndex === -1 ? "" : withoutDollar.slice(spaceIndex + 1).trim();

		const skillName = rawTarget.startsWith("skill:") ? rawTarget.slice(6) : rawTarget;

		if (isKnownSkill(ctx.cwd, skillName)) {
			return {
				action: "transform",
				text: `/skill:${skillName}${args ? ` ${args}` : ""}`,
			};
		}

		return { action: "continue" };
	});

	// 2. Hook Autocomplete TUI khi gõ $
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider((baseProvider) => ({
			triggerCharacters: [...(baseProvider.triggerCharacters || []), "$"],

			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				const trimmedBefore = textBeforeCursor.trimStart();

				if (trimmedBefore.startsWith("$")) {
					const spaceIndex = trimmedBefore.indexOf(" ");
					// Chỉ gợi ý khi đang gõ tên skill (chưa qua dấu cách)
					if (spaceIndex === -1) {
						const query = trimmedBefore.slice(1).toLowerCase();
						const skills = getSkills(ctx.cwd);

						const matches = skills
							.filter((s) => s.name.toLowerCase().includes(query))
							.map((s) => ({
								value: `$${s.name}`,
								label: `$${s.name}`,
								description: s.description,
							}));

						if (matches.length > 0) {
							return {
								items: matches,
								prefix: trimmedBefore,
							};
						}
						return null;
					}
				}

				return baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (prefix.startsWith("$")) {
					const currentLine = lines[cursorLine] || "";
					const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
					const afterCursor = currentLine.slice(cursorCol);
					const newLine = `${beforePrefix}${item.value} ${afterCursor}`;
					const newLines = [...lines];
					newLines[cursorLine] = newLine;

					return {
						lines: newLines,
						cursorLine,
						cursorCol: beforePrefix.length + item.value.length + 1,
					};
				}
				return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				if (textBeforeCursor.trim().startsWith("$") && !textBeforeCursor.trim().includes(" ")) {
					return false;
				}
				return baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
