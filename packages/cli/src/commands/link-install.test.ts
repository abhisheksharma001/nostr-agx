import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgxCliError, EXIT } from "../lib/errors.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, type CliRun, capture, jsonDocuments, sandbox } from "../test/helpers.js";
import { linkInstallCommand } from "./link-install.js";

/**
 * `agx link install --agent <host>` writes one coding agent's hook entries (the
 * ones `agx hook` answers) into that agent's own configuration file. It edits a
 * file the user owns and other tools write too, so the tests are mostly about
 * what it must never do: touch anything but that one file, replace an entry that
 * is not its own, lose what else the file holds, or write on a dry run.
 *
 * Every test runs with HOME (and USERPROFILE and CODEX_HOME) pointing into a
 * throwaway folder; `beforeEach` stops the test if this machine's idea of the
 * home folder is anything else, so a test can never write into a real one.
 *
 * File locations and shapes, from each host's documentation (read 2026-11-26):
 *   Claude Code  https://code.claude.com/docs/en/hooks   ~/.claude/settings.json, "hooks"
 *                https://code.claude.com/docs/en/env-vars   CLAUDE_CONFIG_DIR: "Override the configuration
 *                directory (default: ~/.claude). All settings, session history, and plugins are stored under this path."
 *   Cursor       https://cursor.com/docs/hooks            ~/.cursor/hooks.json, "version" and "hooks"
 *   Codex        https://developers.openai.com/codex/hooks   $CODEX_HOME/hooks.json, else ~/.codex/hooks.json
 * (the Claude Code environment-variable page was read live on 2026-11-26 at about 22:30 IST).
 */

type Host = "claude" | "cursor" | "codex";

let box: ReturnType<typeof sandbox>;
let userHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	box = sandbox();
	savedEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		CODEX_HOME: process.env.CODEX_HOME,
		CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	};
	userHome = mkdtempSync(join(tmpdir(), "agx-linkhome-"));
	process.env.HOME = userHome;
	process.env.USERPROFILE = userHome;
	delete process.env.CODEX_HOME;
	delete process.env.CLAUDE_CONFIG_DIR;
	// The one guard that matters: never go on if home is not the throwaway folder.
	if (resolve(homedir()) !== resolve(userHome) || !resolve(userHome).startsWith(resolve(tmpdir()) + sep)) {
		throw new Error(`refusing to run: homedir() is ${homedir()}, not the throwaway ${userHome}`);
	}
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

const FILE: Record<Host, string> = {
	claude: ".claude/settings.json",
	cursor: ".cursor/hooks.json",
	codex: ".codex/hooks.json",
};

/** The command lines agx writes for a host, with an optional `--profile`. */
function command(event: "stop" | "session-start" | "prompt", host: Host, profile?: string): string {
	return `agx ${profile ? `--profile ${profile} ` : ""}hook ${event} --host ${host}`;
}

function group(text: string): unknown {
	return { hooks: [{ type: "command", command: text }] };
}

/** What a fresh install writes, written out here from the documentation, not from the code under test. */
function expected(host: Host, profile?: string): unknown {
	if (host === "cursor") {
		return {
			version: 1,
			hooks: {
				stop: [{ command: command("stop", host, profile) }],
				sessionStart: [{ command: command("session-start", host, profile) }],
			},
		};
	}
	return {
		hooks: {
			Stop: [group(command("stop", host, profile))],
			SessionStart: [group(command("session-start", host, profile))],
			UserPromptSubmit: [group(command("prompt", host, profile))],
		},
	};
}

function path(rel: string): string {
	return join(userHome, rel);
}

function put(rel: string, text: string, mode?: number): void {
	mkdirSync(join(path(rel), ".."), { recursive: true });
	writeFileSync(path(rel), text);
	if (mode !== undefined) {
		chmodSync(path(rel), mode);
	}
}

function read(rel: string): string {
	return readFileSync(path(rel), "utf8");
}

function readJson(rel: string): unknown {
	return JSON.parse(read(rel));
}

/** Every path under `root` with its kind, mode, size and content hash (a link is shown, not followed). */
function tree(root: string): string[] {
	const rows: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(dir, entry.name);
			const stat = lstatSync(full);
			const mode = (stat.mode & 0o777).toString(8);
			const name = relative(root, full);
			if (stat.isSymbolicLink()) {
				rows.push(`${name} link ${readlinkSync(full)}`);
			} else if (stat.isDirectory()) {
				rows.push(`${name}/ dir ${mode}`);
				walk(full);
			} else {
				rows.push(`${name} file ${mode} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
			}
		}
	};
	walk(root);
	return rows;
}

async function install(host: string, ...extra: string[]): Promise<CliRun> {
	return agx("link", "install", "--agent", host, ...extra);
}

/** The lines of human output that start with `Undo:`. */
function undoLines(run: CliRun): string[] {
	return run.stdout.split("\n").filter((line) => line.startsWith("Undo: "));
}

const ALL: Host[] = ["claude", "cursor", "codex"];

describe("agx link install: a fresh home", () => {
	it("controls: the throwaway home is the one node uses, and nothing is installed yet", () => {
		expect(resolve(homedir())).toBe(resolve(userHome));
		expect(tree(userHome)).toEqual([]);
	});

	it.each(ALL)("%s: creates the host's file with exactly the hook entries and nothing else", async (host) => {
		const run = await install(host);
		expect(run.code).toBe(EXIT.ok);
		expect(readJson(FILE[host])).toEqual(expected(host));
		// Only that one file (and the folder it lives in) appeared under home.
		expect(tree(userHome).filter((row) => !row.includes("/ dir "))).toHaveLength(1);
		expect(existsSync(path(FILE[host]))).toBe(true);
		expect(read(FILE[host]).endsWith("\n")).toBe(true);
	});

	it("Cursor gets stop and sessionStart only: its prompt hook has no field that adds context", async () => {
		await install("cursor");
		expect(Object.keys((readJson(FILE.cursor) as { hooks: object }).hooks).sort()).toEqual(["sessionStart", "stop"]);
	});

	it("prints the change and one line to undo it", async () => {
		const run = await install("claude");
		expect(run.stdout).toContain(path(FILE.claude));
		for (const event of ["stop", "session-start", "prompt"] as const) {
			expect(run.stdout).toContain(command(event, "claude"));
		}
		expect(undoLines(run)).toHaveLength(1);
		// The file did not exist before, so the whole undo is deleting it.
		expect(undoLines(run)[0]).toContain("rm ");
		expect(undoLines(run)[0]).toContain(path(FILE.claude));
	});

	it("--json prints one document naming the file, the entries and the undo", async () => {
		const run = await agx("--json", "link", "install", "--agent", "codex");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toEqual([
			{
				schema: "agx.link.install/1",
				ok: true,
				agent: "codex",
				file: path(FILE.codex),
				dryRun: false,
				action: "created",
				added: [
					{ event: "Stop", command: command("stop", "codex") },
					{ event: "SessionStart", command: command("session-start", "codex") },
					{ event: "UserPromptSubmit", command: command("prompt", "codex") },
				],
				present: [],
				undo: expect.stringContaining(path(FILE.codex)),
			},
		]);
	});

	it("Codex: says that its hooks need review once with /hooks before they run", async () => {
		const run = await install("codex");
		expect(run.stdout).toContain("open /hooks in Codex and trust");
		expect((await install("claude")).stdout).not.toContain("trust");
	});

	it("Codex: writes under CODEX_HOME when it is set, and nowhere else", async () => {
		process.env.CODEX_HOME = join(userHome, "elsewhere", "codex");
		const run = await install("codex");
		expect(run.code).toBe(EXIT.ok);
		expect(readJson("elsewhere/codex/hooks.json")).toEqual(expected("codex"));
		expect(existsSync(path(".codex"))).toBe(false);
	});

	it("does not change the permissions of a folder that already exists", async () => {
		mkdirSync(path(".claude"), { mode: 0o755 });
		chmodSync(path(".claude"), 0o755);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(existsSync(path(FILE.claude))).toBe(true);
		expect(statSync(path(".claude")).mode & 0o777).toBe(0o755);
	});

	it("writes a file nobody else can write, leaves no temporary file beside it, and touches no agx data", async () => {
		await install("claude");
		expect(statSync(path(FILE.claude)).mode & 0o022).toBe(0);
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
		expect(existsSync(join(box.home, "config.json"))).toBe(false);
	});
});

describe("agx link install: --profile", () => {
	it.each(ALL)("%s: the hook commands carry --profile when one is given", async (host) => {
		const run = await install(host, "--profile", "work");
		expect(run.code).toBe(EXIT.ok);
		expect(readJson(FILE[host])).toEqual(expected(host, "work"));
	});

	it("leaves --profile out when none is given, even if AGX_PROFILE is set", async () => {
		process.env.AGX_PROFILE = "from-env";
		await install("claude");
		expect(readJson(FILE.claude)).toEqual(expected("claude"));
	});

	it.each(["../other", "a b", "a;b", "$(x)", ".hidden", "-x", "a/b"])("refuses the profile name %j and writes nothing", async (name) => {
		const run = await install("claude", "--profile", name);
		expect(run.code).toBe(EXIT.usage);
		expect(tree(userHome)).toEqual([]);
	});
});

describe("agx link install: the entries it writes run", () => {
	it.each(ALL)("%s: every command written is accepted by agx hook (exit 0, nothing to say yet)", async (host) => {
		await install(host, "--profile", "work");
		const written = JSON.stringify(readJson(FILE[host]));
		const commands = [...written.matchAll(/"command":"([^"]+)"/g)].map((match) => match[1] as string);
		expect(commands.length).toBeGreaterThanOrEqual(2);
		for (const text of commands) {
			const argv = text.split(" ");
			expect(argv[0]).toBe("agx");
			const restore = setStdinForTests(JSON.stringify({ status: "completed" }));
			try {
				const run = await agx(...argv.slice(1));
				expect(run.code).toBe(EXIT.ok);
				expect(run.stdout).toBe("");
			} finally {
				restore();
			}
		}
	});
});

describe("agx link install: an existing file", () => {
	const CLAUDE_BEFORE = [
		"{",
		'\t"permissions": { "allow": ["Bash(ls)"] },',
		'\t"hooks": {',
		'\t\t"PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./check.sh" }] }],',
		'\t\t"Stop": [{ "hooks": [{ "type": "command", "command": "notify-send done" }] }]',
		"\t}",
		"}",
		"",
	].join("\n");

	it("keeps everything else in the file, in order, and adds its own entries after the existing ones", async () => {
		put(FILE.claude, CLAUDE_BEFORE);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		const after = readJson(FILE.claude) as { permissions: unknown; hooks: Record<string, unknown[]> };
		const before = JSON.parse(CLAUDE_BEFORE) as { permissions: unknown; hooks: Record<string, unknown[]> };
		expect(after.permissions).toEqual(before.permissions);
		expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
		expect(after.hooks.Stop).toEqual([...(before.hooks.Stop as unknown[]), group(command("stop", "claude"))]);
		expect(after.hooks.SessionStart).toEqual([group(command("session-start", "claude"))]);
		expect(after.hooks.UserPromptSubmit).toEqual([group(command("prompt", "claude"))]);
		expect(Object.keys(after)).toEqual(["permissions", "hooks"]);
		expect(Object.keys(after.hooks)).toEqual(["PreToolUse", "Stop", "SessionStart", "UserPromptSubmit"]);
	});

	it("keeps the file's own indentation and its closing newline (or lack of one)", async () => {
		put(FILE.claude, CLAUDE_BEFORE);
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect(read(FILE.claude)).toContain("agx hook stop --host claude");
		expect(read(FILE.claude)).toMatch(/^\{\n\t"permissions"/);
		expect(read(FILE.claude).endsWith("}\n")).toBe(true);

		put(FILE.cursor, '{\n    "version": 1,\n    "hooks": {}\n}');
		expect((await install("cursor")).code).toBe(EXIT.ok);
		expect(read(FILE.cursor)).toContain("agx hook stop --host cursor");
		expect(read(FILE.cursor)).toMatch(/^\{\n {4}"version": 1,\n {4}"hooks": \{/);
		expect(read(FILE.cursor).endsWith("}")).toBe(true);
	});

	it("keeps the file's mode", async () => {
		put(FILE.claude, CLAUDE_BEFORE, 0o640);
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect(read(FILE.claude)).toContain("agx hook stop --host claude");
		expect(statSync(path(FILE.claude)).mode & 0o777).toBe(0o640);
	});

	it("treats an empty file as an empty object", async () => {
		put(FILE.codex, "\n");
		const run = await install("codex");
		expect(run.code).toBe(EXIT.ok);
		expect(readJson(FILE.codex)).toEqual(expected("codex"));
	});

	it("Cursor: keeps other hooks and an existing version, and adds version 1 only when there is none", async () => {
		put(FILE.cursor, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: "./audit.sh" }], stop: [{ command: "./done.sh" }] } }, null, 2));
		await install("cursor");
		expect(readJson(FILE.cursor)).toEqual({
			version: 1,
			hooks: {
				beforeShellExecution: [{ command: "./audit.sh" }],
				stop: [{ command: "./done.sh" }, { command: command("stop", "cursor") }],
				sessionStart: [{ command: command("session-start", "cursor") }],
			},
		});
		put(FILE.cursor, JSON.stringify({ hooks: {} }));
		await install("cursor");
		expect((readJson(FILE.cursor) as { version: unknown }).version).toBe(1);
	});

	it("runs a second time without changing the file and says so", async () => {
		await install("claude");
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(tree(userHome)).toEqual(before);
		expect(run.stdout.toLowerCase()).toContain("already installed");
		expect(undoLines(run)).toHaveLength(0);
		const doc = jsonDocuments((await agx("--json", "link", "install", "--agent", "claude")).stdout)[0] as { action: string; added: unknown[]; present: unknown[] };
		expect(doc.action).toBe("unchanged");
		expect(doc.added).toEqual([]);
		expect(doc.present).toHaveLength(3);
	});

	it("adds only what is missing when some of its entries are already there", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }, { type: "command", command: command("stop", "claude") }] }] } }, null, 2));
		const run = await agx("--json", "link", "install", "--agent", "claude");
		const doc = jsonDocuments(run.stdout)[0] as { action: string; added: { event: string }[]; present: { event: string }[] };
		expect(doc.action).toBe("updated");
		expect(doc.added.map((entry) => entry.event)).toEqual(["SessionStart", "UserPromptSubmit"]);
		expect(doc.present.map((entry) => entry.event)).toEqual(["Stop"]);
		const stop = (readJson(FILE.claude) as { hooks: { Stop: unknown[] } }).hooks.Stop;
		expect(stop).toHaveLength(1);
	});

	it("an update's undo says to delete the added entries, in one line", async () => {
		put(FILE.claude, CLAUDE_BEFORE);
		const run = await install("claude");
		expect(undoLines(run)).toHaveLength(1);
		expect(undoLines(run)[0]).not.toContain("rm ");
		expect(undoLines(run)[0]).toContain(path(FILE.claude));
	});

	it("writes through a symbolic link to the file it points at, and keeps the link", async () => {
		put("dotfiles/claude-settings.json", CLAUDE_BEFORE);
		mkdirSync(path(".claude"));
		symlinkSync(path("dotfiles/claude-settings.json"), path(FILE.claude));
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(lstatSync(path(FILE.claude)).isSymbolicLink()).toBe(true);
		expect(readlinkSync(path(FILE.claude))).toBe(path("dotfiles/claude-settings.json"));
		expect((readJson("dotfiles/claude-settings.json") as { hooks: Record<string, unknown> }).hooks.SessionStart).toBeDefined();
	});

	it("leaves the old file and no temporary file when the folder cannot be written", async () => {
		put(FILE.claude, CLAUDE_BEFORE);
		const before = tree(userHome);
		chmodSync(path(".claude"), 0o555);
		try {
			if (process.getuid?.() === 0) {
				return;
			}
			const run = await install("claude");
			expect(run.code).toBe(EXIT.generic);
			expect(run.stderr).toContain(path(FILE.claude));
			expect(run.stderr.toLowerCase()).toContain("not replaced");
		} finally {
			chmodSync(path(".claude"), 0o755);
		}
		expect(tree(userHome).map((row) => row.replace(/ dir \d+$/, " dir"))).toEqual(before.map((row) => row.replace(/ dir \d+$/, " dir")));
	});

	it("refuses a folder where the file belongs, a file it cannot read and a folder it cannot look into, and changes nothing", async () => {
		mkdirSync(path(".claude/settings.json"), { recursive: true });
		const before = tree(userHome);
		let run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		expect(tree(userHome)).toEqual(before);
		if (process.getuid?.() === 0) {
			return;
		}

		put(FILE.cursor, "{}", 0o000);
		try {
			run = await install("cursor");
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		} finally {
			chmodSync(path(FILE.cursor), 0o600);
		}
		expect(read(FILE.cursor)).toBe("{}");

		put(FILE.codex, "{}");
		chmodSync(path(".codex"), 0o000);
		try {
			run = await install("codex");
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		} finally {
			chmodSync(path(".codex"), 0o755);
		}
		expect(read(FILE.codex)).toBe("{}");
	});

	it("refuses a symbolic link that points nowhere, and creates nothing", async () => {
		mkdirSync(path(".claude"));
		symlinkSync(path("dotfiles/missing.json"), path(FILE.claude));
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);
	});
});

describe("agx link install: never replaces an entry that is not its own", () => {
	const DIFFERENT: [string, string][] = [
		["another profile", "agx --profile other hook stop --host claude"],
		["an absolute path to agx", "/opt/bin/agx hook stop --host claude"],
		["another host's flag", "agx hook stop --host codex"],
		["extra words", "agx hook stop --host claude --verbose"],
		["an environment prefix", "AGX_HOME=/tmp/elsewhere agx hook stop --host claude"],
	];

	it.each(DIFFERENT)("refuses when Stop already has an agx entry with %s, and changes nothing", async (_label, existing) => {
		const text = JSON.stringify({ hooks: { Stop: [group(existing)] } }, null, 2);
		put(FILE.claude, text);
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		// Which file and which event, and that the entry is not shown: never the entry's own text.
		expect(run.stderr).toContain(path(FILE.claude));
		expect(run.stderr).toContain("Stop");
		expect(run.stderr.toLowerCase()).toContain("not shown");
		expect(`${run.stdout}${run.stderr}`).not.toContain(existing);
		expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
	});

	it("refuses when the existing entry is the default and --profile asks for another (and the other way round)", async () => {
		await install("claude");
		const before = tree(userHome);
		const run = await install("claude", "--profile", "work");
		expect(run.code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);

		const other = await install("claude", "--profile", "other");
		expect(other.code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);
	});

	it("writes nothing at all when only one of the three events has a different entry", async () => {
		const text = JSON.stringify({ hooks: { SessionStart: [group("agx --profile x hook session-start --host claude")] } }, null, 2);
		put(FILE.claude, text);
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);
	});

	it("Cursor and Codex refuse a different agx entry the same way", async () => {
		put(FILE.cursor, JSON.stringify({ version: 1, hooks: { stop: [{ command: "agx -p other hook stop --host cursor" }] } }));
		put(FILE.codex, JSON.stringify({ hooks: { UserPromptSubmit: [group("agx hook prompt --host claude")] } }));
		const before = tree(userHome);
		expect((await install("cursor")).code).toBe(EXIT.config);
		expect((await install("codex")).code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);
	});

	it("control: another tool's hook that does not mention agx is kept, and a mention under another event is no obstacle", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("notify-send done"), group("./check.sh")], PreToolUse: [group("echo agx was here")] } }));
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect((readJson(FILE.claude) as { hooks: { Stop: unknown[] } }).hooks.Stop).toHaveLength(3);
	});

	it.each([
		["not JSON", "{ not json"],
		["a JSON array", "[]"],
		["a JSON string", '"hooks"'],
		["hooks that is a list", '{"hooks": []}'],
		["hooks that is a string", '{"hooks": "x"}'],
		["an event that is not a list", '{"hooks": {"Stop": {}, "stop": {}}}'],
		["a byte order mark", `${String.fromCharCode(0xfeff)}{"hooks": {}}`],
	])("refuses a file that is %s, names the file and changes nothing", async (_label, text) => {
		for (const host of ALL) {
			put(FILE[host], text);
		}
		const before = tree(userHome);
		for (const host of ALL) {
			const run = await install(host);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain(path(FILE[host]));
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		}
		expect(tree(userHome)).toEqual(before);
	});
});

describe("agx link install: CLAUDE_CONFIG_DIR", () => {
	it("writes settings.json under the folder Claude Code is told to use, and not under ~/.claude", async () => {
		const dir = path("work-account/claude");
		process.env.CLAUDE_CONFIG_DIR = dir;
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(readJson("work-account/claude/settings.json")).toEqual(expected("claude"));
		expect(existsSync(path(".claude"))).toBe(false);
		expect(run.stdout).toContain(join(dir, "settings.json"));
		const doc = jsonDocuments((await agx("--json", "link", "install", "--agent", "claude")).stdout)[0] as { file: string; action: string };
		expect(doc.file).toBe(join(dir, "settings.json"));
		expect(doc.action).toBe("unchanged");
	});

	it("keeps what that folder's settings.json already holds, and says how to undo in that folder", async () => {
		put("work-account/claude/settings.json", JSON.stringify({ theme: "dark", hooks: { Stop: [group("./done.sh")] } }, null, 2));
		process.env.CLAUDE_CONFIG_DIR = path("work-account/claude");
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		const after = readJson("work-account/claude/settings.json") as { theme: string; hooks: { Stop: unknown[] } };
		expect(after.theme).toBe("dark");
		expect(after.hooks.Stop).toEqual([group("./done.sh"), group(command("stop", "claude"))]);
		expect(undoLines(run)[0]).toContain(path("work-account/claude/settings.json"));
		expect(existsSync(path(".claude"))).toBe(false);
	});

	it("treats an empty value as not set", async () => {
		process.env.CLAUDE_CONFIG_DIR = "";
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect(readJson(FILE.claude)).toEqual(expected("claude"));
	});

	it("does not move Cursor's or Codex's file", async () => {
		process.env.CLAUDE_CONFIG_DIR = path("work-account/claude");
		expect((await install("cursor")).code).toBe(EXIT.ok);
		expect((await install("codex")).code).toBe(EXIT.ok);
		expect(readJson(FILE.cursor)).toEqual(expected("cursor"));
		expect(readJson(FILE.codex)).toEqual(expected("codex"));
		expect(existsSync(path("work-account"))).toBe(false);
	});
});

describe("agx link install: an agx entry in any other form", () => {
	const MENTIONS: [string, string][] = [
		["a quoted path with a space", '"/opt/My Tools/agx" hook stop --host claude'],
		["npx", "npx agx hook stop --host claude"],
		["pnpm exec", "pnpm exec agx hook stop --host claude"],
		["env with a variable", "env AGX_HOME=/x agx hook stop --host claude"],
		["an agx.js script", "/usr/local/bin/agx.js hook stop --host claude"],
		["sh -c", "sh -c 'agx hook stop --host claude'"],
		["upper case", "AGX hook stop --host claude"],
		["only an environment variable", "AGX_HOME=/x ./other.sh"],
		["a folder named for agx", "/home/me/agx-tools/notify.sh"],
		["another tool that only says agx", "echo agx hook stop"],
	];

	it.each(MENTIONS)("refuses when Stop has a command with %s: a different agx entry, not a second copy", async (_label, existing) => {
		const text = JSON.stringify({ hooks: { Stop: [group(existing)] } }, null, 2);
		put(FILE.claude, text);
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toContain(path(FILE.claude));
		expect(run.stderr).toContain("Stop");
		expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		expect(`${run.stdout}${run.stderr}`).not.toContain(existing);
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
	});

	it("Cursor and Codex refuse the same way, and name the event that has it", async () => {
		put(FILE.cursor, JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "npx agx hook session-start --host cursor" }] } }));
		put(FILE.codex, JSON.stringify({ hooks: { UserPromptSubmit: [group("sh -c 'agx hook prompt --host codex'")] } }));
		const before = tree(userHome);
		const cursor = await install("cursor");
		expect(cursor.code).toBe(EXIT.config);
		expect(cursor.stderr).toContain("sessionStart");
		const codex = await install("codex");
		expect(codex.code).toBe(EXIT.config);
		expect(codex.stderr).toContain("UserPromptSubmit");
		expect(tree(userHome)).toEqual(before);
	});

	it("an entry that is exactly the one it would write is left as it is, next to other tools' hooks", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("./done.sh"), group(command("stop", "claude"))] } }, null, 2));
		const run = await agx("--json", "link", "install", "--agent", "claude");
		expect(run.code).toBe(EXIT.ok);
		const stop = (readJson(FILE.claude) as { hooks: { Stop: unknown[] } }).hooks.Stop;
		expect(stop).toEqual([group("./done.sh"), group(command("stop", "claude"))]);
	});
});

describe("agx link install: a refusal never prints the entry in the way", () => {
	it("names the file and the event and says the entry is not shown, for a command that holds a secret and terminal control codes", async () => {
		const esc = String.fromCharCode(27);
		const bel = String.fromCharCode(7);
		const hostile = `AGX_API_KEY=sk-live-SECRET-9d41 agx --profile x hook stop --host claude ${esc}[2J${esc}]0;PWNED${bel}\nSECOND-LINE`;
		const text = JSON.stringify({ hooks: { Stop: [group(hostile)] } }, null, 2);
		put(FILE.claude, text);
		const before = tree(userHome);
		for (const args of [[], ["--dry-run"]]) {
			const run = await install("claude", ...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain(path(FILE.claude));
			expect(run.stderr).toContain("Stop");
			expect(run.stderr.toLowerCase()).toContain("not shown");
			for (const text of [run.stdout, run.stderr]) {
				for (const forbidden of ["SECRET", "sk-live", "PWNED", "SECOND-LINE", "--profile x", esc, bel]) {
					expect(text).not.toContain(forbidden);
				}
			}
		}
		const json = await agx("--json", "link", "install", "--agent", "claude");
		expect(json.code).toBe(EXIT.config);
		expect(`${json.stdout}${json.stderr}`).not.toMatch(/SECRET|sk-live|PWNED|SECOND-LINE/);
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
	});
});

describe("agx link install: content a rewrite would change", () => {
	const hooksFile = (extra: string): string => `{\n  ${extra},\n  "hooks": { "Stop": [] }\n}\n`;

	it("keeps CRLF line endings when the file uses them, including its closing one", async () => {
		const crlf = ['{', '\t"permissions": { "allow": ["Bash(ls)"] },', '\t"hooks": {}', '}', ''].join("\r\n");
		put(FILE.claude, crlf);
		expect((await install("claude")).code).toBe(EXIT.ok);
		const after = read(FILE.claude);
		expect(after).toContain("agx hook stop --host claude");
		expect(after.replaceAll("\r\n", "")).not.toContain("\n");
		expect(after.endsWith("}\r\n")).toBe(true);
		expect(after.split("\r\n").length).toBeGreaterThan(5);
		expect((readJson(FILE.claude) as { permissions: unknown }).permissions).toEqual({ allow: ["Bash(ls)"] });
	});

	it("keeps CRLF in a file with no closing line break, and still writes LF to an LF file", async () => {
		put(FILE.cursor, '{\r\n  "version": 1,\r\n  "hooks": {}\r\n}');
		expect((await install("cursor")).code).toBe(EXIT.ok);
		expect(read(FILE.cursor).replaceAll("\r\n", "")).not.toContain("\n");
		expect(read(FILE.cursor).endsWith("}")).toBe(true);
		put(FILE.codex, '{\n  "hooks": {}\n}\n');
		expect((await install("codex")).code).toBe(EXIT.ok);
		expect(read(FILE.codex)).not.toContain("\r");
	});

	it.each([
		["a whole number too large to keep", "12345678901234567890"],
		["a number too large for any double", "1e400"],
		["a number too small to keep", "1e-400"],
		["a long decimal that would be shortened", "0.1000000000000000055511151231257827"],
		["a huge integer", "123456789012345678901234567890"],
	])("refuses a file with %s, names the file, echoes nothing from it and changes nothing", async (_label, number) => {
		const text = hooksFile(`"big": ${number}`);
		put(FILE.claude, text);
		const before = tree(userHome);
		for (const args of [[], ["--dry-run"]]) {
			const run = await install("claude", ...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain(path(FILE.claude));
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
			expect(run.stderr).not.toContain(number);
		}
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
	});

	it("keeps every number whose value survives, whatever its spelling", async () => {
		const text = hooksFile('"timeout": 1.0, "n": 1e5, "safe": 9007199254740991, "neg": -0.5, "cap": 1E3, "zero": -0, "tiny": 0.000001, "exp": 2.5e-3');
		put(FILE.claude, text);
		expect((await install("claude")).code).toBe(EXIT.ok);
		const after = readJson(FILE.claude) as Record<string, unknown>;
		const before = JSON.parse(text) as Record<string, unknown>;
		for (const key of ["timeout", "n", "safe", "neg", "cap", "zero", "tiny", "exp"]) {
			expect(after[key]).toBe(before[key]);
		}
	});

	it("does not mistake text inside a string for a number or a repeated key", async () => {
		const text = JSON.stringify({ note: 'a "x": 1, "x": 2 and 1e400 and 12345678901234567890', hooks: { Stop: [] } }, null, 2);
		put(FILE.claude, text);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect((readJson(FILE.claude) as { note: string }).note).toBe('a "x": 1, "x": 2 and 1e400 and 12345678901234567890');
	});

	it.each([
		["at the top", '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "./keep.sh"}]}]}, "hooks": {}}'],
		["inside hooks", '{"hooks": {"Stop": [], "Stop": []}}'],
		["in another object", '{"permissions": {"a": 1, "b": 2, "a": 3}, "hooks": {}}'],
		["inside a list", '{"list": [{"k": 1, "k": 2}], "hooks": {}}'],
	])("refuses a file that repeats a key %s, because a rewrite would drop one of them", async (_label, text) => {
		put(FILE.claude, text);
		const before = tree(userHome);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toContain(path(FILE.claude));
		expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
	});

	it("sees a repeated key even when one of them is spelled with an escape", async () => {
		const escaped = `{"${String.fromCharCode(92)}u0068ooks": {}, "hooks": {}}`;
		put(FILE.claude, escaped);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.config);
		expect(read(FILE.claude)).toBe(escaped);
	});

	it("control: the same key name in different objects is fine", async () => {
		put(FILE.claude, '{"a": {"x": 1}, "b": {"x": 2}, "list": [{"k": 1}, {"k": 2}], "hooks": {}}');
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect((readJson(FILE.claude) as { b: unknown }).b).toEqual({ x: 2 });
	});

	it("checks a big file in reasonable time, and one nested very deeply is refused or edited, never a crash", async () => {
		const numbers = Array.from({ length: 200_000 }, (_, index) => index * 3).join(",");
		put(FILE.claude, `{"data": [${numbers}], "hooks": {}}`);
		const started = Date.now();
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect(Date.now() - started).toBeLessThan(8000);

		put(FILE.cursor, `{"deep": ${"[".repeat(50_000)}${"]".repeat(50_000)}, "hooks": {}}`);
		const run = await install("cursor");
		expect([EXIT.ok, EXIT.config]).toContain(run.code);
	});
});

describe("agx link install: a file that should not be replaced", () => {
	it("refuses a read-only file (and says so on a dry run) instead of replacing it", async () => {
		const text = JSON.stringify({ permissions: {} }, null, 2);
		put(FILE.claude, text, 0o444);
		const before = tree(userHome);
		for (const args of [[], ["--dry-run"]]) {
			const run = await install("claude", ...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain(path(FILE.claude));
			expect(run.stderr.toLowerCase()).toContain("read-only");
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		}
		expect(tree(userHome)).toEqual(before);
		expect(read(FILE.claude)).toBe(text);
		expect(statSync(path(FILE.claude)).mode & 0o777).toBe(0o444);
	});

	it("still says a read-only file is already installed when it is, since nothing would be written", async () => {
		await install("claude");
		chmodSync(path(FILE.claude), 0o444);
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout.toLowerCase()).toContain("already installed");
	});

	it("refuses a file that has another hard link, because replacing it would leave the other name with the old content", async () => {
		const text = JSON.stringify({ permissions: {} }, null, 2);
		put(FILE.claude, text);
		linkSync(path(FILE.claude), path("backup-of-settings.json"));
		const before = tree(userHome);
		for (const args of [[], ["--dry-run"]]) {
			const run = await install("claude", ...args);
			expect(run.code).toBe(EXIT.config);
			expect(run.stderr).toContain(path(FILE.claude));
			expect(run.stderr.toLowerCase()).toContain("hard link");
			expect(run.stderr.toLowerCase()).toContain("nothing was changed");
		}
		expect(tree(userHome)).toEqual(before);
		expect(statSync(path(FILE.claude)).nlink).toBe(2);
	});

	it("control: a file with one link is replaced, and writing a file whose name is a symbolic link still works", async () => {
		put(FILE.claude, "{}");
		expect(statSync(path(FILE.claude)).nlink).toBe(1);
		expect((await install("claude")).code).toBe(EXIT.ok);
	});
});

describe("agx link install: two installs at once, and a lock that was left behind", () => {
	const LOCK = ".claude/.settings.json.agx-lock";
	let holder: ReturnType<typeof spawn> | undefined;

	afterEach(() => {
		// Only the process this test started.
		if (holder?.pid !== undefined && holder.exitCode === null) {
			holder.kill("SIGKILL");
		}
		holder = undefined;
	});

	function liveProcess(): number {
		holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		if (holder.pid === undefined) {
			throw new Error("the helper process did not start");
		}
		return holder.pid;
	}

	function deadPid(): number {
		const done = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
		return Number(done.stdout);
	}

	function lockFor(pid: number): void {
		put(LOCK, `${JSON.stringify({ pid, token: "left-by-a-test" })}\n`);
	}

	it("leaves no lock file behind after a write, a refusal or a failed write", async () => {
		await install("claude");
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
		put(FILE.cursor, JSON.stringify({ hooks: { stop: [{ command: "npx agx hook stop" }] } }));
		await install("cursor");
		expect(readdirSync(path(".cursor"))).toEqual(["hooks.json"]);
	});

	it("takes over a lock whose process is gone, at once", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("./done.sh")] } }, null, 2));
		lockFor(deadPid());
		const started = Date.now();
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
		expect((readJson(FILE.claude) as { hooks: Record<string, unknown[]> }).hooks.Stop).toHaveLength(2);
	});

	it("takes over a lock that is old, even when a process with that number exists (a number can be reused)", async () => {
		put(FILE.claude, "{}");
		lockFor(liveProcess());
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(path(LOCK), old, old);
		const started = Date.now();
		expect((await install("claude")).code).toBe(EXIT.ok);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
	});

	it("takes over a lock file it cannot read, once it is old", async () => {
		put(FILE.claude, "{}");
		put(LOCK, "not json at all");
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(path(LOCK), old, old);
		expect((await install("claude")).code).toBe(EXIT.ok);
	});

	it("waits a bounded time for a live install and then refuses, changing nothing and leaving that lock alone", () => {
		put(FILE.claude, "{}");
		lockFor(liveProcess());
		const before = tree(userHome);
		const started = Date.now();
		let error: unknown;
		try {
			linkInstallCommand({ agent: "claude" }, { lockWaitMs: 400 });
		} catch (caught) {
			error = caught;
		}
		const waited = Date.now() - started;
		expect(error).toBeInstanceOf(AgxCliError);
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect((error as AgxCliError).message.toLowerCase()).toContain("nothing was changed");
		expect(waited).toBeGreaterThanOrEqual(300);
		expect(waited).toBeLessThan(4000);
		expect(tree(userHome)).toEqual(before);
	});

	it("goes on when the other install finishes while it waits", async () => {
		put(FILE.claude, "{}");
		const pid = liveProcess();
		lockFor(pid);
		// The other "install" removes its lock after a moment.
		spawn(process.execPath, ["-e", `setTimeout(() => require("node:fs").unlinkSync(${JSON.stringify(path(LOCK))}), 300)`], { stdio: "ignore" });
		const started = Date.now();
		const { stdout } = await capture(async () => linkInstallCommand({ agent: "claude" }));
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
		expect(stdout).toContain("Updated");
		expect(readJson(FILE.claude)).toEqual(expected("claude"));
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
	});

	it("reads the file again once it holds the lock, so what another tool saved in between is kept", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("./first.sh")] } }, null, 2));
		const changed = { theme: "dark", hooks: { Stop: [group("./first.sh"), group("./second.sh")] } };
		await capture(async () =>
			linkInstallCommand({ agent: "claude" }, { afterFirstRead: () => writeFileSync(path(FILE.claude), JSON.stringify(changed, null, 2)) }),
		);
		const after = readJson(FILE.claude) as { theme: string; hooks: Record<string, unknown[]> };
		expect(after.theme).toBe("dark");
		expect(after.hooks.Stop).toEqual([group("./first.sh"), group("./second.sh"), group(command("stop", "claude"))]);
		expect(after.hooks.SessionStart).toEqual([group(command("session-start", "claude"))]);
	});

	it("says it is already installed when another install finished the same entries in between, and adds nothing twice", async () => {
		put(FILE.claude, "{}");
		const { stdout } = await capture(async () =>
			linkInstallCommand({ agent: "claude" }, { afterFirstRead: () => writeFileSync(path(FILE.claude), JSON.stringify(expected("claude"), null, 2)) }),
		);
		expect(stdout.toLowerCase()).toContain("already installed");
		expect(readJson(FILE.claude)).toEqual(expected("claude"));
	});

	it("refuses, and changes nothing, when what another tool wrote in between is a different agx entry", async () => {
		put(FILE.claude, "{}");
		const other = { hooks: { Stop: [group("agx --profile other hook stop --host claude")] } };
		const before = JSON.stringify(other, null, 2);
		let error: unknown;
		try {
			linkInstallCommand({ agent: "claude" }, { afterFirstRead: () => writeFileSync(path(FILE.claude), before) });
		} catch (caught) {
			error = caught;
		}
		expect((error as AgxCliError).exitCode).toBe(EXIT.config);
		expect(read(FILE.claude)).toBe(before);
		expect(readdirSync(path(".claude"))).toEqual(["settings.json"]);
	});
});

describe("agx link install: what it writes and how", () => {
	it("gives a new file mode 0644 whatever the umask, and keeps an existing file's mode", async () => {
		const before = process.umask(0o077);
		try {
			expect((await install("claude")).code).toBe(EXIT.ok);
			expect(statSync(path(FILE.claude)).mode & 0o777).toBe(0o644);
			put(FILE.codex, "{}", 0o640);
			expect((await install("codex")).code).toBe(EXIT.ok);
			expect(statSync(path(FILE.codex)).mode & 0o777).toBe(0o640);
		} finally {
			process.umask(before);
		}
	});

	it("quotes the undo line for the shell when the home folder has spaces and quotes, and the line removes the file", async () => {
		const home = join(userHome, "it's a home");
		mkdirSync(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		const file = join(home, ".claude", "settings.json");
		expect(existsSync(file)).toBe(true);
		const line = undoLines(run)[0] as string;
		expect(line).toBe(`Undo: rm '${join(home, ".claude", "settings.json").replaceAll("'", "'\\''")}'`);
		const removed = spawnSync("sh", ["-c", line.slice("Undo: ".length)], { encoding: "utf8" });
		expect(removed.status).toBe(0);
		expect(existsSync(file)).toBe(false);
		const doc = jsonDocuments((await agx("--json", "link", "install", "--agent", "claude")).stdout)[0] as { undo: string };
		expect(doc.undo).toBe(`rm '${file.replaceAll("'", "'\\''")}'`);
	});
});

describe("agx link install: variables the hook will not see", () => {
	const warning = (run: CliRun): string[] => run.stdout.split("\n").filter((line) => /AGX_(HOME|PROFILE)/.test(line));

	it("warns in one line when AGX_HOME is set, because the hook command does not carry it", async () => {
		const run = await install("claude");
		expect(run.code).toBe(EXIT.ok);
		expect(warning(run)).toHaveLength(1);
		expect(warning(run)[0]).toContain("AGX_HOME");
		expect(warning(run)[0]).not.toContain("AGX_PROFILE");
	});

	it("warns when AGX_PROFILE is set and no --profile is given, and names both when both are set", async () => {
		delete process.env.AGX_HOME;
		process.env.AGX_PROFILE = "from-env";
		const only = await install("claude", "--dry-run");
		expect(warning(only)).toHaveLength(1);
		expect(warning(only)[0]).toContain("AGX_PROFILE");
		process.env.AGX_HOME = box.home;
		const both = await install("claude", "--dry-run");
		expect(warning(both)).toHaveLength(1);
		expect(warning(both)[0]).toContain("AGX_HOME");
		expect(warning(both)[0]).toContain("AGX_PROFILE");
	});

	it("does not mention AGX_PROFILE when --profile is given, and prints no warning when neither is set", async () => {
		delete process.env.AGX_HOME;
		process.env.AGX_PROFILE = "from-env";
		const given = await install("claude", "--profile", "work", "--dry-run");
		expect(warning(given)).toEqual([]);
		delete process.env.AGX_PROFILE;
		const none = await install("claude", "--dry-run");
		expect(warning(none)).toEqual([]);
		expect(none.stderr).toBe("");
	});

	it("keeps --json output a single document, with no warning in it", async () => {
		const run = await agx("--json", "link", "install", "--agent", "claude");
		expect(run.code).toBe(EXIT.ok);
		expect(jsonDocuments(run.stdout)).toHaveLength(1);
		expect(run.stdout).not.toContain("AGX_HOME");
	});
});

describe("agx link install --dry-run", () => {
	it.each(ALL)("%s: prints the change it would make and writes nothing, not even a folder", async (host) => {
		const before = tree(userHome);
		const run = await install(host, "--dry-run");
		expect(run.code).toBe(EXIT.ok);
		expect(tree(userHome)).toEqual(before);
		expect(tree(userHome)).toEqual([]);
		expect(run.stdout).toContain(path(FILE[host]));
		expect(run.stdout).toContain(command("stop", host));
		expect(run.stdout.toLowerCase()).toContain("dry run");
		expect(run.stdout.toLowerCase()).toContain("nothing was written");
	});

	it("says what a real run would do to an existing file, and leaves the file byte for byte as it was", async () => {
		put(FILE.claude, JSON.stringify({ permissions: {}, hooks: { Stop: [group("other")] } }, null, 2));
		put(FILE.cursor, JSON.stringify({ version: 1, hooks: {} }));
		const before = tree(userHome);
		for (const host of ["claude", "cursor"] as const) {
			const run = await install(host, "--dry-run");
			expect(run.code).toBe(EXIT.ok);
			expect(run.stdout).toContain(command("stop", host));
		}
		expect(tree(userHome)).toEqual(before);
	});

	it("--json: the same document as a real run, with dryRun true", async () => {
		const dry = jsonDocuments((await agx("--json", "link", "install", "--agent", "claude", "--dry-run")).stdout)[0] as Record<string, unknown>;
		expect(tree(userHome)).toEqual([]);
		const real = jsonDocuments((await agx("--json", "link", "install", "--agent", "claude")).stdout)[0] as Record<string, unknown>;
		expect(dry.dryRun).toBe(true);
		expect(real.dryRun).toBe(false);
		expect({ ...dry, dryRun: false }).toEqual(real);
	});

	it("still refuses a different agx entry, so a dry run predicts the real one", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("agx --profile other hook stop --host claude")] } }));
		const before = tree(userHome);
		const run = await install("claude", "--dry-run");
		expect(run.code).toBe(EXIT.config);
		expect(tree(userHome)).toEqual(before);
	});

	it("says it is already installed, and still writes nothing", async () => {
		await install("claude");
		const before = tree(userHome);
		const run = await install("claude", "--dry-run");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout.toLowerCase()).toContain("already installed");
		expect(tree(userHome)).toEqual(before);
	});
});

describe("agx link install: usage", () => {
	it("controls: needs --agent, and only the three hosts, with exit 1 (the usual exit for a command line commander rejects)", async () => {
		for (const args of [["link", "install"], ["link", "install", "--agent", "vim"], ["link", "install", "--agent"]]) {
			const run = await agx(...args);
			expect(run.code).toBe(EXIT.generic);
			expect(run.stderr).toContain("--agent");
			expect(tree(userHome)).toEqual([]);
		}
	});

	it("lists the three hosts, the location of each file and the undo in --help", async () => {
		const run = await agx("link", "install", "--help");
		expect(run.code).toBe(EXIT.ok);
		for (const word of ["claude", "cursor", "codex", "--dry-run", "--agent", ".claude/settings.json", ".cursor/hooks.json", "hooks.json"]) {
			expect(run.stdout).toContain(word);
		}
	});
});
