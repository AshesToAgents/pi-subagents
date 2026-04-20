/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ModelRegistry,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	getMarkdownTheme,
	truncateTail,
} from "@mariozechner/pi-coding-agent";

function readSettings(): Record<string, any> {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	try {
		return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return {};
	}
}

function writeSetting(key: string, value: string): void {
	const settingsPath = path.join(getAgentDir(), "settings.json");
	const settings = readSettings();
	settings[key] = value;
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Resolve an agent's model field to a concrete "provider/modelId" string.
 *
 * - undefined / "" → undefined (let pi pick default)
 * - "parent"       → same model as the parent agent
 * - "fast"/"smart" → model alias from settings.json (fastModel/smartModel)
 * - "provider/id"  → passed through as-is
 * - "modelId"      → prefixed with current provider
 */
function resolveModel(
	agentModel: string | undefined,
	currentModel: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
): string | undefined {
	if (!agentModel) return undefined;

	const key = agentModel.trim().toLowerCase();

	if (key === "parent") {
		if (!currentModel) return undefined;
		return `${currentModel.provider}/${currentModel.id}`;
	}

	if (key === "fast" || key === "smart") {
		const settings = readSettings();
		const settingKey = key === "fast" ? "fastModel" : "smartModel";
		const configuredModel = typeof settings[settingKey] === "string" ? settings[settingKey].trim() : "";
		return resolveModel(configuredModel || "parent", currentModel, modelRegistry);
	}

	// Already has provider prefix
	if (agentModel.includes("/")) return agentModel;

	// Bare model ID — try to find it under the current provider first
	if (currentModel && modelRegistry) {
		const found = modelRegistry.find(currentModel.provider, agentModel);
		if (found) return `${currentModel.provider}/${agentModel}`;
	}

	return agentModel;
}
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents, isTopLevelAgent } from "./agents.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

const CHILD_PROCESS_ENV_FLAG = "PI_SUBAGENT_CHILD";
const EXTENSION_TOOLS_FLAG = "extension-tools";
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const DEFAULT_AGENT_SCOPE: AgentScope = "all";
const SYSTEM_PROMPT_AGENT_OVERVIEW_LIMIT = 12;

type AgentInfoDetail = "summary" | "full";

function parseToolList(value: string | boolean | undefined): Set<string> {
	if (typeof value !== "string") return new Set();
	return new Set(
		value
			.split(",")
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean),
	);
}

function getToolPolicy(agent: AgentConfig): {
	builtinToolsForCli: string[] | undefined;
	extensionToolsForCli: string | undefined;
} {
	if (!agent.tools || agent.tools.length === 0) {
		return { builtinToolsForCli: undefined, extensionToolsForCli: undefined };
	}

	const normalized = agent.tools.map((t) => t.trim().toLowerCase()).filter(Boolean);
	if (normalized.includes("all")) {
		return {
			builtinToolsForCli: undefined,
			extensionToolsForCli: "all",
		};
	}

	const builtinToolsForCli = normalized.filter((name) => BUILTIN_TOOLS.has(name));
	const extensionTools = normalized.filter((name) => !BUILTIN_TOOLS.has(name));

	return {
		builtinToolsForCli: builtinToolsForCli.length > 0 ? builtinToolsForCli : undefined,
		extensionToolsForCli: extensionTools.length > 0 ? extensionTools.join(",") : undefined,
	};
}

function sortAgentsByName(agents: AgentConfig[]): AgentConfig[] {
	return [...agents].sort((a, b) => a.name.localeCompare(b.name));
}

function formatAgentSummaryList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}

function formatAgentFullList(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents
		.map((a) => {
			const lines = [
				`- ${a.name}: ${a.description}`,
				`  source: ${a.source}`,
				`  model: ${a.model ?? "(default)"}`,
				`  tools: ${a.tools?.join(", ") ?? "(all default tools)"}`,
				`  path: ${a.filePath}`,
			];
			return lines.join("\n");
		})
		.join("\n\n");
}

async function buildSubagentAgentsReport(cwd: string, agentScope: AgentScope, detail: AgentInfoDetail): Promise<{
	text: string;
	discovery: Awaited<ReturnType<typeof discoverAgents>>;
	agents: AgentConfig[];
}> {
	const discovery = await discoverAgents(cwd, agentScope);
	const agents = sortAgentsByName(discovery.agents);

	const header = `Available subagents: ${agents.length} (scope: ${agentScope})`;
	const body = detail === "full" ? formatAgentFullList(agents) : formatAgentSummaryList(agents);
	const hint =
		detail === "summary"
			? '\n\nTip: use detail="full" for source/model/tools/path.'
			: "";
	const projectDir = discovery.projectAgentsDir ? `\nProject agents dir: ${discovery.projectAgentsDir}` : "";

	return {
		text: `${header}\n\n${body}${hint}${projectDir}`,
		discovery,
		agents,
	};
}

async function buildSubagentOverviewForPrompt(cwd: string): Promise<string> {
	const discovery = await discoverAgents(cwd, DEFAULT_AGENT_SCOPE);
	const topLevelAgents = sortAgentsByName(discovery.agents.filter((a) => isTopLevelAgent(a)));

	if (topLevelAgents.length === 0) {
		return [
			"## Available subagents",
			"No top-level subagents are currently discovered.",
			"If needed, call the `subagent_agents` tool for the full list (including nested agent files).",
		].join("\n");
	}

	const listed = topLevelAgents.slice(0, SYSTEM_PROMPT_AGENT_OVERVIEW_LIMIT);
	const remaining = topLevelAgents.length - listed.length;
	const moreLine = remaining > 0 ? `\n- ... and ${remaining} more top-level agents (call subagent_agents for full list)` : "";

	return [
		"## Available subagents (overview)",
		"Use the `subagent` tool with one of these agent names.",
		"This overview is intentionally compact and only includes top-level agents (names + descriptions).",
		"",
		listed.map((a) => `- ${a.name}: ${a.description}`).join("\n") + moreLine,
		"",
		'If you need more details, call `subagent_agents` (supports `agentScope: "user" | "project" | "package" | "all"`, default `"all"`).',
	].join("\n");
}

function parseSubagentsCommandArgs(args: string): { agentScope: AgentScope; detail: AgentInfoDetail; error?: string } {
	const tokens = args
		.toLowerCase()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean);

	let agentScope: AgentScope = DEFAULT_AGENT_SCOPE;
	let detail: AgentInfoDetail = "summary";

	for (const token of tokens) {
		if (token === "user" || token === "project" || token === "package" || token === "all") {
			agentScope = token;
			continue;
		}
		if (token === "summary") {
			detail = "summary";
			continue;
		}
		if (token === "full" || token === "verbose") {
			detail = "full";
			continue;
		}
		return {
			agentScope,
			detail,
			error: `Unknown argument: ${token}. Use scope {user|project|package|all} and optional {summary|full}.`,
		};
	}

	return { agentScope, detail };
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function renderFullPath(details: SubagentDetails | undefined, theme: any): string {
	if (!details?.fullOutputPath) return "";
	return `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "package" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	fullOutputPath?: string; // path to temp file with untruncated output, if truncation occurred
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

/**
 * If the text exceeds DEFAULT_MAX_BYTES or DEFAULT_MAX_LINES, write it to a
 * temp file and return a truncated version with a notice pointing to the file.
 * Otherwise return the text unchanged.
 */
function processToolResultOutput(text: string): { displayText: string; fullOutputPath?: string } {
	const outputBytes = Buffer.byteLength(text, "utf-8");
	const outputLines = text.split("\n").length;

	if (outputBytes <= DEFAULT_MAX_BYTES && outputLines <= DEFAULT_MAX_LINES) {
		return { displayText: text };
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-output-"));
	const fullPath = path.join(tmpDir, "output.md");
	fs.writeFileSync(fullPath, text, { encoding: "utf-8", mode: 0o600 });

	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const truncatedLines = truncation.totalLines - truncation.outputLines;
	const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

	let displayText = truncation.content;
	displayText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	displayText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
	displayText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
	displayText += ` Full output saved to: ${fullPath}]`;

	return { displayText, fullOutputPath: fullPath };
}

/**
 * For parallel mode: truncate each agent's output proportionally rather than
 * truncating the combined string (which would cut off early agents entirely).
 * Writes the full combined output to a temp file.
 */
function processParallelOutput(
	agentOutputs: Array<{ agent: string; exitCode: number; output: string }>,
	successCount: number,
): { displayText: string; fullOutputPath?: string } {
	const fullSections = agentOutputs.map((a) => {
		const status = a.exitCode === 0 ? "completed" : "failed";
		return `[${a.agent}] ${status}:\n${a.output || "(no output)"}`;
	});
	const fullText = `Parallel: ${successCount}/${agentOutputs.length} succeeded\n\n${fullSections.join("\n\n")}`;

	const outputBytes = Buffer.byteLength(fullText, "utf-8");
	const outputLines = fullText.split("\n").length;

	if (outputBytes <= DEFAULT_MAX_BYTES && outputLines <= DEFAULT_MAX_LINES) {
		return { displayText: fullText };
	}

	// Write full output to temp file
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-output-"));
	const fullPath = path.join(tmpDir, "output.md");
	fs.writeFileSync(fullPath, fullText, { encoding: "utf-8", mode: 0o600 });

	// Budget: divide limits equally among agents
	const budgetBytes = Math.floor(DEFAULT_MAX_BYTES / agentOutputs.length);
	const budgetLines = Math.floor(DEFAULT_MAX_LINES / agentOutputs.length);

	const truncatedSections = agentOutputs.map((a) => {
		const status = a.exitCode === 0 ? "completed" : "failed";
		const header = `[${a.agent}] ${status}:\n`;
		const headerBytes = Buffer.byteLength(header, "utf-8");
		const availableBytes = Math.max(0, budgetBytes - headerBytes);

		if (!a.output || a.output === "(no output)") {
			return header + (a.output || "(no output)");
		}

		const truncation = truncateTail(a.output, { maxLines: budgetLines, maxBytes: availableBytes });

		if (!truncation.truncated) {
			return header + a.output;
		}

		const omitLines = truncation.totalLines - truncation.outputLines;
		const omitBytes = truncation.totalBytes - truncation.outputBytes;
		return (
			header +
			truncation.content +
			`\n[...${omitLines} lines (${formatSize(omitBytes)}) truncated. See full output file.]`
		);
	});

	let displayText = `Parallel: ${successCount}/${agentOutputs.length} succeeded\n\n${truncatedSections.join("\n\n")}`;
	displayText += `\n\n[Full output saved to: ${fullPath}]`;

	return { displayText, fullOutputPath: fullPath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	currentModel: Model<any> | undefined,
	modelRegistry: ModelRegistry | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const resolvedModel = resolveModel(agent.model, currentModel, modelRegistry);
	if (resolvedModel) args.push("--model", resolvedModel);

	const toolPolicy = getToolPolicy(agent);
	if (toolPolicy.builtinToolsForCli) {
		args.push("--tools", toolPolicy.builtinToolsForCli.join(","));
	}
	if (toolPolicy.extensionToolsForCli !== undefined) {
		args.push(`--${EXTENSION_TOOLS_FLAG}`, toolPolicy.extensionToolsForCli);
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel ?? agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					[CHILD_PROCESS_ENV_FLAG]: "1",
				},
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "package", "all"] as const, {
	description: 'Which agent directories to use. Default: "all".',
	default: "all",
});

const AgentInfoDetailSchema = StringEnum(["summary", "full"] as const, {
	description: 'Level of detail. "summary" shows name and description only (default).',
	default: "summary",
});

const SubagentAgentsParams = Type.Object({
	agentScope: Type.Optional(AgentScopeSchema),
	detail: Type.Optional(AgentInfoDetailSchema),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerFlag(EXTENSION_TOOLS_FLAG, {
		type: "string",
		default: "",
		description:
			"Comma-separated allowlist for extension tools in subagent child processes. Empty blocks all extension tools.",
	});

	pi.on("tool_call", (event) => {
		if (process.env[CHILD_PROCESS_ENV_FLAG] !== "1") return;

		const toolName = event.toolName.toLowerCase();
		if (BUILTIN_TOOLS.has(toolName)) return;

		const allowlist = parseToolList(pi.getFlag(EXTENSION_TOOLS_FLAG));
		if (allowlist.has("all") || allowlist.has(toolName)) return;

		return {
			block: true,
			reason: `Blocked extension tool "${event.toolName}" in subagent child. Allowed extension tools: ${allowlist.size > 0 ? Array.from(allowlist).join(", ") : "none"}.`,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (process.env[CHILD_PROCESS_ENV_FLAG] === "1") return;
		const overview = await buildSubagentOverviewForPrompt(ctx.cwd);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${overview}`,
		};
	});

	pi.registerTool({
		name: "subagent_agents",
		label: "Subagent Agents",
		description:
			"List available subagents. Defaults to a quick overview (name + description). Use detail=\"full\" for model/tools/source/path.",
		promptSnippet: "List available subagents. Defaults to a quick overview (name + description). Use detail=\"full\" for model/tools/source/path.",
		parameters: SubagentAgentsParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? DEFAULT_AGENT_SCOPE;
			const detail: AgentInfoDetail = (params.detail ?? "summary") as AgentInfoDetail;
			const report = await buildSubagentAgentsReport(ctx.cwd, agentScope, detail);

			return {
				content: [{ type: "text", text: report.text }],
				details: {
					agentScope,
					detail,
					projectAgentsDir: report.discovery.projectAgentsDir,
					agents: report.agents.map((a) => ({
						name: a.name,
						description: a.description,
						source: a.source,
						model: a.model,
						tools: a.tools,
						filePath: a.filePath,
					})),
				},
			};
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents. Usage: /subagents [user|project|package|all] [summary|full]",
		handler: async (args, ctx) => {
			const parsed = parseSubagentsCommandArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			const report = await buildSubagentAgentsReport(ctx.cwd, parsed.agentScope, parsed.detail);
			pi.sendMessage({
				customType: "subagent-agents",
				content: report.text,
				display: true,
				details: {
					agentScope: parsed.agentScope,
					detail: parsed.detail,
					agentCount: report.agents.length,
				},
			});
		},
	});

	pi.registerCommand("subagent-models", {
		description: "Configure model aliases used by subagents for fast/smart tiers.",
		handler: async (_args, ctx) => {
			const settings = readSettings();
			const currentFast = typeof settings.fastModel === "string" && settings.fastModel.trim() ? settings.fastModel : "parent";
			const currentSmart =
				typeof settings.smartModel === "string" && settings.smartModel.trim() ? settings.smartModel : "parent";

			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "subagent-models",
					content: `Current subagent model aliases:\n- fast: ${currentFast}\n- smart: ${currentSmart}`,
					display: true,
				});
				return;
			}

			const tierChoice = await ctx.ui.select("Select tier to configure", [
				`fast (${currentFast})`,
				`smart (${currentSmart})`,
			]);
			if (!tierChoice) {
				ctx.ui.notify("Canceled subagent model selection.", "warning");
				return;
			}

			const tier = tierChoice.startsWith("fast") ? "fast" : "smart";
			const registryModels = Array.from(
				new Set((ctx.modelRegistry?.getAvailable() ?? []).map((model) => `${model.provider}/${model.id}`)),
			).sort();
			const availableModels = ["parent", ...registryModels];

			const selectedModel = await ctx.ui.select(`Select model for ${tier}`, availableModels);
			if (!selectedModel) {
				ctx.ui.notify("Canceled model selection.", "warning");
				return;
			}

			writeSetting(`${tier}Model`, selectedModel === "parent" ? "" : selectedModel);

			const updatedSettings = readSettings();
			const updatedFast =
				typeof updatedSettings.fastModel === "string" && updatedSettings.fastModel.trim()
					? updatedSettings.fastModel
					: "parent";
			const updatedSmart =
				typeof updatedSettings.smartModel === "string" && updatedSettings.smartModel.trim()
					? updatedSettings.smartModel
					: "parent";
			ctx.ui.notify(`Updated ${tier} model to ${selectedModel}`, "info");
			pi.sendMessage({
				customType: "subagent-models",
				content: `Updated subagent model aliases:\n- fast: ${updatedFast}\n- smart: ${updatedSmart}`,
				display: true,
				details: { tier, selectedModel, fastModel: updatedFast, smartModel: updatedSmart },
			});
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "all" (user + project + package agents).',
			'Use subagent_agents for quick discovery (name + description) or full metadata.',
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). Default agent scope is \"all\" (user + project + package agents). Use subagent_agents for quick discovery (name + description) or full metadata.",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? DEFAULT_AGENT_SCOPE;
			const discovery = await discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "all") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						ctx.model,
						ctx.modelRegistry,
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const rawOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
				const processed = processToolResultOutput(rawOutput);
				return {
					content: [{ type: "text", text: processed.displayText }],
					details: { ...makeDetails("chain")(results), fullOutputPath: processed.fullOutputPath },
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						ctx.model,
						ctx.modelRegistry,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const agentOutputs = results.map((r) => ({
					agent: r.agent,
					exitCode: r.exitCode,
					output: getFinalOutput(r.messages),
				}));
				const processed = processParallelOutput(agentOutputs, successCount);
				return {
					content: [{ type: "text", text: processed.displayText }],
					details: { ...makeDetails("parallel")(results), fullOutputPath: processed.fullOutputPath },
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					ctx.model,
					ctx.modelRegistry,
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const rawOutput = getFinalOutput(result.messages) || "(no output)";
				const processed = processToolResultOutput(rawOutput);
				return {
					content: [{ type: "text", text: processed.displayText }],
					details: { ...makeDetails("single")([result]), fullOutputPath: processed.fullOutputPath },
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? DEFAULT_AGENT_SCOPE;
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					container.addChild(new Text(renderFullPath(details, theme), 0, 0));
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				text += renderFullPath(details, theme);
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					container.addChild(new Text(renderFullPath(details, theme), 0, 0));
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += renderFullPath(details, theme);
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					container.addChild(new Text(renderFullPath(details, theme), 0, 0));
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				text += renderFullPath(details, theme);
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}