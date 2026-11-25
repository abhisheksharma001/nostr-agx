import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeId } from "./inbound-lines.js";
import { profileDir, writePrivateJson } from "./paths.js";
import type { StoredMessage } from "./store/types.js";

/**
 * What `agx hook` says to a coding agent, and when. A hook runs inside the host's
 * turn, so everything here is small and quiet: one short line of counts and thread
 * ids, never what a peer wrote, and nothing at all when there is nothing new.
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

/** A thread id longer than this is not named: it is text a peer chose, so it stays short. */
export const MAX_THREAD_ID_LENGTH = 64;

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
 * Only counts and thread ids go in. A thread id is named only when it is a short,
 * safe id; the newest threads come first and at most {@link MAX_NAMED_THREADS} are named.
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
		if (
			id !== null &&
			!message.contextIdWithheld &&
			id.length <= MAX_THREAD_ID_LENGTH &&
			isSafeId(id) &&
			!threads.includes(id)
		) {
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

/** The ids already announced to a host. A missing or damaged file means none. */
export function readNudgeMarks(path: string): Set<string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const nudged = (parsed as { nudged?: unknown } | null)?.nudged;
		if (!Array.isArray(nudged)) {
			return new Set();
		}
		return new Set(nudged.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

/** Record the ids now announced. Message ids only, no text; throws when the file cannot be written. */
export function writeNudgeMarks(path: string, ids: readonly string[]): void {
	writePrivateJson(path, { version: MARK_VERSION, nudged: ids });
}
