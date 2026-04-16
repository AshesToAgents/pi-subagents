/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { discoverPackageAgents, type PackageAgentConfig } from "./package-agents.js";

export type AgentScope = "user" | "project" | "package" | "all";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "package";
	filePath: string;
	rootDir: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	const walk = (currentDir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				walk(fullPath);
				continue;
			}

			if (!entry.name.endsWith(".md")) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			let content: string;
			try {
				content = fs.readFileSync(fullPath, "utf-8");
			} catch {
				continue;
			}

			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

			if (!frontmatter.name || !frontmatter.description) {
				continue;
			}

			const tools = frontmatter.tools
				?.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean);

			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools && tools.length > 0 ? tools : undefined,
				model: frontmatter.model,
				systemPrompt: body,
				source,
				filePath: fullPath,
				rootDir: dir,
			});
		}
	};

	walk(dir);
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function toAgentConfig(pkgAgent: PackageAgentConfig): AgentConfig {
	return {
		name: pkgAgent.name,
		description: pkgAgent.description,
		tools: pkgAgent.tools,
		model: pkgAgent.model,
		systemPrompt: pkgAgent.systemPrompt,
		source: "package",
		filePath: pkgAgent.filePath,
		rootDir: pkgAgent.packageRoot,
	};
}

export async function discoverAgents(cwd: string, scope: AgentScope): Promise<AgentDiscoveryResult> {
	const agentDir = getAgentDir();
	const userDir = path.join(agentDir, "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "user" || scope === "all" ? loadAgentsFromDir(userDir, "user") : [];
	const projectAgents = (scope === "project" || scope === "all") && projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];
	const packageAgents = scope === "package" || scope === "all" ? (await discoverPackageAgents(cwd, agentDir)).map(toAgentConfig) : [];

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "all") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
		for (const agent of packageAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else if (scope === "project") {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "package") {
		for (const agent of packageAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function isTopLevelAgent(agent: AgentConfig): boolean {
	return path.dirname(agent.filePath) === agent.rootDir;
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}