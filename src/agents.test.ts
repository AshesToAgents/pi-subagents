import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Use hoisted to ensure this is evaluated at runtime, not module load time
const { setTmpDir, getMockModule } = vi.hoisted(() => {
	// Global storage for per-test tmpDir
	let currentTmpDir: string = "";

	const parseFn = (content: string) => {
		const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return { frontmatter: {}, body: content };
		const yamlContent = match[1];
		const body = match[2];
		const frontmatter: Record<string, string> = {};
		for (const line of yamlContent.split("\n")) {
			const colonIndex = line.indexOf(":");
			if (colonIndex > 0) {
				const key = line.slice(0, colonIndex).trim();
				const value = line.slice(colonIndex + 1).trim();
				frontmatter[key] = value;
			}
		}
		return { frontmatter, body };
	};

	function MockPackageManager(this: any) {
		this.resolve = vi.fn().mockResolvedValue({
			extensions: [],
			skills: [],
			prompts: [],
			themes: [],
		});
	}

	function setTmpDir(d: string) {
		currentTmpDir = d;
	}

	function getMockModule() {
		return {
			getAgentDir: vi.fn(() => path.join(currentTmpDir, "agent")),
			parseFrontmatter: vi.fn(parseFn),
			DefaultPackageManager: MockPackageManager,
			SettingsManager: {
				create: vi.fn().mockImplementation(() => ({})),
			},
		};
	}

	return { setTmpDir, getMockModule };
});

// Mock the module
vi.mock("@earendil-works/pi-coding-agent", () => getMockModule());

// Import after mocking
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { isTopLevelAgent, formatAgentList, type AgentConfig, discoverAgents } from "./agents.js";

describe("isTopLevelAgent", () => {
	it("returns true when agent file is directly in rootDir", () => {
		const agent: AgentConfig = {
			name: "test",
			description: "test agent",
			systemPrompt: "Do things",
			source: "user",
			filePath: "/root/agents/implementer.md",
			rootDir: "/root/agents",
		};
		expect(isTopLevelAgent(agent)).toBe(true);
	});

	it("returns false when agent file is in a subdirectory", () => {
		const agent: AgentConfig = {
			name: "test",
			description: "test agent",
			systemPrompt: "Do things",
			source: "user",
			filePath: "/root/agents/subdir/implementer.md",
			rootDir: "/root/agents",
		};
		expect(isTopLevelAgent(agent)).toBe(false);
	});
});

describe("formatAgentList", () => {
	it("returns 'none' for empty array", () => {
		const result = formatAgentList([], 10);
		expect(result.text).toBe("none");
		expect(result.remaining).toBe(0);
	});

	it("formats agents correctly within limit", () => {
		const agents: AgentConfig[] = [
			{ name: "alpha", description: "Alpha agent", systemPrompt: "", source: "user", filePath: "", rootDir: "" },
			{ name: "beta", description: "Beta agent", systemPrompt: "", source: "project", filePath: "", rootDir: "" },
		];
		const result = formatAgentList(agents, 10);
		expect(result.text).toContain("alpha (user): Alpha agent");
		expect(result.text).toContain("beta (project): Beta agent");
		expect(result.remaining).toBe(0);
	});

	it("indicates remaining count when truncated", () => {
		const agents: AgentConfig[] = [
			{ name: "a", description: "A", systemPrompt: "", source: "user", filePath: "", rootDir: "" },
			{ name: "b", description: "B", systemPrompt: "", source: "user", filePath: "", rootDir: "" },
			{ name: "c", description: "C", systemPrompt: "", source: "user", filePath: "", rootDir: "" },
		];
		const result = formatAgentList(agents, 2);
		expect(result.remaining).toBe(1);
	});
});

describe("discoverAgents", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
		// Create agent dir structure
		fs.mkdirSync(path.join(tmpDir, "agent", "agents"), { recursive: true });

		// Update the mock to use current tmpDir
		setTmpDir(tmpDir);
		vi.mocked(piCodingAgent.getAgentDir).mockImplementation(() => path.join(tmpDir, "agent"));

		// Reset all mocks
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns empty array when no agents exist", async () => {
		const result = await discoverAgents(tmpDir, "user");
		expect(result.agents).toEqual([]);
	});

	it("discovers agent files from user agents directory", async () => {
		const agentsDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(agentsDir, "implementer.md"),
			"---\nname: implementer\ndescription: test agent\n---\nDo things."
		);

		const result = await discoverAgents(tmpDir, "user");
		expect(result.agents.length).toBeGreaterThan(0);
		expect(result.agents[0].name).toBe("implementer");
	});

	it("discovers nested agent files recursively", async () => {
		const nestedDir = path.join(tmpDir, "agent", "agents", "subdir");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(
			path.join(nestedDir, "nested-agent.md"),
			"---\nname: nested\ndescription: nested agent\n---\nNested task."
		);

		const result = await discoverAgents(tmpDir, "user");
		const nestedAgent = result.agents.find((a) => a.name === "nested");
		expect(nestedAgent).toBeDefined();
	});

	it("respects scope - only returns user agents", async () => {
		const userDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(userDir, "user-agent.md"),
			"---\nname: user-agent\ndescription: user agent\n---\nUser task."
		);

		// Create project agents dir
		const projectDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: project agent\n---\nProject task."
		);

		const result = await discoverAgents(tmpDir, "user");
		expect(result.agents.map((a) => a.name)).toEqual(["user-agent"]);
	});

	it("respects scope - only returns project agents", async () => {
		const userDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(userDir, "user-agent.md"),
			"---\nname: user-agent\ndescription: user agent\n---\nUser task."
		);

		const projectDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: project agent\n---\nProject task."
		);

		const result = await discoverAgents(tmpDir, "project");
		expect(result.agents.map((a) => a.name)).toEqual(["project-agent"]);
	});

	it("returns both user and project agents in 'all' scope", async () => {
		const userDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(userDir, "user-agent.md"),
			"---\nname: user-agent\ndescription: user agent\n---\nUser task."
		);

		const projectDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: project agent\n---\nProject task."
		);

		const result = await discoverAgents(tmpDir, "all");
		expect(result.agents.map((a) => a.name).sort()).toEqual(["project-agent", "user-agent"]);
	});

	it("skips files without frontmatter name/description", async () => {
		const agentsDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(path.join(agentsDir, "valid.md"), "---\nname: valid\ndescription: valid agent\n---\nValid.");
		fs.writeFileSync(path.join(agentsDir, "invalid.md"), "---\nname: invalid\n---\nMissing description.");
		fs.writeFileSync(path.join(agentsDir, "no-frontmatter.md"), "No frontmatter at all.");

		const result = await discoverAgents(tmpDir, "user");
		const names = result.agents.map((a) => a.name);
		expect(names).toContain("valid");
		expect(names).not.toContain("invalid");
		expect(names).not.toContain("no-frontmatter");
	});

	it("parses tools from frontmatter", async () => {
		const agentsDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(agentsDir, "tool-agent.md"),
			"---\nname: tool-agent\ndescription: agent with tools\ntools: read, bash, edit\n---\nTask with tools."
		);

		const result = await discoverAgents(tmpDir, "user");
		const agent = result.agents.find((a) => a.name === "tool-agent");
		expect(agent?.tools).toEqual(["read", "bash", "edit"]);
	});

	it("parses model from frontmatter", async () => {
		const agentsDir = path.join(tmpDir, "agent", "agents");
		fs.writeFileSync(
			path.join(agentsDir, "model-agent.md"),
			"---\nname: model-agent\ndescription: agent with model\nmodel: gpt-4\n---\nTask with model."
		);

		const result = await discoverAgents(tmpDir, "user");
		const agent = result.agents.find((a) => a.name === "model-agent");
		expect(agent?.model).toBe("gpt-4");
	});

	it("returns projectAgentsDir when project agents exist", async () => {
		const projectDir = path.join(tmpDir, ".pi", "agents");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: project agent\n---\nProject task."
		);

		const result = await discoverAgents(tmpDir, "project");
		expect(result.projectAgentsDir).toBe(projectDir);
	});

	it("returns null projectAgentsDir when no project agents", async () => {
		const result = await discoverAgents(tmpDir, "project");
		expect(result.projectAgentsDir).toBeNull();
	});
});