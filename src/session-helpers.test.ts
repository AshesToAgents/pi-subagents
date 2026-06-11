import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTmuxWindowCommand, extractSessionSummary, getNextSubagentCounter, isTmuxAvailable } from "./session-helpers.js";

describe("getNextSubagentCounter", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-counter-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns 1 when no sessions exist (empty dir)", () => {
		expect(getNextSubagentCounter(tmpDir, "parent-abc")).toBe(1);
	});

	it("returns next number after existing sessions", () => {
		fs.writeFileSync(path.join(tmpDir, "1700000000_parent-abc-1.jsonl"), "");
		fs.writeFileSync(path.join(tmpDir, "1700000001_parent-abc-2.jsonl"), "");
		fs.writeFileSync(path.join(tmpDir, "1700000002_parent-abc-3.jsonl"), "");

		expect(getNextSubagentCounter(tmpDir, "parent-abc")).toBe(4);
	});

	it("ignores files from other parent sessions", () => {
		// Files belonging to a different parent
		fs.writeFileSync(path.join(tmpDir, "1700000000_other-1.jsonl"), "");
		fs.writeFileSync(path.join(tmpDir, "1700000001_other-2.jsonl"), "");
		// Files belonging to the parent we care about
		fs.writeFileSync(path.join(tmpDir, "1700000002_parent-abc-1.jsonl"), "");

		expect(getNextSubagentCounter(tmpDir, "parent-abc")).toBe(2);
	});

	it("handles gaps in counter sequence", () => {
		// Counter sequence has a gap: 1, _, 3 (missing 2)
		fs.writeFileSync(path.join(tmpDir, "1700000000_parent-abc-1.jsonl"), "");
		fs.writeFileSync(path.join(tmpDir, "1700000001_parent-abc-3.jsonl"), "");

		// Should return max + 1, not (count + 1)
		expect(getNextSubagentCounter(tmpDir, "parent-abc")).toBe(4);
	});

	it("returns 1 when the directory does not exist", () => {
		const missingDir = path.join(tmpDir, "does-not-exist");
		expect(getNextSubagentCounter(missingDir, "parent-abc")).toBe(1);
	});
});

describe("isTmuxAvailable", () => {
	const originalTmux = process.env.TMUX;

	afterEach(() => {
		if (originalTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = originalTmux;
		}
	});

	it("returns false when TMUX env var is not set", () => {
		delete process.env.TMUX;
		expect(isTmuxAvailable()).toBe(false);
	});

	it("returns true when TMUX env var is set", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
		expect(isTmuxAvailable()).toBe(true);
	});
});

describe("extractSessionSummary", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-summary-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("extracts task text from first user message", () => {
		const filePath = path.join(tmpDir, "session.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "abc-1" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Task: Analyze the codebase structure" }] } }),
		];
		fs.writeFileSync(filePath, lines.join("\n"));
		expect(extractSessionSummary(filePath)).toEqual({ task: "Analyze the codebase structure" });
	});

	it("extracts session name from session_info entry", () => {
		const filePath = path.join(tmpDir, "session.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "abc-1" }),
			JSON.stringify({ type: "session_info", name: "scout" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Task: Quick recon" }] } }),
		];
		fs.writeFileSync(filePath, lines.join("\n"));
		expect(extractSessionSummary(filePath)).toEqual({ name: "scout", task: "Quick recon" });
	});

	it("truncates long tasks", () => {
		const filePath = path.join(tmpDir, "session.jsonl");
		const longTask = "A".repeat(100);
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `Task: ${longTask}` }] } }),
		];
		fs.writeFileSync(filePath, lines.join("\n"));
		expect(extractSessionSummary(filePath)).toEqual({ task: "A".repeat(77) + "..." });
	});

	it("returns (no task) for empty session", () => {
		const filePath = path.join(tmpDir, "session.jsonl");
		fs.writeFileSync(filePath, JSON.stringify({ type: "session", version: 3, id: "abc-1" }));
		expect(extractSessionSummary(filePath)).toEqual({ task: "(no task)" });
	});

	it("returns (no task) for missing file", () => {
		expect(extractSessionSummary(path.join(tmpDir, "missing.jsonl"))).toEqual({ task: "(no task)" });
	});
});

describe("buildTmuxWindowCommand", () => {
	it("returns the correct command array (foreground)", () => {
		expect(buildTmuxWindowCommand("subagent-1", "/tmp/sessions", "parent-1")).toEqual([
			"tmux",
			"new-window",
			"-n",
			"subagent-1",
			"--",
			"pi",
			"--session",
			"parent-1",
			"--session-dir",
			"/tmp/sessions",
		]);
	});

	it("includes -d flag when background is true", () => {
		expect(buildTmuxWindowCommand("subagent-1", "/tmp/sessions", "parent-1", true)).toEqual([
			"tmux",
			"new-window",
			"-d",
			"-n",
			"subagent-1",
			"--",
			"pi",
			"--session",
			"parent-1",
			"--session-dir",
			"/tmp/sessions",
		]);
	});
});
