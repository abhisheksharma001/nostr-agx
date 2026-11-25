import type { Readable } from "node:stream";
import { resolveProfileName } from "../lib/config.js";
import {
	buildNudge,
	HOOK_TIME_CAP_MS,
	type HookEvent,
	type HookHost,
	hookSupports,
	isHookProfileName,
	MAX_HOOK_INPUT_BYTES,
	nudgeMarkPath,
	readNudgeMarks,
	renderForHost,
	writeNudgeMarks,
} from "../lib/hook.js";
import { emitStdoutJson } from "../lib/output.js";
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

/** Set once the time cap has passed, so work that was still waiting changes nothing. */
interface Expiry {
	expired: boolean;
}

/**
 * The host's own input, when the hook has to read it: Cursor's `stop` input says whether
 * the turn finished. Null when there is no input, it is too large, or it is not a JSON object.
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
async function decide(event: HookEvent, options: HookOptions, input: Readable | undefined, expiry: Expiry): Promise<Record<string, unknown> | null> {
	if (!hookSupports(options.host, event)) {
		return null;
	}
	if (input !== undefined) {
		// Cursor runs `stop` after a turn the user stopped or that failed as well. Only a
		// finished turn is told anything: a follow-up would override the user's stop.
		const hostInput = stdinIsTTY() && input === stdinStream() ? null : await readHookInput(input);
		if (expiry.expired || hostInput === null || hostInput.status !== "completed") {
			return null;
		}
	}

	const profile = resolveProfileName(options.profile);
	if (!isHookProfileName(profile)) {
		return null;
	}
	// Read the store as `agx threads` does: no lock, nothing written. A thread another process
	// has queued as read but not yet saved is applied in memory only.
	const unread = new MessageStore(profileDir(profile)).listMessages({ direction: "in", unreadOnly: true });
	const path = nudgeMarkPath(profile, options.host);
	// A new session has no memory of an earlier nudge, so it hears about all unread mail.
	const announced = event === "session-start" ? new Set<string>() : readNudgeMarks(path);
	const nudge = buildNudge(unread, announced, profile);
	if (nudge === null || expiry.expired) {
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
	const expiry: Expiry = { expired: false };
	// Only Cursor's `stop` input is read; Claude Code and Codex hooks need nothing from it.
	const input = event === "stop" && options.host === "cursor" ? (deps.stdin ?? stdinStream()) : undefined;
	let timer: NodeJS.Timeout | undefined;
	const capped = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			expiry.expired = true;
			resolve(null);
		}, deps.capMs ?? HOOK_TIME_CAP_MS);
	});
	let payload: Record<string, unknown> | null = null;
	try {
		payload = await Promise.race([decide(event, options, input, expiry), capped]);
	} catch {
		payload = null;
	} finally {
		clearTimeout(timer);
		// Stop listening: an open pipe would keep this process alive past the cap.
		input?.destroy();
	}
	if (payload !== null && !expiry.expired) {
		emitStdoutJson(payload);
	}
}
