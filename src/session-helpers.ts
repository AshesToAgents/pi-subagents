/**
 * Session helpers for subagent spawning.
 *
 * Provides utilities for determining the next subagent counter,
 * detecting tmux, and building tmux window commands.
 */

import * as fs from "node:fs";

/**
 * In-process monotonic counters, keyed by `${sessionDir}::${parentId}`.
 *
 * The disk scan alone cannot allocate unique counters: the session file is
 * only created once the child pi process boots, hundreds of milliseconds
 * after spawn(). Concurrent workers (parallel tasks mode, or natively
 * parallel tool calls) would all scan the same directory state and receive
 * the same counter. Allocation therefore happens synchronously against this
 * cache, seeded once from disk per key. Node's single thread makes each
 * read-increment atomic.
 */
const allocatedCounters = new Map<string, number>();

/**
 * Determine the next subagent counter for a given parent session.
 *
 * Seeds from a scan of the subagent session directory for existing session
 * files matching `<timestamp>_<parentId>-<n>.jsonl`, then increments
 * monotonically in-process for subsequent calls, so concurrent allocations
 * before the corresponding files exist still receive unique counters.
 * Returns `max(n) + 1` as the seed; 1 when the directory does not exist or
 * contains no matching files.
 *
 * @param subagentSessionDir Directory containing subagent session files
 * @param parentId Parent session id (the prefix used to identify its subagents)
 * @returns Next available counter (1 if none exist)
 */
export function getNextSubagentCounter(subagentSessionDir: string, parentId: string): number {
	const cacheKey = `${subagentSessionDir}::${parentId}`;
	const cached = allocatedCounters.get(cacheKey);
	if (cached !== undefined) {
		allocatedCounters.set(cacheKey, cached + 1);
		return cached;
	}

	const seeded = scanMaxCounter(subagentSessionDir, parentId) + 1;
	allocatedCounters.set(cacheKey, seeded + 1);
	return seeded;
}

function scanMaxCounter(subagentSessionDir: string, parentId: string): number {
	if (!fs.existsSync(subagentSessionDir)) {
		return 0;
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(subagentSessionDir);
	} catch {
		return 1;
	}

	const prefix = `${parentId}-`;
	let max = 0;

	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;

		const stem = entry.slice(0, -".jsonl".length);
		const underscoreIdx = stem.indexOf("_");
		if (underscoreIdx < 0) continue;

		const sessionId = stem.slice(underscoreIdx + 1);
		if (!sessionId.startsWith(prefix)) continue;

		const counterPart = sessionId.slice(prefix.length);
		if (!/^\d+$/.test(counterPart)) continue;

		const n = Number.parseInt(counterPart, 10);
		if (n > max) max = n;
	}

	return max;
}

/**
 * Returns `true` if the current process is running inside a tmux session.
 *
 * Detection is based on the presence of the `TMUX` environment variable,
 * which tmux sets for every shell and child process it spawns.
 */
export function isTmuxAvailable(): boolean {
	return Boolean(process.env.TMUX);
}

/**
 * Build the argument array used to spawn a new tmux window that resumes
 * an existing pi session.
 */
export function buildTmuxWindowCommand(windowName: string, sessionDir: string, sessionId: string, background = false): string[] {
	const args = ["tmux", "new-window"];
	if (background) args.push("-d");
	args.push("-n", windowName, "--", "pi", "--session", sessionId, "--session-dir", sessionDir);
	return args;
}

export interface SessionSummary {
	/** Session name from --name flag (session_info entry) */
	name?: string
	/** Task description extracted from first user message */
	task: string
}

/**
 * Extract a summary from a subagent session file.
 *
 * Reads the JSONL file for the session name (from session_info entries)
 * and the first user message (task description). Returns both fields
 * for display in a selection list.
 */
export function extractSessionSummary(filePath: string): SessionSummary {
	const result: SessionSummary = { task: "(no task)" }
	try {
		const content = fs.readFileSync(filePath, "utf-8")
		for (const line of content.split("\n")) {
			if (!line.trim()) continue
			let entry: any
			try { entry = JSON.parse(line) } catch { continue }

			// Extract session name from session_info entries (latest wins)
			if (entry.type === "session_info" && entry.name) {
				result.name = entry.name.trim()
			}

			if (entry.type === "message" && entry.message?.role === "user") {
				const msgContent = entry.message.content
				let text = ""
				if (Array.isArray(msgContent)) {
					for (const part of msgContent) {
						if (part?.type === "text") { text = part.text; break }
					}
				} else if (typeof msgContent === "string") {
					text = msgContent
				}
				// Strip the "Task: " prefix that subagents add
				text = text.replace(/^Task:\s*/, "").trim()
				if (text.length > 80) text = text.slice(0, 77) + "..."
				result.task = text || "(no task)"
				return result
			}
		}
	} catch {
		// File not readable
	}
	return result
}
