/**
 * Session helpers for subagent spawning.
 *
 * Provides utilities for determining the next subagent counter,
 * detecting tmux, and building tmux window commands.
 */

import * as fs from "node:fs";

/**
 * Determine the next subagent counter for a given parent session.
 *
 * Scans the subagent session directory for existing session files
 * matching `<timestamp>_<parentId>-<n>.jsonl` and returns `max(n) + 1`.
 * Returns 1 when the directory does not exist or contains no matching files.
 *
 * @param subagentSessionDir Directory containing subagent session files
 * @param parentId Parent session id (the prefix used to identify its subagents)
 * @returns Next available counter (1 if none exist)
 */
export function getNextSubagentCounter(subagentSessionDir: string, parentId: string): number {
	if (!fs.existsSync(subagentSessionDir)) {
		return 1;
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

	return max + 1;
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

/**
 * Extract a short summary from a subagent session file.
 *
 * Reads the JSONL file and finds the first user message to extract
 * the task description. Returns a truncated preview suitable for
 * display in a selection list.
 */
export function extractSessionSummary(filePath: string): string {
	try {
		const content = fs.readFileSync(filePath, "utf-8")
		for (const line of content.split("\n")) {
			if (!line.trim()) continue
			let entry: any
			try { entry = JSON.parse(line) } catch { continue }

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
				return text || "(no task)"
			}
		}
	} catch {
		// File not readable
	}
	return "(no task)"
}
