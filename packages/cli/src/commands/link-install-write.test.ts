import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "../lib/errors.js";
import { agx, sandbox } from "../test/helpers.js";

/**
 * How `agx link install` replaces a file: the new content is written to a temporary
 * file beside it, forced to disk, then renamed over the original. The two system calls
 * that matter here are wrapped (they still do their work) so a test can see their
 * order and make one of them fail: a failed write must leave the old file, no
 * temporary file and no lock file behind.
 */

const calls = vi.hoisted(() => ({ log: [] as string[], renames: [] as [string, string][], failRename: false, failFsync: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		fsyncSync: (fd: number): void => {
			calls.log.push("fsync");
			if (calls.failFsync) {
				throw new Error("the disk said no (fsync)");
			}
			actual.fsyncSync(fd);
		},
		renameSync: (from: string, to: string): void => {
			calls.log.push(`rename ${to.split(sep).pop()}`);
			calls.renames.push([from, to]);
			if (calls.failRename) {
				throw new Error("the disk said no (rename)");
			}
			actual.renameSync(from, to);
		},
	};
});

let box: ReturnType<typeof sandbox>;
let userHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	box = sandbox();
	savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
	userHome = mkdtempSync(join(tmpdir(), "agx-linkhome-"));
	process.env.HOME = userHome;
	process.env.USERPROFILE = userHome;
	delete process.env.CODEX_HOME;
	delete process.env.CLAUDE_CONFIG_DIR;
	// Never go on if home is not the throwaway folder.
	if (resolve(homedir()) !== resolve(userHome) || !resolve(userHome).startsWith(resolve(tmpdir()) + sep)) {
		throw new Error(`refusing to run: homedir() is ${homedir()}, not the throwaway ${userHome}`);
	}
	calls.log = [];
	calls.renames = [];
	calls.failRename = false;
	calls.failFsync = false;
});

afterEach(() => {
	process.exitCode = undefined;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	rmSync(userHome, { recursive: true, force: true });
	box.restore();
});

const SETTINGS = (): string => join(userHome, ".claude", "settings.json");

function existing(): string {
	mkdirSync(join(userHome, ".claude"), { recursive: true });
	const text = `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 2)}\n`;
	writeFileSync(SETTINGS(), text);
	return text;
}

describe("agx link install: replacing the file", () => {
	it("forces the temporary file to disk before it is renamed over the file, for a new file and an existing one", async () => {
		expect((await agx("link", "install", "--agent", "claude")).code).toBe(EXIT.ok);
		const first = calls.log.indexOf("rename settings.json");
		expect(first).toBeGreaterThan(-1);
		expect(calls.log.slice(0, first)).toContain("fsync");
		// The temporary file is in the file's own folder, so the rename cannot cross onto another disk.
		expect(calls.renames).toHaveLength(1);
		expect(dirname(calls.renames[0]?.[0] ?? "")).toBe(dirname(SETTINGS()));

		calls.log = [];
		writeFileSync(SETTINGS(), "{}\n");
		expect((await agx("link", "install", "--agent", "claude")).code).toBe(EXIT.ok);
		const second = calls.log.indexOf("rename settings.json");
		expect(second).toBeGreaterThan(-1);
		expect(calls.log.slice(0, second)).toContain("fsync");
	});

	it("leaves the old file, no temporary file and no lock file when the rename fails, and says the file was not replaced", async () => {
		const text = existing();
		calls.failRename = true;
		const run = await agx("link", "install", "--agent", "claude");
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr).toContain(SETTINGS());
		expect(run.stderr.toLowerCase()).toContain("not replaced");
		expect(readdirSync(join(userHome, ".claude"))).toEqual(["settings.json"]);
		expect(readFileSync(SETTINGS(), "utf8")).toBe(text);
	});

	it("does the same when forcing the file to disk fails", async () => {
		const text = existing();
		calls.failFsync = true;
		const run = await agx("link", "install", "--agent", "claude");
		expect(run.code).toBe(EXIT.generic);
		expect(run.stderr.toLowerCase()).toContain("not replaced");
		expect(readdirSync(join(userHome, ".claude"))).toEqual(["settings.json"]);
		expect(readFileSync(SETTINGS(), "utf8")).toBe(text);
		// And it works again once the disk does.
		calls.failFsync = false;
		expect((await agx("link", "install", "--agent", "claude")).code).toBe(EXIT.ok);
		expect(existsSync(SETTINGS())).toBe(true);
	});

	it("leaves no folder it created behind a lock when a brand new file cannot be written", async () => {
		calls.failRename = true;
		const run = await agx("link", "install", "--agent", "claude");
		expect(run.code).toBe(EXIT.generic);
		expect(existsSync(SETTINGS())).toBe(false);
		expect(readdirSync(join(userHome, ".claude"))).toEqual([]);
	});
});
