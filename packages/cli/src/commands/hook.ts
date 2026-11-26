import type { Readable } from "node:stream";
import { effectiveProfile, resolveProfileName } from "../lib/config.js";
import {
	allowedPeerKeys,
	buildNudge,
	HOOK_TIME_CAP_MS,
	type HookEvent,
	type HookHost,
	hookSupports,
	isHookProfileName,
	MAX_HOOK_INPUT_BYTES,
	nudgeableMessages,
	nudgeMarkPath,
	readNudgeMarks,
	renderForHost,
	stopInputAllowsNudge,
	writeNudgeMarks,
} from "../lib/hook.js";
import { identityExists, loadIdentityFile } from "../lib/identity.js";
import { emitStdoutJson } from "../lib/output.js";
import { toHexPubkey } from "../lib/peer.js";
import { profileDir } from "../lib/paths.js";
import { stdinIsTTY, stdinStream } from "../lib/stdin.js";
import { MessageStore } from "../lib/store/message-store.js";

export interface HookOptions {
	host: HookHost;
	profile?: string;
}

/** Tests only: a stdin of their own, and a shorter time cap. */
export interface HookDeps {
	stdin?: Readable;
	capMs?: number;
}

/**
 * The host's own input to a `stop` hook: it says whether the host is already continuing
 * because of a stop hook, and (Cursor) whether the turn finished. Null when there is no
 * input, it is too large, or it is not a JSON object.
 */
async function readHookInput(stream: Readable): Promise<Record<string, unknown> | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for await (const chunk of stream) {
			const piece = Buffer.from(chunk);
			size += piece.length;
			if (size > MAX_HOOK_INPUT_BYTES) {
				return null;
			}
			chunks.push(piece);
		}
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** What to print for this hook call, or null for nothing. Throws on any failure: the caller turns that into silence. */
async function decide(event: HookEvent, options: HookOptions, input: Readable | undefined): Promise<Record<string, unknown> | null> {
	if (!hookSupports(options.host, event)) {
		return null;
	}
	if (input !== undefined) {
		// Nothing is said when the host says it is already continuing because of a stop hook
		// (two agents that answer each other would never end a turn), and Cursor, which runs
		// `stop` after a turn the user stopped or that failed as well, hears only about a
		// finished turn: a follow-up would override the user's stop. Without readable input
		// that cannot be told, so there is nothing to say. Nothing is recorded either way: the
		// mail is announced at the next prompt, session start or ordinary turn end.
		const hostInput = stdinIsTTY() && input === stdinStream() ? null : await readHookInput(input);
		if (hostInput === null || !stopInputAllowsNudge(options.host, hostInput)) {
			return null;
		}
	}

	const profile = resolveProfileName(options.profile);
	if (!isHookProfileName(profile)) {
		return null;
	}
	// Only a sender on the allowlist as it is NOW counts: one taken off it after their mail
	// arrived does not nudge. An empty allowlist, or one the hook cannot read, means nothing to say.
	const allowed = allowedPeerKeys(effectiveProfile(profile).allow);
	if (allowed.size === 0) {
		return null;
	}
	// The profile's own messages never nudge, even when its own key is on its allowlist.
	const ownKey = identityExists(profile) ? toHexPubkey(loadIdentityFile(profile, { allowInsecurePerms: true }).publicKey) : null;
	// Read the store as `agx threads` does: no lock, nothing written. A thread another process
	// has queued as read but not yet saved is applied in memory only.
	const unread = nudgeableMessages(
		new MessageStore(profileDir(profile)).listMessages({ direction: "in", unreadOnly: true }),
		allowed,
		ownKey,
	);
	const path = nudgeMarkPath(profile, options.host);
	const marks = readNudgeMarks(path);
	if (marks.newerVersion) {
		// Written by a newer agx in a shape this one does not know: not overwritten, so no nudge.
		return null;
	}
	// A new session has no memory of an earlier nudge, so it hears about all unread mail.
	const announced = event === "session-start" ? new Set<string>() : marks.ids;
	const nudge = buildNudge(unread, announced, profile);
	if (nudge === null) {
		return null;
	}
	const payload = renderForHost(options.host, event, nudge.text);
	if (payload === null) {
		return null;
	}
	// The mark is saved before anything is printed: if it cannot be saved, the host hears
	// nothing, so a turn-end hook can never nudge again and again.
	writeNudgeMarks(path, unread.map((message) => message.id));
	return payload;
}

/**
 * `agx hook <event> --host <host>`: run by a coding agent's hook configuration. Prints at
 * most one JSON object in the host's own shape, and never fails: whatever goes wrong, and
 * whatever it was waiting for, the answer after {@link HOOK_TIME_CAP_MS} is "nothing to say",
 * exit 0. (Exit 2 would tell Claude Code, Cursor and Codex to block, so nothing here sets it.)
 */
export async function hookCommand(event: HookEvent, options: HookOptions, deps: HookDeps = {}): Promise<void> {
	// Only a `stop` hook reads the host's input: it carries the host's "already continuing" flag.
	const input = event === "stop" ? (deps.stdin ?? stdinStream()) : undefined;
	let timer: NodeJS.Timeout | undefined;
	const capped = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), deps.capMs ?? HOOK_TIME_CAP_MS);
	});
	let payload: Record<string, unknown> | null = null;
	try {
		payload = await Promise.race([decide(event, options, input), capped]);
	} catch {
		payload = null;
	} finally {
		clearTimeout(timer);
		// Stop listening: an open pipe would keep this process alive past the cap, and a read
		// that is still waiting ends here, so it cannot finish later and save a mark.
		input?.destroy();
	}
	if (payload !== null) {
		emitStdoutJson(payload);
	}
}
