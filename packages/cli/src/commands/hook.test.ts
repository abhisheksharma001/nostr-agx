import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { lockPath, profileDir } from "../lib/paths.js";
import { setStdinForTests } from "../lib/stdin.js";
import { MessageStore } from "../lib/store/message-store.js";
import { agx, type CliRun, sandbox } from "../test/helpers.js";

/**
 * `agx hook` is what a coding agent's hook configuration runs when a turn ends,
 * when a session starts and when a prompt is sent. It reads the message store,
 * never takes the profile lock, and prints at most one short nudge in the host's
 * own JSON shape: counts and thread ids, never what a peer wrote.
 *
 * The expected JSON per host is written out here from each host's documentation
 * (read 2026-11-26), not derived from the code under test:
 *   Claude Code  https://code.claude.com/docs/en/hooks   Stop: decision/reason;
 *                SessionStart and UserPromptSubmit: hookSpecificOutput.additionalContext
 *   Cursor       https://cursor.com/docs/hooks            stop: followup_message;
 *                sessionStart: additional_context; beforeSubmitPrompt has no context field
 *   Codex        https://developers.openai.com/codex/hooks   Stop: decision/reason;
 *                SessionStart and UserPromptSubmit: hookSpecificOutput.additionalContext
 */

const PEER = toNpub("11".repeat(32));
const STRANGER = toNpub("22".repeat(32));
const BODY = "BODY-MARKER-7316 please review the invoice";
const SUBJECT = "SUBJECT-MARKER-7316";
const HELD_BODY = "HELD-MARKER-7316 text from a sender off the allowlist";
const UNSAFE_CONTEXT = "bad id; echo UNSAFE-MARKER-7316";
const LONG_CONTEXT = `long-${"x".repeat(80)}`;

const COMPLETED = JSON.stringify({ status: "completed", loop_count: 0, conversation_id: "conv-1" });

const TAIL =
	"agx threads lists every thread; agx thread <id> shows one, and agx thread <id> --mark-read marks it read once it is handled.";
const ALL_UNREAD = `agx has 2 unread messages. Threads with unread messages: thread-b, thread-a. ${TAIL}`;

type Host = "claude" | "cursor" | "codex";
type Event = "stop" | "session-start" | "prompt";

let box: ReturnType<typeof sandbox>;
let holder: ChildProcess | undefined;

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	process.exitCode = undefined;
	// Only the process this test started.
	if (holder?.pid !== undefined && holder.exitCode === null) {
		holder.kill("SIGKILL");
	}
	holder = undefined;
	box.restore();
});

function at(minute: number): string {
	return new Date(Date.UTC(2026, 10, 26, 3, minute)).toISOString();
}

/** Two unread messages (thread-a older, thread-b newer), one read, one sent, one held sender. */
function seedStore(profile = "default"): void {
	const store = new MessageStore(profileDir(profile));
	store.addInbound({ id: "in-1", peer: PEER, subject: SUBJECT, contextId: "thread-a", text: BODY, at: at(1) });
	store.addInbound({ id: "in-2", peer: PEER, subject: SUBJECT, contextId: "thread-b", text: BODY, at: at(2) });
	store.addInbound({ id: "in-3", peer: PEER, subject: SUBJECT, contextId: "thread-c", text: BODY, at: at(3) });
	store.markRead({ ids: ["in-3"] });
	store.addOutbound({ id: "out-1", peer: PEER, subject: null, contextId: "thread-a", text: "my answer", at: at(4), deliveryStatus: "sent" });
	store.hold(STRANGER, { id: "held-1", peer: STRANGER, subject: null, contextId: null, text: HELD_BODY, at: at(5) });
	store.flush();
}

function addUnread(id: string, contextId: string | null, minute: number, profile = "default"): void {
	const store = new MessageStore(profileDir(profile));
	store.addInbound({ id, peer: PEER, subject: SUBJECT, contextId, text: BODY, at: at(minute) });
	store.flush();
}

async function hook(event: Event, host: Host, options: { stdin?: string | null; profile?: string } = {}): Promise<CliRun> {
	const restore = host === "cursor" ? setStdinForTests(options.stdin === undefined ? COMPLETED : options.stdin) : undefined;
	try {
		return await agx(...(options.profile ? ["--profile", options.profile] : []), "hook", event, "--host", host);
	} finally {
		restore?.();
	}
}

/** The one JSON object on one line the hook printed. */
function onlyDocument(run: CliRun): unknown {
	expect(run.stdout.endsWith("\n")).toBe(true);
	expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
	return JSON.parse(run.stdout);
}

function expectSilent(run: CliRun): void {
	expect(run.code).toBe(EXIT.ok);
	expect(run.stdout).toBe("");
	expect(run.stderr).toBe("");
}

/** Every file under `dir` with its size, modified time and content hash. */
function listing(dir: string): string[] {
	const rows: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			const stat = statSync(path);
			rows.push(`${relative(dir, path)} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	if (existsSync(dir)) {
		walk(dir);
	}
	return rows;
}

function holdLockWithLiveProcess(profile = "default"): void {
	holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	if (holder.pid === undefined) {
		throw new Error("the holder process did not start");
	}
	mkdirSync(profileDir(profile), { recursive: true });
	writeFileSync(lockPath(profile), `${JSON.stringify({ pid: holder.pid, host: hostname(), token: "held-by-test" })}\n`);
}

function markFile(host: Host, profile = "default"): string {
	return join(profileDir(profile), `hook-nudged-${host}.json`);
}

describe("agx hook: what each host receives", () => {
	beforeEach(() => {
		seedStore();
	});

	it("stop, Claude Code: decision block with the nudge as the reason", async () => {
		const run = await hook("stop", "claude");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stderr).toBe("");
		expect(onlyDocument(run)).toEqual({ decision: "block", reason: ALL_UNREAD });
	});

	it("stop, Codex: decision block with the nudge as the reason", async () => {
		const run = await hook("stop", "codex");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stderr).toBe("");
		expect(onlyDocument(run)).toEqual({ decision: "block", reason: ALL_UNREAD });
	});

	it("stop, Cursor: followup_message with the nudge", async () => {
		const run = await hook("stop", "cursor");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stderr).toBe("");
		expect(onlyDocument(run)).toEqual({ followup_message: ALL_UNREAD });
	});

	it("session-start, Claude Code and Codex: hookSpecificOutput.additionalContext", async () => {
		for (const host of ["claude", "codex"] as const) {
			const run = await hook("session-start", host);
			expect(run.code).toBe(EXIT.ok);
			expect(run.stderr).toBe("");
			expect(onlyDocument(run)).toEqual({
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ALL_UNREAD },
			});
		}
	});

	it("session-start, Cursor: additional_context", async () => {
		const run = await hook("session-start", "cursor");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stderr).toBe("");
		expect(onlyDocument(run)).toEqual({ additional_context: ALL_UNREAD });
	});

	it("prompt, Claude Code and Codex: hookSpecificOutput.additionalContext for UserPromptSubmit", async () => {
		for (const host of ["claude", "codex"] as const) {
			const run = await hook("prompt", host);
			expect(run.code).toBe(EXIT.ok);
			expect(run.stderr).toBe("");
			expect(onlyDocument(run)).toEqual({
				hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ALL_UNREAD },
			});
		}
	});

	it("prompt, Cursor: nothing, because its prompt hook has no field that adds context", async () => {
		expectSilent(await hook("prompt", "cursor"));
		expect(existsSync(markFile("cursor"))).toBe(false);
	});

	it("names the profile in the commands when it is not the default one", async () => {
		seedStore("work");
		const run = await hook("stop", "claude", { profile: "work" });
		const prefix = "agx --profile work";
		expect(onlyDocument(run)).toEqual({
			decision: "block",
			reason: `agx has 2 unread messages. Threads with unread messages: thread-b, thread-a. ${prefix} threads lists every thread; ${prefix} thread <id> shows one, and ${prefix} thread <id> --mark-read marks it read once it is handled.`,
		});
	});
});

describe("agx hook: counts and thread ids only", () => {
	beforeEach(() => {
		const store = new MessageStore(profileDir("default"));
		const ids = ["a", "b", "c", "d", "e", "f", "g"];
		ids.forEach((letter, index) => {
			store.addInbound({ id: `in-${letter}`, peer: PEER, subject: SUBJECT, contextId: `thread-${letter}`, text: BODY, at: at(10 + index) });
		});
		store.addInbound({ id: "in-unsafe", peer: PEER, subject: SUBJECT, contextId: UNSAFE_CONTEXT, text: BODY, at: at(20) });
		store.addInbound({ id: "in-long", peer: PEER, subject: SUBJECT, contextId: LONG_CONTEXT, text: BODY, at: at(21) });
		store.addInbound({ id: "in-none", peer: PEER, subject: SUBJECT, contextId: null, text: BODY, at: at(22) });
		store.hold(STRANGER, { id: "held-1", peer: STRANGER, subject: null, contextId: null, text: HELD_BODY, at: at(23) });
		store.flush();
	});

	const COMBOS: Array<[Event, Host]> = [
		["stop", "claude"],
		["stop", "codex"],
		["stop", "cursor"],
		["session-start", "claude"],
		["session-start", "codex"],
		["session-start", "cursor"],
		["prompt", "claude"],
		["prompt", "codex"],
	];

	it.each(COMBOS)("%s for %s prints no peer text, subject, address, unsafe or long thread id", async (event, host) => {
		const run = await hook(event, host);
		expect(run.code).toBe(EXIT.ok);
		expect(`${run.stdout}${run.stderr}`).not.toBe("");
		const output = `${run.stdout}${run.stderr}`;
		for (const forbidden of [BODY, SUBJECT, HELD_BODY, "MARKER-7316", "UNSAFE", LONG_CONTEXT, "xxxxxxxx", PEER, STRANGER, "npub1", "in-unsafe", "in-long"]) {
			expect(output).not.toContain(forbidden);
		}
	});

	it("counts every unread message but names at most five threads, newest first, and only safe short ids", async () => {
		const run = await hook("stop", "claude");
		expect(onlyDocument(run)).toEqual({
			decision: "block",
			reason: `agx has 10 unread messages. Threads with unread messages: thread-g, thread-f, thread-e, thread-d, thread-c and 2 more. ${TAIL}`,
		});
	});

	it("leaves the thread sentence out when no unread message has a thread id it can name", async () => {
		const store = new MessageStore(profileDir("quiet"));
		store.addInbound({ id: "in-only", peer: PEER, subject: SUBJECT, contextId: null, text: BODY, at: at(1) });
		store.flush();
		const run = await hook("stop", "claude", { profile: "quiet" });
		const prefix = "agx --profile quiet";
		expect(onlyDocument(run)).toEqual({
			decision: "block",
			reason: `agx has 1 unread message. ${prefix} threads lists every thread; ${prefix} thread <id> shows one, and ${prefix} thread <id> --mark-read marks it read once it is handled.`,
		});
	});
});

describe("agx hook: thread ids", () => {
	it("names a thread once, however many unread messages it has", async () => {
		addUnread("in-x1", "thread-x", 1);
		addUnread("in-x2", "thread-x", 2);
		addUnread("in-y", "thread-y", 3);
		addUnread("in-x3", "thread-x", 4);
		const run = await hook("stop", "claude");
		expect(onlyDocument(run)).toEqual({
			decision: "block",
			reason: `agx has 4 unread messages. Threads with unread messages: thread-x, thread-y. ${TAIL}`,
		});
	});

	it("does not name a thread id that a stored line carries unsafely or marks as withheld", async () => {
		// Lines as an older, newer or hand-edited store could hold them: the reader checks again.
		const line = (id: string, contextId: string, withheld: boolean, minute: number): string =>
			JSON.stringify({ id, direction: "in", peer: PEER, subject: null, contextId, contextIdWithheld: withheld, text: BODY, at: at(minute), deliveryStatus: null, readAt: null });
		mkdirSync(profileDir("default"), { recursive: true });
		writeFileSync(
			join(profileDir("default"), "messages.jsonl"),
			`${line("in-raw-1", UNSAFE_CONTEXT, false, 1)}\n${line("in-raw-2", "thread-w", true, 2)}\n`,
		);
		const run = await hook("stop", "claude");
		expect(onlyDocument(run)).toEqual({ decision: "block", reason: `agx has 2 unread messages. ${TAIL}` });
		expect(run.stdout).not.toMatch(/UNSAFE|thread-w/);
	});
});

describe("agx hook: reads the store and never takes the profile lock", () => {
	beforeEach(() => {
		seedStore();
	});

	it("nudges while another live process holds the lock, and leaves that lock alone", async () => {
		holdLockWithLiveProcess();
		const lockBefore = readFileSync(lockPath("default"), "utf8");
		const run = await hook("stop", "claude");
		expect(run.code).toBe(EXIT.ok);
		expect(onlyDocument(run)).toEqual({ decision: "block", reason: ALL_UNREAD });
		expect(readFileSync(lockPath("default"), "utf8")).toBe(lockBefore);
	});

	it("does not create a lock file when nobody holds one", async () => {
		for (const event of ["stop", "session-start", "prompt"] as const) {
			await hook(event, "claude");
		}
		expect(existsSync(lockPath("default"))).toBe(false);
	});

	it("writes nothing but its own mark file, and nothing at all when it stays silent", async () => {
		const before = listing(box.home);
		const first = await hook("stop", "claude");
		expect(first.stdout).not.toBe("");
		const added = listing(box.home).filter((row) => !before.includes(row));
		expect(added).toHaveLength(1);
		expect(added[0]).toContain("hook-nudged-claude.json");

		const afterFirst = listing(box.home);
		expectSilent(await hook("stop", "claude"));
		expect(listing(box.home)).toEqual(afterFirst);
	});

	it("applies a thread marked read that another process has queued but not yet saved", async () => {
		holdLockWithLiveProcess();
		expect((await agx("thread", "thread-a", "--mark-read")).code).toBe(EXIT.ok);
		const run = await hook("stop", "claude");
		expect(onlyDocument(run)).toEqual({
			decision: "block",
			reason: `agx has 1 unread message. Threads with unread messages: thread-b. ${TAIL}`,
		});
	});
});

describe("agx hook: held senders and other mail that never nudges", () => {
	it("stays silent for a profile whose only mail is from held senders", async () => {
		const store = new MessageStore(profileDir("default"));
		store.hold(STRANGER, { id: "held-1", peer: STRANGER, subject: SUBJECT, contextId: "thread-held", text: HELD_BODY, at: at(1) });
		store.hold(toNpub("33".repeat(32)), { id: "held-2", peer: toNpub("33".repeat(32)), subject: null, contextId: null, text: HELD_BODY, at: at(2) });
		store.flush();
		const before = listing(box.home);
		for (const [event, host] of [
			["stop", "claude"], ["stop", "codex"], ["stop", "cursor"],
			["session-start", "claude"], ["session-start", "codex"], ["session-start", "cursor"],
			["prompt", "claude"], ["prompt", "codex"], ["prompt", "cursor"],
		] as Array<[Event, Host]>) {
			expectSilent(await hook(event, host));
		}
		expect(listing(box.home)).toEqual(before);
	});

	it("does not mention a held sender when there is also allowed mail", async () => {
		seedStore();
		const run = await hook("stop", "claude");
		const output = JSON.parse(run.stdout) as { reason: string };
		expect(output.reason).toBe(ALL_UNREAD);
		expect(output.reason).not.toMatch(/held|stranger|not on the allowlist/i);
	});

	it("stays silent when every inbound message is read and the rest are messages this profile sent", async () => {
		const store = new MessageStore(profileDir("default"));
		store.addInbound({ id: "in-1", peer: PEER, subject: null, contextId: "thread-a", text: BODY, at: at(1) });
		store.markRead({ ids: ["in-1"] });
		store.addOutbound({ id: "out-1", peer: PEER, subject: null, contextId: "thread-a", text: "my answer", at: at(2), deliveryStatus: "sent" });
		store.flush();
		expectSilent(await hook("stop", "claude"));
		expectSilent(await hook("session-start", "claude"));
	});

	it("stays silent for a profile that has no store at all", async () => {
		expectSilent(await hook("stop", "claude"));
		expectSilent(await hook("stop", "claude", { profile: "nobody" }));
	});
});

describe("agx hook: one nudge per new message", () => {
	beforeEach(() => {
		seedStore();
	});

	it("nudges once, stays silent for the same mail, and nudges again only for a new message", async () => {
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		expectSilent(await hook("stop", "claude"));
		expectSilent(await hook("stop", "claude"));
		expectSilent(await hook("prompt", "claude"));

		addUnread("in-4", "thread-d", 6);
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({
			decision: "block",
			reason: `agx has 1 new message (3 unread in all). Threads with new messages: thread-d. ${TAIL}`,
		});
		expectSilent(await hook("stop", "claude"));
	});

	it("shares one mark between stop and prompt: whichever fires first speaks", async () => {
		expect((onlyDocument(await hook("prompt", "claude")) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext).toBe(ALL_UNREAD);
		expectSilent(await hook("stop", "claude"));
	});

	it("keeps a mark per host, so each host is told once", async () => {
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		expect(onlyDocument(await hook("stop", "cursor"))).toEqual({ followup_message: ALL_UNREAD });
		expect(onlyDocument(await hook("stop", "codex"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		for (const host of ["claude", "cursor", "codex"] as const) {
			expect(existsSync(markFile(host))).toBe(true);
			expectSilent(await hook("stop", host));
		}
	});

	it("tells a new session about mail it already nudged earlier, then stays silent at turn end", async () => {
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		const start = await hook("session-start", "claude");
		expect(onlyDocument(start)).toEqual({
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ALL_UNREAD },
		});
		expectSilent(await hook("stop", "claude"));
	});

	it("forgets a message once it is read, and counts only what arrived since", async () => {
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		expect((await agx("thread", "thread-a", "--mark-read")).code).toBe(EXIT.ok);
		expectSilent(await hook("stop", "claude"));

		addUnread("in-5", "thread-e", 7);
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({
			decision: "block",
			reason: `agx has 1 new message (2 unread in all). Threads with new messages: thread-e. ${TAIL}`,
		});
		const mark = JSON.parse(readFileSync(markFile("claude"), "utf8")) as { version: number; nudged: string[] };
		expect(mark.version).toBe(1);
		expect([...mark.nudged].sort()).toEqual(["in-2", "in-5"]);
	});

	it("keeps only message ids in a private mark file inside the profile folder", async () => {
		await hook("stop", "claude");
		const path = markFile("claude");
		const text = readFileSync(path, "utf8");
		expect(JSON.parse(text)).toEqual({ version: 1, nudged: expect.any(Array) });
		for (const forbidden of [BODY, SUBJECT, HELD_BODY, "thread-", PEER, STRANGER, "npub1"]) {
			expect(text).not.toContain(forbidden);
		}
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("starts over from a damaged mark file with one nudge, and repairs it", async () => {
		mkdirSync(profileDir("default"), { recursive: true });
		writeFileSync(markFile("claude"), "{ not json");
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
		expectSilent(await hook("stop", "claude"));
	});
});

describe("agx hook: Cursor's stop hook after a turn that did not finish", () => {
	beforeEach(() => {
		seedStore();
	});

	it("stays silent, and does not use up the nudge, when the user stopped the turn or it failed", async () => {
		for (const status of ["aborted", "error"]) {
			expectSilent(await hook("stop", "cursor", { stdin: JSON.stringify({ status, loop_count: 0 }) }));
		}
		expect(existsSync(markFile("cursor"))).toBe(false);
		expect(onlyDocument(await hook("stop", "cursor"))).toEqual({ followup_message: ALL_UNREAD });
	});

	it("stays silent when Cursor sends nothing it can read", async () => {
		for (const stdin of [null, "", "not json", "[]", "{}"]) {
			expectSilent(await hook("stop", "cursor", { stdin }));
		}
		expect(existsSync(markFile("cursor"))).toBe(false);
	});
});

describe("agx hook: an error never blocks the host", () => {
	beforeEach(() => {
		seedStore();
	});

	it("exits 0 with no output when config.json cannot be read", async () => {
		writeFileSync(join(box.home, "config.json"), "{ this is not json");
		for (const event of ["stop", "session-start", "prompt"] as const) {
			expectSilent(await hook(event, "claude"));
		}
	});

	it("exits 0 with no output when the message store cannot be read", async () => {
		const dir = profileDir("broken");
		mkdirSync(join(dir, "messages.jsonl"), { recursive: true });
		for (const event of ["stop", "session-start", "prompt"] as const) {
			expectSilent(await hook(event, "claude", { profile: "broken" }));
		}
	});

	it("exits 0 with no output when AGX_HOME does not exist", async () => {
		process.env.AGX_HOME = join(box.home, "missing", "deeper");
		expectSilent(await hook("stop", "claude"));
		expect(existsSync(join(box.home, "missing"))).toBe(false);
	});

	it("exits 0 with no output for a profile name that is not one folder name, and reads no other folder", async () => {
		// Mail sits in the folder a ".." or "../other" name would reach.
		for (const dir of [join(box.home, "other"), box.home]) {
			mkdirSync(dir, { recursive: true });
			const store = new MessageStore(dir);
			store.addInbound({ id: `in-${dir.length}`, peer: PEER, subject: null, contextId: "thread-z", text: BODY, at: at(1) });
			store.flush();
		}
		for (const name of ["../other", "a b", "a/b", "..", ".", ".hidden"]) {
			expectSilent(await hook("stop", "claude", { profile: name }));
		}
	});

	it("says nothing, rather than nudge without a saved mark, when the mark cannot be written", async () => {
		// A folder where the mark file belongs: it can neither be read nor replaced.
		mkdirSync(markFile("claude"), { recursive: true });
		expectSilent(await hook("stop", "claude"));
		expectSilent(await hook("stop", "claude"));
		rmSync(markFile("claude"), { recursive: true });
		expect(onlyDocument(await hook("stop", "claude"))).toEqual({ decision: "block", reason: ALL_UNREAD });
	});
});

describe("agx hook: usage", () => {
	it("explains in --help that a hook cannot wake an agent that is idle", async () => {
		const run = await agx("hook", "--help");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toMatch(/cannot\s+wake\s+an\s+idle\s+agent/);
		for (const word of ["stop", "session-start", "prompt", "counts", "claude", "cursor", "codex"]) {
			expect(run.stdout).toContain(word);
		}
	});

	it("describes --host on each event", async () => {
		for (const event of ["stop", "session-start", "prompt"]) {
			const run = await agx("hook", event, "--help");
			expect(run.code).toBe(EXIT.ok);
			expect(run.stdout).toContain("--host <host>");
			expect(run.stdout).toMatch(/claude[\s\S]*cursor[\s\S]*codex/);
		}
	});

	// Controls: a wrong command line is a plain failure (exit 1, a message on stderr),
	// never exit 2, which Claude Code, Cursor and Codex all read as "block this".
	it.each([
		[["hook"]],
		[["hook", "stop"]],
		[["hook", "stop", "--host", "nope"]],
		[["hook", "nonsense", "--host", "claude"]],
		[["hook", "prompt", "--host"]],
	])("control: %j fails with exit 1, never 2, and prints nothing on stdout", async (args) => {
		const run = await agx(...args);
		expect(run.code).toBe(EXIT.generic);
		expect(run.stdout.includes("decision")).toBe(false);
	});
});
