import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, type CliRun, jsonDocuments, sandbox } from "../test/helpers.js";

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
 *   Cursor       https://cursor.com/docs/hooks            ~/.cursor/hooks.json, "version" and "hooks"
 *   Codex        https://developers.openai.com/codex/hooks   $CODEX_HOME/hooks.json, else ~/.codex/hooks.json
 */

type Host = "claude" | "cursor" | "codex";

let box: ReturnType<typeof sandbox>;
let userHome: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	box = sandbox();
	savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
	userHome = mkdtempSync(join(tmpdir(), "agx-linkhome-"));
	process.env.HOME = userHome;
	process.env.USERPROFILE = userHome;
	delete process.env.CODEX_HOME;
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
				rows.push(`${name} file ${mode} ${stat.size} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
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
		expect(run.stdout).toContain("/hooks");
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
		expect(run.stderr).toContain(existing);
		expect(run.stderr).toContain(path(FILE.claude));
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

	it("does not mistake another tool's hook for an agx entry", async () => {
		put(FILE.claude, JSON.stringify({ hooks: { Stop: [group("my-agx-notifier stop"), group("echo agx hook stop")] } }));
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
