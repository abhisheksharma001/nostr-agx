import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHexPubkey } from "./peer.js";
import { profileDir } from "./paths.js";
import type { StoredMessage } from "./store/types.js";

/**
 * What `agx hook` says to a coding agent, and when. A hook runs inside the host's
 * turn, so everything here is small and quiet: one short line of counts and thread
 * ids, never what a peer wrote, and nothing at all when there is nothing new.
 *
 * Whatever is printed becomes part of another agent's prompt (on Codex a Stop hook's
 * text is read as a new user prompt, on Cursor as the next user message). So a thread
 * id is printed only when it is a UUID, the form agx itself makes: any other id is
 * words a peer chose.
 */

export const HOOK_HOSTS = ["claude", "cursor", "codex"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export const HOOK_EVENTS = ["stop", "session-start", "prompt"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** After this long a hook gives up and prints nothing: the host is waiting on it. */
export const HOOK_TIME_CAP_MS = 3000;

/** More than this much input from the host is not read: it is not what the host documents. */
export const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

/** Thread ids named in one nudge; the rest are only counted. */
export const MAX_NAMED_THREADS = 5;

/** The only thread ids a nudge names: 8-4-4-4-12 hex digits, in either case. No other id is printed. */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One folder name made of letters, digits, dot, dash and underscore, not starting with a dot. */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Whether a hook can say something to `host` on `event`. Cursor's prompt hook has no field that adds context. */
export function hookSupports(host: HookHost, event: HookEvent): boolean {
	return !(host === "cursor" && event === "prompt");
}

/** Whether `name` is a profile name a hook will read a folder for. */
export function isHookProfileName(name: string): boolean {
	return PROFILE_NAME_RE.test(name);
}

/** The pubkeys on an allowlist, as hex. An entry that is not a public key is ignored, never an error. */
export function allowedPeerKeys(entries: readonly string[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of entries) {
		try {
			keys.add(toHexPubkey(entry, "allowlist entry"));
		} catch {
			// Not a key `serve` could match either: it names nobody.
		}
	}
	return keys;
}

/**
 * The unread messages worth a nudge: from a sender on the CURRENT allowlist, and not from
 * `ownKey` (this profile's own key, when it is on its own allowlist). A sender is compared
 * as a key, whatever form it was stored or listed in; one that is not a key is left out.
 */
export function nudgeableMessages(
	unread: readonly StoredMessage[],
	allowed: ReadonlySet<string>,
	ownKey: string | null,
): StoredMessage[] {
	return unread.filter((message) => {
		let from: string;
		try {
			from = toHexPubkey(message.peer, "sender");
		} catch {
			return false;
		}
		return allowed.has(from) && from !== ownKey;
	});
}

/**
 * Whether a `stop` hook may speak, given the host's own input. False when the host says it
 * is already continuing because of a stop hook: speaking then could keep two agents that
 * answer each other going forever. The field is the one each host documents (2026-11-26):
 * Claude Code and Codex `stop_hook_active`, Cursor `loop_count` (0 for the first stop of a
 * turn). Anything but the documented "not continuing" value counts as continuing.
 */
export function stopInputAllowsNudge(host: HookHost, input: Record<string, unknown>): boolean {
	if (host === "cursor") {
		return input.status === "completed" && (input.loop_count === undefined || input.loop_count === 0);
	}
	return input.stop_hook_active === undefined || input.stop_hook_active === false;
}

export interface Nudge {
	text: string;
}

function messages(count: number): string {
	return count === 1 ? "message" : "messages";
}

/**
 * The nudge for the unread inbound messages in `unread` (oldest first), or null when
 * every one of them has been announced already. `announced` holds their ids.
 *
 * Only counts and thread ids go in. A thread id is named only when it is a UUID; the
 * newest threads come first and at most {@link MAX_NAMED_THREADS} are named. A message
 * whose thread id is anything else is counted, and its id is not shown.
 */
export function buildNudge(
	unread: readonly StoredMessage[],
	announced: ReadonlySet<string>,
	profile: string,
): Nudge | null {
	const fresh = unread.filter((m) => !announced.has(m.id));
	if (fresh.length === 0) {
		return null;
	}
	const everyUnreadIsNew = fresh.length === unread.length;

	const threads: string[] = [];
	for (const message of [...fresh].reverse()) {
		const id = message.contextId;
		if (id !== null && !message.contextIdWithheld && THREAD_ID_RE.test(id) && !threads.includes(id)) {
			threads.push(id);
		}
	}
	const named = threads.slice(0, MAX_NAMED_THREADS);
	const more = threads.length - named.length;

	const command = profile === "default" ? "agx" : `agx --profile ${profile}`;
	const head = everyUnreadIsNew
		? `agx has ${unread.length} unread ${messages(unread.length)}.`
		: `agx has ${fresh.length} new ${messages(fresh.length)} (${unread.length} unread in all).`;
	const list =
		named.length === 0
			? ""
			: ` Threads with ${everyUnreadIsNew ? "unread" : "new"} messages: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
	const tail = ` ${command} threads lists every thread; ${command} thread <id> shows one, and ${command} thread <id> --mark-read marks it read once it is handled.`;
	return { text: `${head}${list}${tail}` };
}

/**
 * The JSON `host` reads from a hook's stdout for `event`, or null when `host` has no
 * hook that can take it. Shapes are from each host's hook documentation, read
 * 2026-11-26: see docs/hooks.md for the pages.
 */
export function renderForHost(host: HookHost, event: HookEvent, text: string): Record<string, unknown> | null {
	if (!hookSupports(host, event)) {
		return null;
	}
	if (event === "stop") {
		return host === "cursor" ? { followup_message: text } : { decision: "block", reason: text };
	}
	if (event === "session-start") {
		return host === "cursor"
			? { additional_context: text }
			: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
	}
	return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
}

/** Where a host's record of the messages it was told about lives: in the profile folder, one file per host. */
export function nudgeMarkPath(profile: string, host: HookHost): string {
	return join(profileDir(profile), `hook-nudged-${host}.json`);
}

const MARK_VERSION = 1;

export interface NudgeMarks {
	/** The ids already announced. Empty when the file is missing or damaged. */
	ids: Set<string>;
	/** True when a newer agx wrote the file: its shape is not known, so it is left alone. */
	newerVersion: boolean;
}

/** The ids already announced to a host. A missing or damaged file means none. */
export function readNudgeMarks(path: string): NudgeMarks {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const record = parsed as { version?: unknown; nudged?: unknown } | null;
		if (typeof record?.version === "number" && record.version > MARK_VERSION) {
			return { ids: new Set(), newerVersion: true };
		}
		const nudged = record?.nudged;
		if (!Array.isArray(nudged)) {
			return { ids: new Set(), newerVersion: false };
		}
		return { ids: new Set(nudged.filter((id): id is string => typeof id === "string")), newerVersion: false };
	} catch {
		return { ids: new Set(), newerVersion: false };
	}
}

/**
 * Record the ids now announced: message ids only, no text. Throws when the file cannot be
 * written. The folder and the file's mode are never changed: the profile folder belongs to
 * the user (the shared private-file writer would put it back to 0700), and the temporary
 * file is created private. A failed write removes its temporary file.
 */
export function writeNudgeMarks(path: string, ids: readonly string[]): void {
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify({ version: MARK_VERSION, nudged: ids }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}
