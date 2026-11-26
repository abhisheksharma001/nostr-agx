import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import { type HookEvent, type HookHost, isHookProfileName } from "../lib/hook.js";
import { heading, info, json, ok, say, table, warn } from "../lib/output.js";
import { holdsSecretKey } from "../lib/secrets.js";

export const LINK_INSTALL_SCHEMA = "agx.link.install/1";

export interface LinkInstallOptions {
	agent: HookHost;
	dryRun?: boolean;
	/** The global `--profile`: written into the hook commands only when given. */
	profile?: string;
}

/** Tests only: a shorter wait for another install's lock, and a step between the first read and the lock. */
export interface LinkInstallDeps {
	lockWaitMs?: number;
	afterFirstRead?: () => void;
	/** A step between judging a lock left over and taking it over. */
	afterLockJudged?: () => void;
	/** A step between judging a takeover file left over and removing it. */
	afterTakeoverJudged?: () => void;
	/** A step while this install holds the takeover file, before it lets go of it. */
	duringTakeover?: () => void;
	/** A step while this install holds the lock, right before it checks the lock is still its own and publishes the file. */
	beforePublish?: () => void;
}

/** How long to wait for another `agx link install` that is changing the same file. */
const LOCK_WAIT_MS = 5000;

/** A lock older than this is left over from a run that never finished: its process may be gone, or its number reused. A lock made on another computer is judged by this alone. */
const LOCK_STALE_MS = 60_000;

/**
 * The hook entries each host gets: the host's own name for the event, and the
 * `agx hook` event it runs. Cursor has no entry for `prompt`: its prompt hook has
 * no field that adds context (see docs/hooks.md).
 */
const ENTRIES: Record<HookHost, { event: string; hook: HookEvent }[]> = {
	claude: [
		{ event: "Stop", hook: "stop" },
		{ event: "SessionStart", hook: "session-start" },
		{ event: "UserPromptSubmit", hook: "prompt" },
	],
	codex: [
		{ event: "Stop", hook: "stop" },
		{ event: "SessionStart", hook: "session-start" },
		{ event: "UserPromptSubmit", hook: "prompt" },
	],
	cursor: [
		{ event: "stop", hook: "stop" },
		{ event: "sessionStart", hook: "session-start" },
	],
};

interface Entry {
	event: string;
	command: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A word safe to paste into a POSIX shell: as it is when it only has safe characters, otherwise in single quotes. */
function shellQuote(value: string): string {
	return /^[A-Za-z0-9_@%+:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Nothing is written when this is thrown, and the message says so. */
function refusal(message: string, remediation: string): AgxCliError {
	return new AgxCliError(`${message} Nothing was changed.`, { exitCode: EXIT.config, remediation });
}

/** Where a host reads its user-level hooks from, from each host's documentation (see docs/hooks.md). */
function configFile(host: HookHost): string {
	const home = homedir();
	if (host === "claude") {
		// $CLAUDE_CONFIG_DIR replaces ~/.claude: "All settings, session history, and plugins are stored under this
		// path" (https://code.claude.com/docs/en/env-vars, read 2026-11-27). The documentation shows the shell
		// expanding a leading ~ and says to write the absolute path in a settings file; it does not say what Claude Code
		// does with a relative value, and this command's working folder is not necessarily Claude Code's. So only an
		// absolute path is followed, and any other value is refused, without being shown.
		const configDir = process.env.CLAUDE_CONFIG_DIR;
		if (configDir && !isAbsolute(configDir)) {
			throw refusal(
				"CLAUDE_CONFIG_DIR is set, but not to an absolute path, so agx cannot tell which folder Claude Code reads.",
				"Set CLAUDE_CONFIG_DIR to an absolute path (a shell expands ~ only when it is not in quotes), or unset it to use ~/.claude.",
			);
		}
		return join(configDir ? resolve(configDir) : join(home, ".claude"), "settings.json");
	}
	if (host === "cursor") {
		return join(home, ".cursor", "hooks.json");
	}
	// Codex: $CODEX_HOME/hooks.json, and ~/.codex/hooks.json when CODEX_HOME is not set.
	const codexHome = process.env.CODEX_HOME;
	return codexHome ? join(resolve(codexHome), "hooks.json") : join(home, ".codex", "hooks.json");
}

interface Loaded {
	/** The file to read and replace: the target of a link when `file` is one. */
	target: string;
	/** Null when there is no file yet. */
	text: string | null;
	mode: number | null;
	/** How many names the file has (hard links); 0 when there is no file. */
	links: number;
}

function load(file: string): Loaded {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { target: file, text: null, mode: null, links: 0 };
		}
		if (code === "ENOTDIR") {
			// A folder on the way is a file: a dry run would say "would create", and the real run could not. Both say so now.
			throw refusal(`A folder on the way to ${file} is a file, not a folder, so it cannot be created there.`, "Check what is at that path, then run this again.");
		}
		throw refusal(`Cannot look at ${file} (${code ?? "error"}).`, "Check the permissions of that file and run this again.");
	}
	let target = file;
	if (stat.isSymbolicLink()) {
		try {
			target = realpathSync(file);
		} catch {
			throw refusal(`${file} is a link to a file that does not exist.`, "Fix or remove the link, then run this again.");
		}
	}
	try {
		// A folder, or a file with no read permission, fails here.
		const stat = statSync(target);
		return { target, text: readFileSync(target, "utf8"), mode: stat.mode & 0o777, links: stat.nlink };
	} catch {
		throw refusal(`Cannot read ${target} as a file.`, "Check what is there and its permissions, then run this again.");
	}
}

function parse(text: string | null, file: string): Json {
	if (text === null || text.trim() === "") {
		return {};
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw refusal(`${file} is not valid JSON, so agx will not edit it.`, "Fix the file by hand, or add the entries yourself: see docs/hooks.md.");
	}
	if (!isObject(value)) {
		throw refusal(`${file} does not hold a JSON object, so agx will not edit it.`, "Fix the file by hand, or add the entries yourself: see docs/hooks.md.");
	}
	// Writing the file back is a JSON rewrite: say no to content that a rewrite would change.
	const lossy = lossyContent(text);
	if (lossy === "deep") {
		throw refusal(`${file} is nested more than ${MAX_DEPTH} levels deep, which is far past any hook file, so agx will not edit it.`, "Add the entries yourself: see docs/hooks.md.");
	}
	if (lossy === "number") {
		throw refusal(`${file} holds a number that agx cannot write back exactly (too large, too small or too precise), so it will not edit it.`, "Add the entries yourself: see docs/hooks.md.");
	}
	if (lossy === "key") {
		throw refusal(`${file} repeats a key inside one object, which a rewrite would collapse into one, so agx will not edit it.`, "Fix the file by hand, or add the entries yourself: see docs/hooks.md.");
	}
	return value;
}

/** A number as `digits` and a power of ten, so that two spellings of one value compare equal. */
function canonicalNumber(token: string): string {
	const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
	if (match === null) {
		return token;
	}
	const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
	const digits = `${whole}${fraction}`.replace(/^0+/, "");
	if (digits === "") {
		return "0";
	}
	const trimmed = digits.replace(/0+$/, "");
	return `${sign}${trimmed}e${Number(exponent) - fraction.length + (digits.length - trimmed.length)}`;
}

/** Whether a number written as `token` comes back with the same value after JSON.parse and JSON.stringify. */
function numberSurvives(token: string): boolean {
	const value = Number(token);
	// JSON.stringify writes -0 as 0 and an infinite value (1e400) as null, which never matches.
	return !Object.is(value, -0) && canonicalNumber(token) === canonicalNumber(JSON.stringify(value));
}

/** No hook file nests this deep; a bigger number is a file built to overflow the stack of whatever rewrites it. */
const MAX_DEPTH = 200;

const NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD_TOKEN = /true|false|null/y;

/**
 * What writing this JSON text back would change besides the entries added: a number whose
 * value does not survive (`12345678901234567890`, `1e400`) or a key repeated in one object (the
 * parser keeps the last). Assumes the text is valid JSON. One pass, no recursion, so a file nested
 * very deeply costs time and not the stack.
 */
function lossyContent(text: string): "number" | "key" | "deep" | null {
	const containers: (Set<string> | null)[] = [];
	let expectKey = false;
	let i = 0;
	while (i < text.length) {
		const char = text[i] as string;
		if (char === '"') {
			let end = i + 1;
			while (text[end] !== '"') {
				end += text[end] === "\\" ? 2 : 1;
			}
			const keys = containers[containers.length - 1];
			if (expectKey && keys) {
				const raw = text.slice(i, end + 1);
				const key = raw.includes("\\") ? (JSON.parse(raw) as string) : raw.slice(1, -1);
				if (keys.has(key)) {
					return "key";
				}
				keys.add(key);
				expectKey = false;
			}
			i = end + 1;
		} else if (char === "{" || char === "[") {
			containers.push(char === "{" ? new Set() : null);
			if (containers.length > MAX_DEPTH) {
				return "deep";
			}
			expectKey = char === "{";
			i++;
		} else if (char === "}" || char === "]") {
			containers.pop();
			expectKey = false;
			i++;
		} else if (char === ",") {
			expectKey = containers[containers.length - 1] instanceof Set;
			i++;
		} else if (char === "-" || (char >= "0" && char <= "9")) {
			NUMBER_TOKEN.lastIndex = i;
			const token = NUMBER_TOKEN.exec(text)?.[0] ?? char;
			if (!numberSurvives(token)) {
				return "number";
			}
			i += token.length;
		} else if (char === "t" || char === "f" || char === "n") {
			WORD_TOKEN.lastIndex = i;
			i += WORD_TOKEN.exec(text)?.[0].length ?? 1;
		} else {
			i++;
		}
	}
	return null;
}

/**
 * A command that runs agx: the word `agx`, a file called `agx.<js|mjs|cjs|ts|mts|cts|cmd|exe|com|ps1|bat|sh>` (which
 * includes the CLI's own entry files, `src/bin/agx.ts` and `dist/agx.js`), `agx@<version>` (as in `npx agx@latest`),
 * or this CLI's npm package `@nostr-agx/cli` (with or without a version). It has to come after the start of the text,
 * white space, a slash, a backslash, a quote, a colon (`npm:agx`), a backtick or one of `( { ; & |`, and it ends at the
 * end, white space, a backtick, a quote or one of `; | & < > ( ) { } ,` (a slash too, for the package's own files), or at
 * a backslash or caret that ends a line (a continuation). That covers `agx hook ...`, a path with or without spaces, `npx -y
 * agx@latest`, `pnpm dlx @nostr-agx/cli`, `deno run -A npm:agx`, `env X=y agx`, `sh -c '...'`, `$(agx ...)`,
 * `powershell -c "& {agx hook}"`, `agx>/dev/null` and `agx,hook`, in any case. It leaves out `tagx`,
 * `~/nostr-agx/lint.sh`, `AGX_DONE`, `agxx`, `x-agx` and the like, which are other tools. A command that builds the
 * name from a variable (`${AGX_BIN:-agx}`) is not seen: a dash before the name would also refuse `my-agx-tool`. Cautious
 * refusals that are accepted: a folder named exactly `agx` followed by a space, `'agx'`, `grep agx log`, `agx@` followed by
 * anything (`ssh agx@buildbox`), and a non-breaking space or byte order mark beside the name (JavaScript counts both as
 * white space, a shell does not).
 */
const AGX_AS_A_COMMAND =
	/(?:^|[\s/\\'"(;&|:{`])(?:agx(?:@|(?:\.(?:js|mjs|cjs|ts|mts|cts|cmd|exe|com|ps1|bat|sh))?(?=$|[\s;|&<>(){}`'",]|[\\^]\r?\n))|@nostr-agx\/cli(?=$|[\s/@;|&<>(){}`'",]))/i;

/** Whether a hook command runs agx. It errs on the side of yes: the one thing worse than a refusal is a second copy of the hook. */
function mentionsAgx(command: string): boolean {
	return AGX_AS_A_COMMAND.test(command);
}

/** The commands registered under one event, however the host nests them. */
function commandsOf(host: HookHost, list: unknown[]): string[] {
	const found: string[] = [];
	for (const item of list) {
		if (!isObject(item)) {
			continue;
		}
		if (host === "cursor") {
			if (typeof item.command === "string") {
				found.push(item.command);
			}
		} else if (Array.isArray(item.hooks)) {
			for (const hook of item.hooks) {
				if (isObject(hook) && typeof hook.command === "string") {
					found.push(hook.command);
				}
			}
		}
	}
	return found;
}

interface Plan {
	next: Json;
	added: Entry[];
	present: Entry[];
}

/** What the file should hold: the same file plus the entries that are missing. Throws when an entry is in the way. */
function plan(host: HookHost, data: Json, profile: string | undefined, file: string): Plan {
	const hooks: Json = data.hooks === undefined ? {} : (data.hooks as Json);
	if (!isObject(hooks)) {
		throw refusal(`"hooks" in ${file} is not an object, so agx will not edit it.`, "Fix the file by hand, or add the entries yourself: see docs/hooks.md.");
	}
	const next: Json = structuredClone(data);
	const nextHooks: Json = isObject(next.hooks) ? next.hooks : {};
	const added: Entry[] = [];
	const present: Entry[] = [];
	const conflicts: string[] = [];

	for (const { event, hook } of ENTRIES[host]) {
		const wanted = `agx ${profile ? `--profile ${profile} ` : ""}hook ${hook} --host ${host}`;
		const current = hooks[event];
		if (current !== undefined && !Array.isArray(current)) {
			throw refusal(`"${event}" in ${file} is not a list, so agx will not edit it.`, "Fix the file by hand, or add the entries yourself: see docs/hooks.md.");
		}
		const all = commandsOf(host, current ?? []);
		const existing = all.filter(mentionsAgx);
		if (existing.some((command) => command !== wanted)) {
			// Where the command is among those of the event, so it can be found without printing it.
			const positions = all.flatMap((command, index) => (mentionsAgx(command) && command !== wanted ? [index + 1] : []));
			conflicts.push(`${event} (command${positions.length > 1 ? "s" : ""} ${positions.join(", ")} of ${all.length})`);
			continue;
		}
		if (existing.length > 0) {
			present.push({ event, command: wanted });
			continue;
		}
		const list = Array.isArray(nextHooks[event]) ? (nextHooks[event] as unknown[]) : [];
		list.push(host === "cursor" ? { command: wanted } : { hooks: [{ type: "command", command: wanted }] });
		nextHooks[event] = list;
		added.push({ event, command: wanted });
	}

	if (conflicts.length > 0) {
		// Which event, never the command: it may hold a secret in an environment prefix or terminal control codes.
		throw refusal(
			`${file} (${host}) already has a different agx entry: ${conflicts.join(", ")}. It runs agx and is not the one this would write. Its text is not shown, in case it holds a secret.`,
			`agx never replaces an entry it did not write this time. To keep it, do nothing. To use the new one, delete that entry from ${file} and run this again.`,
		);
	}
	if (added.length === 0) {
		return { next: data, added, present };
	}
	next.hooks = nextHooks;
	// Cursor's file names its format version; a file without one gets the version its documentation shows.
	return { next: host === "cursor" && next.version === undefined ? { version: 1, ...next } : next, added, present };
}

/** The file's own indentation, so the rewrite does not reformat the whole file. */
function indentOf(text: string | null): string | number {
	const match = text === null ? null : /^([ \t]+)\S/m.exec(text);
	if (!match?.[1]) {
		return 2;
	}
	return match[1].startsWith("\t") ? "\t" : Math.min(match[1].length, 8);
}

function serialize(next: Json, before: string | null): string {
	// The file's own line endings: its first line break decides.
	const eol = before !== null && /\r?\n/.exec(before)?.[0] === "\r\n" ? "\r\n" : "\n";
	const body = JSON.stringify(next, null, indentOf(before)).replaceAll("\n", eol);
	return before === null || before.trim() === "" || before.endsWith("\n") ? `${body}${eol}` : body;
}

function writeFailure(target: string, error: unknown): AgxCliError {
	return new AgxCliError(`Could not write ${target}: ${(error as Error).message}`, {
		remediation: "The existing file was not replaced. Check the permissions of the folder and run this again.",
	});
}

/** This install lost its lock: another install took it over (this one was probably paused for longer than the lock's age limit). */
function displaced(target: string): AgxCliError {
	return new AgxCliError(
		`Another agx link install took over the lock on ${target} while this one was working (this one was probably paused for more than a minute), so this one wrote nothing. The file is as the other install left it.`,
		{ exitCode: EXIT.config, remediation: "Run this again." },
	);
}

/**
 * Replace the file in one rename, keeping its mode: the new text is written to a temporary file beside
 * it and forced to disk first, so a power loss leaves the old file or the new one and never an empty one.
 * Nothing is left behind when a step fails.
 */
function writeFile(target: string, text: string, mode: number | null, beforeRename: () => void): void {
	const temporary = join(dirname(target), `.${basename(target)}.agx-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
	try {
		// A new file is 0644 whatever the umask; an existing one keeps the mode it had.
		const finalMode = mode ?? 0o644;
		const fd = openSync(temporary, "wx", finalMode);
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temporary, finalMode);
		beforeRename();
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error instanceof AgxCliError ? error : writeFailure(target, error);
	}
}

/** What a lock or a takeover file holds: this process's number and the name of this computer, and a random token that tells it from any other. */
function lockRecord(): string {
	return `${JSON.stringify({ pid: process.pid, host: hostname(), token: randomBytes(8).toString("hex") })}\n`;
}

/**
 * Whether the process that made this lock has ended. A process number only means something on the computer that
 * made it, so this is judged only for a lock made on this computer: a lock from another computer (a home folder shared
 * between computers), or one with no computer name (an earlier format), is only ever judged by its age.
 */
function holderIsGone(lockText: string): boolean {
	try {
		const { pid, host } = JSON.parse(lockText) as { pid?: unknown; host?: unknown };
		if (host !== hostname() || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return false;
		}
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** The text of a lock file that no running install holds any more (its process is gone, or it is old), else null. */
function staleLockText(lock: string): string | null {
	try {
		const text = readFileSync(lock, "utf8");
		const old = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
		return old || holderIsGone(text) ? text : null;
	} catch {
		return null;
	}
}

/**
 * Remove a lock that was judged left over, so that only one install does it at a time. Installs that judged
 * the same lock left over would otherwise each remove it, and the second removal could take a lock that the
 * first install had made in the meantime, leaving two installs inside at once. So the removal is done only
 * while holding a second, very short-lived lock file (`<lock>.takeover`), and only when the lock is still
 * exactly the one that was judged: an install that gets the second lock late finds a different lock, or none,
 * and leaves it alone. A second file left by an install that died is removed the same careful way (only if
 * it is still the one that was judged), and an install only ever removes a second file that is its own.
 * Returns whether the lock that was judged is gone.
 */
function takeOverLeftOverLock(lock: string, judged: string, deps: LinkInstallDeps): boolean {
	deps.afterLockJudged?.();
	const takeover = `${lock}.takeover`;
	const mine = lockRecord();
	try {
		const fd = openSync(takeover, "wx", 0o600);
		try {
			writeFileSync(fd, mine);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Another install is doing it. If that one died halfway, its file is cleared and the next round gets it.
		const judgedTakeover = staleLockText(takeover);
		if (judgedTakeover !== null) {
			deps.afterTakeoverJudged?.();
			if (readText(takeover) === judgedTakeover) {
				rmSync(takeover, { force: true });
			}
		}
		return false;
	}
	try {
		deps.duringTakeover?.();
		if (readText(lock) !== judged) {
			return false;
		}
		rmSync(lock);
		return true;
	} catch {
		return false;
	} finally {
		if (readText(takeover) === mine) {
			rmSync(takeover, { force: true });
		}
	}
}

/**
 * Run `run` while this process holds a lock file beside `target`, so two installs at once cannot both read
 * the file and then each replace it with a version that lacks the other's entries. Waits a bounded time
 * for another install, and takes over a lock that is left over from one that died.
 */
function withLock<T>(target: string, deps: LinkInstallDeps, run: (stillMine: () => boolean) => T): T {
	const waitMs = deps.lockWaitMs ?? LOCK_WAIT_MS;
	const folder = dirname(target);
	const lock = join(folder, `.${basename(target)}.agx-lock`);
	try {
		mkdirSync(folder, { recursive: true });
	} catch (error) {
		throw writeFailure(target, error);
	}
	// What this install's lock holds: its process number, this computer's name and a random token, so that its own lock can be told from any other.
	const mine = lockRecord();
	const stillMine = (): boolean => readText(lock) === mine;
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const fd = openSync(lock, "wx", 0o600);
			try {
				writeFileSync(fd, mine);
			} finally {
				closeSync(fd);
			}
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw writeFailure(target, error);
			}
			const stale = staleLockText(lock);
			if (stale !== null && takeOverLeftOverLock(lock, stale, deps)) {
				continue;
			}
			if (Date.now() >= deadline) {
				// A second file that blocks a takeover is named too, so the message is not about the lock alone.
				const blocking = existsSync(`${lock}.takeover`) ? ` and ${lock}.takeover` : "";
				throw refusal(
					`Another agx link install seems to be changing ${target} (it holds ${lock}${blocking}).`,
					`Run this again in a moment. If no such command is running, delete ${lock}${blocking}.`,
				);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
	}
	try {
		return run(stillMine);
	} finally {
		// Never a lock that is not this install's own: another install may have taken it over while this one was paused.
		if (stillMine()) {
			rmSync(lock, { force: true });
		}
	}
}

interface Prepared {
	loaded: Loaded;
	result: Plan;
	action: "created" | "updated" | "unchanged";
}

/** Read the file and work out what it should hold. Throws when it must not be touched, or cannot be replaced. */
function prepare(host: HookHost, file: string, profile: string | undefined): Prepared {
	const loaded = load(file);
	const result = plan(host, parse(loaded.text, file), profile, file);
	const action = loaded.text === null ? "created" : result.added.length > 0 ? "updated" : "unchanged";
	if (action === "updated") {
		// Replacing a file is a rename, which ignores both of these: so they are checked first.
		if (loaded.mode !== null && (loaded.mode & 0o200) === 0) {
			throw refusal(`${loaded.target} is read-only, and agx will not replace a file its owner has locked.`, `Make it writable (chmod u+w) or add the entries yourself: see docs/hooks.md.`);
		}
		if (loaded.links > 1) {
			throw refusal(
				`${loaded.target} has ${loaded.links} hard links, and replacing it would leave the other names with the old content.`,
				"Add the entries yourself: see docs/hooks.md.",
			);
		}
	}
	return { loaded, result, action };
}

/** An nsec or ncryptsec, or a 64-character hexadecimal secret key (any case). */
function looksLikeSecretKey(value: string): boolean {
	return holdsSecretKey(value) || /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Add one coding agent's agx hook entries to that agent's own user-level
 * configuration file, and nothing else: no other file, no agx setting, no other
 * entry. It never replaces an entry that differs from the one it would write, it
 * leaves the rest of the file as it was, and with `--dry-run` it writes nothing.
 */
export function linkInstallCommand(options: LinkInstallOptions, deps: LinkInstallDeps = {}): void {
	const host = options.agent;
	const profile = options.profile;
	// Before anything else, so the value is never shown: a hook command is written to a file other tools read.
	if (profile !== undefined && looksLikeSecretKey(profile)) {
		throw usageError(
			"That --profile value looks like a secret key, so agx will not write it into a hook command. Nothing was changed.",
			"--profile takes a profile name such as work, never a key.",
		);
	}
	if (profile !== undefined && !isHookProfileName(profile)) {
		throw usageError(
			// The value is not shown, not even a part of it: one that is close to a key could be one.
			"That --profile value is not a profile name a hook can use. Nothing was changed.",
			"Use a name of up to 64 characters made of letters, digits, dots, dashes and underscores, starting with a letter or digit.",
		);
	}
	// The hook command is plain `agx hook ...`: it does not carry these, so an agent started without them reads another profile.
	const uncarried = [process.env.AGX_HOME ? "AGX_HOME" : null, process.env.AGX_PROFILE && profile === undefined ? "AGX_PROFILE" : null].filter(
		(name): name is string => name !== null,
	);
	if (uncarried.length > 0) {
		const them = uncarried.length === 1 ? "it" : "them";
		warn(
			`${uncarried.join(" and ")} ${uncarried.length === 1 ? "is" : "are"} set in this shell, but the hook commands written here do not carry ${them}: an agent that runs without ${them} reads another profile. Add ${them} to the commands by hand if that matters (see docs/hooks.md).`,
		);
	}

	const file = configFile(host);
	let state = prepare(host, file, profile);
	const dryRun = options.dryRun === true;
	if (state.action !== "unchanged" && !dryRun) {
		deps.afterFirstRead?.();
		// Under the lock the file is read and planned again, so a change made since the first read is kept.
		state = withLock(state.loaded.target, deps, (stillMine) => {
			const fresh = prepare(host, file, profile);
			if (fresh.action !== "unchanged") {
				writeFile(fresh.loaded.target, serialize(fresh.result.next, fresh.loaded.text), fresh.loaded.mode, () => {
					deps.beforePublish?.();
					if (!stillMine()) {
						throw displaced(fresh.loaded.target);
					}
				});
			}
			return fresh;
		});
	}
	const { action, result } = state;

	const undo =
		action === "created"
			? `rm ${shellQuote(file)}`
			: action === "updated"
				? `delete these ${result.added.length} entries from ${file}: ${result.added.map((entry) => `${entry.event} "${entry.command}"`).join("; ")}`
				: null;

	heading(`agx link install --agent ${host}`);
	if (action === "unchanged") {
		ok(`Already installed in ${file}: all ${result.present.length} entries are there.`);
	} else if (dryRun) {
		info(`Dry run: this would ${action === "created" ? "create" : "update"} ${file} with:`);
	} else {
		ok(`${action === "created" ? "Created" : "Updated"} ${file} with:`);
	}
	if (result.added.length > 0) {
		table(
			result.added.map((entry) => [entry.event, entry.command]),
			["event", "command"],
		);
	}
	if (result.present.length > 0 && action !== "unchanged") {
		info(`Already there, left as they were: ${result.present.map((entry) => entry.event).join(", ")}.`);
	}
	if (host === "codex" && result.added.length > 0) {
		info("Codex skips a new hook until you review it: open /hooks in Codex and trust these entries.");
	}
	if (undo !== null) {
		say("");
		say(`Undo: ${undo}`);
	}
	if (dryRun) {
		say("");
		say("Dry run: nothing was written.");
	}

	json({
		schema: LINK_INSTALL_SCHEMA,
		ok: true,
		agent: host,
		file,
		dryRun,
		action,
		added: result.added,
		present: result.present,
		undo,
		warnings: uncarried,
	});
}
