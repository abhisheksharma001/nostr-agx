import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_LOCK_STALE_MS, configLockPath, withConfigLock } from "./config-lock.js";
import { AgxCliError } from "./errors.js";

let home: string;
let previous: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-lock-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
	}
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

/** A process that stays alive for the test, so its pid is a real, live holder. */
function liveProcess(): number {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	children.push(child);
	if (child.pid === undefined) {
		throw new Error("could not start a helper process");
	}
	return child.pid;
}

/** The pid of a process that has already exited. */
function deadPid(): number {
	const run = spawnSync(process.execPath, ["-e", ""]);
	if (run.pid === undefined) {
		throw new Error("could not start a helper process");
	}
	return run.pid;
}

function writeLock(record: Record<string, unknown> | string): void {
	writeFileSync(configLockPath(), typeof record === "string" ? record : `${JSON.stringify(record)}\n`);
}

function age(seconds: number): void {
	const past = new Date(Date.now() - seconds * 1000);
	utimesSync(configLockPath(), past, past);
}

describe("withConfigLock", () => {
	it("runs the function, returns its value, and leaves no lock file behind", () => {
		const value = withConfigLock(() => {
			expect(existsSync(configLockPath())).toBe(true);
			return 42;
		});
		expect(value).toBe(42);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("releases the lock when the function throws", () => {
		expect(() =>
			withConfigLock(() => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(configLockPath())).toBe(false);
		expect(withConfigLock(() => "again")).toBe("again");
	});

	it("is re-entrant: a nested call inside the function does not wait for itself", () => {
		const started = Date.now();
		const value = withConfigLock(() => withConfigLock(() => "inner", { waitMs: 50 }));
		expect(value).toBe("inner");
		expect(Date.now() - started).toBeLessThan(40);
		expect(existsSync(configLockPath())).toBe(false);
	});

	it("does not remove a lock that another process took while the function ran", () => {
		const theirs = { pid: liveProcess(), host: hostname(), token: "theirs" };
		withConfigLock(() => {
			rmSync(configLockPath());
			writeLock(theirs);
		});
		expect(JSON.parse(readFileSync(configLockPath(), "utf8")).token).toBe("theirs");
	});

	describe("while another process holds it", () => {
		it("refuses after the wait, and never runs the function", () => {
			writeLock({ pid: liveProcess(), host: hostname(), token: "other" });
			let ran = false;
			let error: unknown;
			try {
				withConfigLock(
					() => {
						ran = true;
					},
					{ waitMs: 150 },
				);
			} catch (caught) {
				error = caught;
			}
			expect(ran).toBe(false);
			expect(error).toBeInstanceOf(AgxCliError);
			expect((error as AgxCliError).message).toMatch(/config lock/i);
			expect((error as AgxCliError).remediation).toContain(configLockPath());
		});

		it("waits for it to be released, then runs", async () => {
			const script = [
				'const fs = require("fs"), os = require("os");',
				"const path = process.argv[1];",
				'fs.writeFileSync(path, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "child" }) + "\\n");',
				"setTimeout(() => fs.rmSync(path), 400);",
				"setTimeout(() => {}, 3000);",
			].join("\n");
			children.push(spawn(process.execPath, ["-e", script, configLockPath()], { stdio: "ignore" }));
			const deadline = Date.now() + 5_000;
			while (!existsSync(configLockPath())) {
				if (Date.now() > deadline) {
					throw new Error("the helper process never took the lock");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const started = Date.now();
			let ran = false;
			withConfigLock(
				() => {
					ran = true;
				},
				{ waitMs: 5_000 },
			);
			expect(ran).toBe(true);
			expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		});

		it("waits on a fresh lock from another host", () => {
			writeLock({ pid: 1, host: "some-other-container", token: "far" });
			expect(() => withConfigLock(() => undefined, { waitMs: 100 })).toThrow(/config lock/i);
		});
	});

	describe("a lock nobody is holding", () => {
		it("is taken over when its process has exited", () => {
			writeLock({ pid: deadPid(), host: hostname(), token: "gone" });
			expect(withConfigLock(() => "ran", { waitMs: 500 })).toBe("ran");
			expect(existsSync(configLockPath())).toBe(false);
		});

		it("is taken over when it is older than the stale age, whatever its pid", () => {
			writeLock({ pid: liveProcess(), host: hostname(), token: "forgotten" });
			age(CONFIG_LOCK_STALE_MS / 1000 + 5);
			expect(withConfigLock(() => "ran", { waitMs: 500 })).toBe("ran");
		});

		it("is taken over when it is from another host and older than the stale age", () => {
			writeLock({ pid: 1, host: "some-other-container", token: "far" });
			age(CONFIG_LOCK_STALE_MS / 1000 + 5);
			expect(withConfigLock(() => "ran", { waitMs: 500 })).toBe("ran");
		});

		it("is taken over when the file is empty", () => {
			writeLock("");
			expect(withConfigLock(() => "ran", { waitMs: 500 })).toBe("ran");
		});
	});
});
