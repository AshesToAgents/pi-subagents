import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeExitCode, processParallelOutput } from "./output.js";
import { runSingleAgent } from "./index.js";
import type { AgentConfig } from "./agents.js";

const stubAgent: AgentConfig = {
	name: "stub",
	description: "stub agent for tests",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/stub.md",
	rootDir: "/tmp",
};

describe("normalizeExitCode", () => {
	it("maps null (killed by signal) to failure exit code 1", () => {
		expect(normalizeExitCode(null)).toBe(1);
	});

	it("passes through real exit codes", () => {
		expect(normalizeExitCode(0)).toBe(0);
		expect(normalizeExitCode(3)).toBe(3);
	});
});

describe("processParallelOutput failure reporting", () => {
	it("surfaces stderr for a failed task with no output", () => {
		const { displayText } = processParallelOutput(
			[{ agent: "reviewer-php", exitCode: 1, output: "", stderr: "Error: spawn pi EMFILE" }],
			0,
		);
		expect(displayText).toContain("[reviewer-php] failed");
		expect(displayText).toContain("Error: spawn pi EMFILE");
		expect(displayText).not.toContain("(no output)");
	});

	it("prefers errorMessage over stderr over output for failed tasks", () => {
		const { displayText } = processParallelOutput(
			[
				{
					agent: "a",
					exitCode: 1,
					output: "partial final text",
					stderr: "some stderr noise",
					errorMessage: "provider 429",
				},
			],
			0,
		);
		expect(displayText).toContain("provider 429");
		expect(displayText).not.toContain("some stderr noise");
		expect(displayText).not.toContain("partial final text");
	});

	it("ignores stderr for successful tasks", () => {
		const { displayText } = processParallelOutput(
			[{ agent: "a", exitCode: 0, output: "all good", stderr: "warning noise" }],
			1,
		);
		expect(displayText).toContain("[a] completed");
		expect(displayText).toContain("all good");
		expect(displayText).not.toContain("warning noise");
	});

	it("writes full output to a temp file when the combined report is too large", () => {
		const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
		const { displayText, fullOutputPath } = processParallelOutput(
			[{ agent: "a", exitCode: 0, output: big }],
			1,
		);
		expect(fullOutputPath).toBeTruthy();
		expect(fs.existsSync(fullOutputPath!)).toBe(true);
		expect(fs.readFileSync(fullOutputPath!, "utf-8")).toContain(big);
		expect(displayText).toContain("Full output saved to");
	});
});

describe("runSingleAgent failure capture", () => {
	let tmpDir: string;
	let originalPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-failure-test-"));
		originalPath = process.env.PATH!;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeFakePi(script: string) {
		const p = path.join(tmpDir, "pi");
		fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		process.env.PATH = `${tmpDir}:${originalPath}`;
		return p;
	}

	it("records stderr and non-zero exit code from a failing child", async () => {
		writeFakePi('echo "boom stderr" >&2\nexit 2');
		const result = await runSingleAgent(
			tmpDir, [stubAgent], "stub", "test task", undefined, undefined, undefined, undefined,
			(() => ({}) as any), undefined, undefined, undefined, undefined, undefined,
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("boom stderr");
	});

	it("reports signal-killed children as failed (exit code 1), not success", async () => {
		writeFakePi("kill -9 $$");
		const result = await runSingleAgent(
			tmpDir, [stubAgent], "stub", "test task", undefined, undefined, undefined, undefined,
			(() => ({}) as any), undefined, undefined, undefined, undefined, undefined,
		);
		expect(result.exitCode).toBe(1);
	});

	it("captures the spawn error reason when the child cannot be spawned", async () => {
		// PATH without any `pi` binary -> spawn ENOENT
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-nopath-"));
		process.env.PATH = emptyDir;
		fs.rmSync(emptyDir, { recursive: true, force: true });
		const result = await runSingleAgent(
			tmpDir, [stubAgent], "stub", "test task", undefined, undefined, undefined, undefined,
			(() => ({}) as any), undefined, undefined, undefined, undefined, undefined,
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/spawn pi/i);
		expect(result.stderr).toMatch(/ENOENT/);
	});
});
