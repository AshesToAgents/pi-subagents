import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTmuxWindowCommand, getNextSubagentCounter, isTmuxAvailable } from "./session-helpers.js";

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

describe("buildTmuxWindowCommand", () => {
	it("returns the correct command array", () => {
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
});
