/**
 * Output processing for subagent tool results.
 *
 * Pure formatting helpers, kept free of extension imports so they can be
 * unit-tested directly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";

/**
 * Normalize a child process close code: a process killed by a signal closes
 * with `code === null`, which must count as a failure, not success.
 */
export function normalizeExitCode(code: number | null): number {
	return code ?? 1;
}

export interface ParallelAgentOutput {
	agent: string;
	exitCode: number;
	output: string;
	/** stderr captured from the child process */
	stderr?: string;
	/** provider/agent-level error message, when available */
	errorMessage?: string;
}

/**
 * For parallel mode: truncate each agent's output proportionally rather than
 * truncating the combined string (which would cut off early agents entirely).
 * Writes the full combined output to a temp file.
 *
 * Failed tasks report the most diagnostic text available, mirroring single
 * mode: errorMessage, then stderr, then the final output.
 */
export function processParallelOutput(
	agentOutputs: ParallelAgentOutput[],
	successCount: number,
): { displayText: string; fullOutputPath?: string } {
	const sectionBody = (a: ParallelAgentOutput): string => {
		if (a.exitCode === 0) return a.output || "(no output)";
		return a.errorMessage || a.stderr || a.output || "(no output)";
	};

	const fullSections = agentOutputs.map((a) => {
		const status = a.exitCode === 0 ? "completed" : "failed";
		return `[${a.agent}] ${status}:\n${sectionBody(a)}`;
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
		const body = sectionBody(a);

		if (!body || body === "(no output)") {
			return header + body;
		}

		const truncation = truncateTail(body, { maxLines: budgetLines, maxBytes: availableBytes });

		if (!truncation.truncated) {
			return header + body;
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
