import { randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { AgxCliError, EXIT, usageError } from "../lib/errors.js";
import { type HookEvent, type HookHost, isHookProfileName } from "../lib/hook.js";
import { heading, info, json, ok, say, table } from "../lib/output.js";

export const LINK_INSTALL_SCHEMA = "agx.link.install/1";

export interface LinkInstallOptions {
	agent: HookHost;
	dryRun?: boolean;
	/** The global `--profile`: written into the hook commands only when given. */
	profile?: string;
}

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
		return join(home, ".claude", "settings.json");
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
}

function load(file: string): Loaded {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { target: file, text: null, mode: null };
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
	const real = statSync(target);
	if (!real.isFile()) {
		throw refusal(`${target} is not a regular file.`, "Move it out of the way, then run this again.");
	}
	try {
		return { target, text: readFileSync(target, "utf8"), mode: real.mode & 0o777 };
	} catch {
		throw refusal(`Cannot read ${target}.`, "Check the permissions of that file and run this again.");
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
	return value;
}

/**
 * Whether a hook command is an agx hook: its first word, after any `NAME=value`
 * prefixes, is a program called `agx` (with or without a folder in front), and
 * `hook` is one of the words after it. Another tool's command that only mentions
 * agx does not count.
 */
function isAgxHookCommand(command: string): boolean {
	const words = command.trim().split(/\s+/);
	while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) {
		words.shift();
	}
	const program = (words.shift() ?? "").split(/[\\/]/).pop();
	return program === "agx" && words.includes("hook");
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
		const existing = commandsOf(host, current ?? []).filter(isAgxHookCommand);
		const different = existing.filter((command) => command !== wanted);
		if (different.length > 0) {
			conflicts.push(...different.map((command) => `${event}: ${command}`));
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
		throw refusal(
			`${file} already has an agx hook entry that is not the one this would write: ${conflicts.join("; ")}.`,
			`agx never replaces an entry it did not write this time. To keep it, do nothing. To use the new one, delete the entry from ${file} and run this again.`,
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
	const body = JSON.stringify(next, null, indentOf(before));
	return before === null || before.trim() === "" || before.endsWith("\n") ? `${body}\n` : body;
}

/** Replace the file in one rename, keeping its mode, and leave nothing behind when that fails. */
function writeFile(target: string, text: string, mode: number | null): void {
	const folder = dirname(target);
	const temporary = join(folder, `.${basename(target)}.agx-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
	try {
		mkdirSync(folder, { recursive: true });
		// A new file is 0644 whatever the umask; an existing one keeps the mode it had.
		const finalMode = mode ?? 0o644;
		writeFileSync(temporary, text, { flag: "wx", mode: finalMode });
		chmodSync(temporary, finalMode);
		renameSync(temporary, target);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw new AgxCliError(`Could not write ${target}: ${(error as Error).message}`, {
			remediation: "The existing file was not replaced. Check the permissions of the folder and run this again.",
		});
	}
}

/**
 * Add one coding agent's agx hook entries to that agent's own user-level
 * configuration file, and nothing else: no other file, no agx setting, no other
 * entry. It never replaces an entry that differs from the one it would write, it
 * leaves the rest of the file as it was, and with `--dry-run` it writes nothing.
 */
export function linkInstallCommand(options: LinkInstallOptions): void {
	const host = options.agent;
	const profile = options.profile;
	if (profile !== undefined && !isHookProfileName(profile)) {
		throw usageError(
			`"${profile}" is not a profile name a hook can use.`,
			"Use a name made of letters, digits, dots, dashes and underscores, starting with a letter or digit.",
		);
	}

	const file = configFile(host);
	const loaded = load(file);
	const result = plan(host, parse(loaded.text, file), profile, file);
	const action = loaded.text === null ? "created" : result.added.length > 0 ? "updated" : "unchanged";
	const dryRun = options.dryRun === true;

	if (action !== "unchanged" && !dryRun) {
		writeFile(loaded.target, serialize(result.next, loaded.text), loaded.mode);
	}

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
	});
}
