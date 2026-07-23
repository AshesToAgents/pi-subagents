/**
 * Discover agents from installed pi packages.
 *
 * Uses DefaultPackageManager to resolve installed package directories,
 * then scans for agent .md files under `agents/` dirs (convention)
 * or paths declared in the `pi.agents` manifest field.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultPackageManager, parseFrontmatter, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface PackageAgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	packageRoot: string;
	filePath: string;
}

/**
 * Collect unique package root directories from resolved paths.
 */
function collectPackageRoots(resolved: Awaited<ReturnType<DefaultPackageManager["resolve"]>>): string[] {
	const roots = new Set<string>();

	for (const resources of [resolved.extensions, resolved.skills, resolved.prompts, resolved.themes]) {
		for (const r of resources) {
			if (r.metadata.origin === "package" && r.metadata.baseDir) {
				roots.add(r.metadata.baseDir);
			}
		}
	}

	return Array.from(roots);
}

/**
 * Read the `pi.agents` field from a package.json manifest.
 * Returns an array of glob patterns / paths, or undefined if not declared.
 */
function readAgentsManifest(packageRoot: string): string[] | undefined {
	const pkgPath = path.join(packageRoot, "package.json");
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return pkg.pi?.agents;
	} catch {
		return undefined;
	}
}

/**
 * Collect .md files from a directory, matching the same pattern as
 * collectResourceFiles in the package manager (recursive, non-dot, non-node_modules).
 */
function collectMdFiles(dir: string): string[] {
	const files: string[] = [];

	const walk = (currentDir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}

			if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
				files.push(fullPath);
			}
		}
	};

	walk(dir);
	return files;
}

/**
 * Resolve agent files for a single package.
 *
 * Priority:
 * 1. `pi.agents` manifest entries in package.json
 * 2. Convention: `agents/` directory at package root
 */
function resolvePackageAgentFiles(packageRoot: string): string[] {
	const manifestAgents = readAgentsManifest(packageRoot);
	if (manifestAgents && manifestAgents.length > 0) {
		const files: string[] = [];
		for (const entry of manifestAgents) {
			const resolved = path.resolve(packageRoot, entry);
			if (!fs.existsSync(resolved)) continue;

			try {
				const stat = fs.statSync(resolved);
				if (stat.isDirectory()) {
					files.push(...collectMdFiles(resolved));
				} else if (resolved.endsWith(".md")) {
					files.push(resolved);
				}
			} catch {
				continue;
			}
		}
		return files;
	}

	// Convention: agents/ dir at package root
	const agentsDir = path.join(packageRoot, "agents");
	if (fs.existsSync(agentsDir)) {
		try {
			if (fs.statSync(agentsDir).isDirectory()) {
				return collectMdFiles(agentsDir);
			}
		} catch {
			// ignore
		}
	}

	return [];
}

/**
 * Parse a single agent .md file into a PackageAgentConfig.
 */
function parseAgentFile(filePath: string, packageRoot: string): PackageAgentConfig | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (!frontmatter.name || !frontmatter.description) return undefined;

	const tools = frontmatter.tools
		?.split(",")
		.map((t: string) => t.trim())
		.filter(Boolean);

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		systemPrompt: body,
		packageRoot,
		filePath,
	};
}

/**
 * Discover agents from all installed pi packages.
 *
 * @param cwd - Current working directory (for project-scoped packages)
 * @param agentDir - Agent config directory (e.g. ~/.pi/agent)
 */
export async function discoverPackageAgents(cwd: string, agentDir: string): Promise<PackageAgentConfig[]> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	const resolved = await packageManager.resolve();
	const packageRoots = collectPackageRoots(resolved);

	const agents: PackageAgentConfig[] = [];

	for (const root of packageRoots) {
		const files = resolvePackageAgentFiles(root);
		for (const file of files) {
			const agent = parseAgentFile(file, root);
			if (agent) agents.push(agent);
		}
	}

	return agents;
}