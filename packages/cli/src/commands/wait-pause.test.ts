import { existsSync } from "node:fs";
import { DEFAULT_CONTENT_TYPE, DEFAULT_POLL_OVERLAP_SEC } from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveProfile, updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { loadIdentity } from "../lib/identity.js";
import { INBOX_SUMMARY_SCHEMA, type InboxReport, type InboxSummary } from "../lib/inbox.js";
import { setJsonMode } from "../lib/output.js";
import { profileDir, seenPath } from "../lib/paths.js";
import { toHexPubkey } from "../lib/peer.js";
import { setRuntimeForTests } from "../lib/runtime.js";
import { loadState, updateState } from "../lib/state.js";
import { MessageStore } from "../lib/store/message-store.js";
import { createTransport, makeLogger } from "../lib/transport.js";
import { type RelayOptions, type RunningRelay, startRelay } from "../relay/server.js";
import { agx, capture, jsonDocuments, sandbox } from "../test/helpers.js";
import { waitCommand } from "./wait.js";

// While the saved allowlist cannot be read, `agx wait` authorises nobody and pauses: it asks the
// relays for nothing, so nothing is stored, held, marked seen or returned, and its place in the
// inbox stays where it was. It still waits out `--timeout`, and what arrived meanwhile is read once
// the list reads cleanly again. The loop's own pause between turns is replaced here, so a test can
// act at an exact turn (break the list, repair it, stop) instead of guessing at a clock.

/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
const WARNING = "The allowlist cannot be read";
const PAUSED = "polling is paused";
const RESUMED = "The allowlist can be read again";
/** NIP-59 gift wrap: what a wait loop asks a relay for, once per turn. */
const GIFT_WRAP_KIND = 1059;

/** The last poll was an hour ago. A poll that runs moves this to now; a pause leaves it. */
const STALE_CURSOR = Math.floor(Date.now() / 1000) - 3600;
/** How far before its cursor a poll asks: the overlap, plus the most a gift wrap's time may be set back. */
const LOOKBACK_SEC = DEFAULT_POLL_OVERLAP_SEC + MAX_WRAP_BACKDATE_SEC;
const sleepFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Filters = Parameters<NonNullable<RelayOptions["onRequest"]>>[0];

/** Runs inside `createTransport`, once: after the start-up read of the list and before the first turn. */
const seam = vi.hoisted(() => ({ beforeTransport: undefined as (() => void) | undefined }));
vi.mock("../lib/transport.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/transport.js")>();
	return {
		...actual,
		createTransport: async (...args: Parameters<typeof actual.createTransport>) => {
			const hook = seam.beforeTransport;
			seam.beforeTransport = undefined;
			hook?.();
			return actual.createTransport(...args);
		},
	};
});

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let controllers: AbortController[];
let pendingWaits: Promise<unknown>[];
let restoreRuntime: (() => void) | undefined;
const requests: Filters[] = [];

beforeEach(async () => {
	box = sandbox();
	requests.length = 0;
	relay = await startRelay({
		port: 0,
		onRequest: (filters) => {
			requests.push(filters);
		},
	});
	controllers = [];
	pendingWaits = [];
});

afterEach(async () => {
	for (const controller of controllers) {
		controller.abort();
	}
	await Promise.allSettled(pendingWaits);
	restoreRuntime?.();
	restoreRuntime = undefined;
	seam.beforeTransport = undefined;
	setJsonMode(false);
	process.exitCode = undefined;
	await relay.close();
	box.restore();
});

const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

async function newProfile(name: string): Promise<string> {
	expect((await agx("--profile", name, "identity", "new")).code).toBe(EXIT.ok);
	expect((await agx("--profile", name, "config", "set", "relays", relayUrl())).code).toBe(EXIT.ok);
	const shown = await agx("--profile", name, "identity", "show");
	const npub = /npub1[0-9a-z]+/.exec(shown.stdout)?.[0];
	if (!npub) {
		throw new Error(`no npub for ${name}`);
	}
	return npub;
}

/** A sender the receiver's list names, and the receiver. */
async function allowedPair(): Promise<{ sender: string; receiver: string; named: string[] }> {
	const sender = await newProfile("sender");
	const receiver = await newProfile("receiver");
	expect((await agx("--profile", "receiver", "identity", "allow", sender)).code).toBe(EXIT.ok);
	return { sender, receiver, named: [toHexPubkey(sender, "test sender")] };
}

async function publish(fromProfile: string, to: string, text: string): Promise<void> {
	const profile = effectiveProfile(fromProfile);
	const identity = loadIdentity(fromProfile);
	const transport = await createTransport(profile, identity, makeLogger(false));
	try {
		const result = await transport.publishMessage(toHexPubkey(to, "test recipient"), {
			text,
			subject: null,
			contextId: null,
			contentType: DEFAULT_CONTENT_TYPE,
		});
		if (!result.ok) {
			throw new Error("test publish failed");
		}
	} finally {
		await transport.stop?.();
	}
}

/** The requests that read the receiver's inbox since the log was last cleared: one per turn that polls, or two when it finds mail. */
function inboxPolls(): Filters[] {
	const key = loadIdentity("receiver").publicKey;
	return requests.filter((filters) =>
		filters.some((f) => f.kinds?.includes(GIFT_WRAP_KIND) && (f["#p"] as string[] | undefined)?.includes(key)),
	);
}

/**
 * Runs `hook(n)` in place of the loop's n-th pause between turns, then pauses for a moment of real
 * time so the relay still answers. Sleep n is the end of turn n: a hook that changes the list at
 * sleep n changes what turn n + 1 reads.
 */
function onEverySleep(hook: (n: number) => void | Promise<void>): void {
	let n = 0;
	restoreRuntime = setRuntimeForTests({
		sleep: async (_ms, signal) => {
			if (signal?.aborted) {
				throw signal.reason;
			}
			n += 1;
			await hook(n);
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (signal?.aborted) {
				throw signal.reason;
			}
		},
	});
}

function startWait(options: { profile: string; timeout: string; summary?: boolean }) {
	const controller = new AbortController();
	controllers.push(controller);
	setJsonMode(true);
	const done = capture(() => waitCommand({ ...options, signal: controller.signal })).then((result) => {
		const code = Number(process.exitCode ?? EXIT.ok);
		process.exitCode = undefined;
		return { ...result, code };
	});
	pendingWaits.push(done);
	return { controller, done };
}

function report(run: { stdout: string }): InboxReport & { timedOut: boolean } {
	return jsonDocuments(run.stdout).at(-1) as InboxReport & { timedOut: boolean };
}

function summary(run: { stdout: string }): InboxSummary & { timedOut: boolean } {
	return jsonDocuments(run.stdout).at(-1) as InboxSummary & { timedOut: boolean };
}

const times = (text: string, part: string): number => text.split(part).length - 1;
const receiverStore = () => new MessageStore(profileDir("receiver"));

describe("agx wait while the saved allowlist cannot be read", () => {
	it("asks the relays for nothing and waits out --timeout with the normal result", async () => {
		const pair = await allowedPair();
		await publish("sender", pair.receiver, "sent while paused");
		// The list breaks while it still names the sender, before the first poll: every turn is paused.
		seam.beforeTransport = () => updateProfile("receiver", { allow: [...pair.named, JUNK] });
		let turns = 0;
		onEverySleep((n) => {
			turns = n;
		});
		requests.length = 0;

		const run = await startWait({ profile: "receiver", timeout: "1", summary: true }).done;

		expect.soft(turns).toBeGreaterThan(3);
		expect.soft(run.code).toBe(EXIT.ok);
		expect.soft(summary(run)).toMatchObject({ schema: INBOX_SUMMARY_SCHEMA, new: 0, held: 0, timedOut: true });
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(times(run.stderr, WARNING)).toBe(1);
		// It ended the normal way, but it has not polled: the write at the end records no poll.
		expect.soft(loadState("receiver").lastPumpAt).toBeNull();
	});

	it("stores nothing, holds nothing and marks nothing as seen", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60" });
		onEverySleep(async (n) => {
			if (n === 1) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
				await publish("sender", pair.receiver, "sent while paused");
			}
			if (n === 4) {
				waiting.controller.abort();
			}
		});

		await waiting.done;

		expect.soft(receiverStore().listMessages()).toEqual([]);
		expect.soft(receiverStore().listHeld()).toEqual([]);
		expect.soft(existsSync(seenPath("receiver"))).toBe(false);
	});

	it("leaves the place in the inbox where it was, and records no poll after the break", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60" });
		let cursorAtBreak = -1;
		let pumpAtBreak: string | null = null;
		onEverySleep(async (n) => {
			if (n === 1) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
				await publish("sender", pair.receiver, "sent while paused");
				cursorAtBreak = loadState("receiver").cursor;
				pumpAtBreak = loadState("receiver").lastPumpAt;
				// A second further on, so a poll that moved the cursor would show.
				await sleepFor(1100);
			}
			if (n === 4) {
				waiting.controller.abort();
			}
		});

		await waiting.done;

		expect(cursorAtBreak).toBeGreaterThan(0);
		expect.soft(loadState("receiver").cursor).toBe(cursorAtBreak);
		expect.soft(loadState("receiver").lastPumpAt).toBe(pumpAtBreak);
	});

	it("says once that nobody is authorised and polling is paused, without printing the entry", async () => {
		const pair = await allowedPair();
		onEverySleep((n) => {
			if (n === 1) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
			}
		});

		const run = await startWait({ profile: "receiver", timeout: "1" }).done;

		expect.soft(times(run.stderr, WARNING)).toBe(1);
		expect.soft(run.stderr).toContain("nobody is authorised");
		expect.soft(run.stderr).toContain(PAUSED);
		expect.soft(run.stderr).toContain("agx doctor --local");
		// Nothing was held, so there is nothing to release: no `agx held allow` step to point at.
		expect.soft(run.stderr).not.toContain("held allow");
		expect.soft(times(run.stderr, RESUMED)).toBe(0);
		expect.soft(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
	});

	it("returns what waited on the relay once the list reads cleanly again, each message once, and says polling resumes", async () => {
		const pair = await allowedPair();
		let pollsWhilePaused = -1;
		let cursorWhilePaused = -1;
		let cursorAtBreak = -1;
		onEverySleep(async (n) => {
			if (n === 1) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
				await publish("sender", pair.receiver, "sent while paused");
				requests.length = 0;
				cursorAtBreak = loadState("receiver").cursor;
				// A second further on, so a poll that moved the cursor would show.
				await sleepFor(1100);
			}
			if (n === 4) {
				// Three turns have gone by with the list unreadable.
				pollsWhilePaused = inboxPolls().length;
				cursorWhilePaused = loadState("receiver").cursor;
				updateProfile("receiver", { allow: pair.named });
			}
		});

		const run = await startWait({ profile: "receiver", timeout: "30" }).done;

		expect.soft(run.code).toBe(EXIT.ok);
		expect.soft(pollsWhilePaused).toBe(0);
		expect.soft(cursorWhilePaused).toBe(cursorAtBreak);
		expect.soft(report(run)).toMatchObject({ timedOut: false, truncated: false });
		expect.soft(report(run).messages.map((m) => m.text)).toEqual(["sent while paused"]);
		expect.soft(receiverStore().listMessages({ direction: "in" }).map((m) => m.text)).toEqual(["sent while paused"]);
		expect.soft(receiverStore().listHeld()).toEqual([]);
		expect.soft(times(run.stderr, WARNING)).toBe(1);
		expect.soft(times(run.stderr, RESUMED)).toBe(1);
		expect.soft(`${run.stdout}${run.stderr}`).not.toContain(JUNK);

		// Read it, and the next run finds nothing new: it does not come back a second time.
		const contextId = report(run).messages[0]?.contextId ?? "";
		expect((await agx("--profile", "receiver", "thread", contextId, "--mark-read")).code).toBe(EXIT.ok);
		const next = await startWait({ profile: "receiver", timeout: "1" }).done;
		expect(report(next)).toMatchObject({ timedOut: true, messages: [] });
		expect(receiverStore().listMessages({ direction: "in" })).toHaveLength(1);
	});

	it("says so again, and only once more, when the list breaks again after it was fixed", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60" });
		onEverySleep((n) => {
			if (n === 1 || n === 5) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
			}
			if (n === 3) {
				updateProfile("receiver", { allow: pair.named });
			}
			if (n === 8) {
				waiting.controller.abort();
			}
		});

		const run = await waiting.done;

		expect.soft(run.code).toBe(EXIT.interrupted);
		expect.soft(times(run.stderr, WARNING)).toBe(2);
		expect.soft(times(run.stderr, RESUMED)).toBe(1);
		expect.soft(`${run.stdout}${run.stderr}`).not.toContain(JUNK);
	});

	it("stops at once when interrupted while paused, and leaves the message for the next run", async () => {
		const pair = await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60" });
		let cursorAtBreak = -1;
		onEverySleep(async (n) => {
			if (n === 1) {
				updateProfile("receiver", { allow: [...pair.named, JUNK] });
				await publish("sender", pair.receiver, "sent while paused");
				cursorAtBreak = loadState("receiver").cursor;
			}
			if (n === 3) {
				waiting.controller.abort();
			}
		});

		const run = await waiting.done;

		expect.soft(run.code).toBe(EXIT.interrupted);
		expect.soft(receiverStore().listMessages()).toEqual([]);
		expect.soft(receiverStore().listHeld()).toEqual([]);
		expect.soft(loadState("receiver").cursor).toBe(cursorAtBreak);

		// The list is repaired; the next run takes the message, once.
		restoreRuntime?.();
		restoreRuntime = undefined;
		updateProfile("receiver", { allow: pair.named });
		const next = await startWait({ profile: "receiver", timeout: "10" }).done;
		expect(next.code).toBe(EXIT.ok);
		expect(report(next).messages.map((m) => m.text)).toEqual(["sent while paused"]);
		expect(receiverStore().listMessages({ direction: "in" })).toHaveLength(1);
	});

	it("is paused from the first turn when the list breaks between the start-up read and the first poll", async () => {
		await allowedPair();
		updateState("receiver", { cursor: STALE_CURSOR });
		seam.beforeTransport = () => updateProfile("receiver", { allow: [JUNK] });
		requests.length = 0;

		const run = await startWait({ profile: "receiver", timeout: "1" }).done;

		// No poll, no stored mail, and still the normal timeout result: the relays did answer the probe.
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(run.code).toBe(EXIT.ok);
		expect.soft(report(run)).toMatchObject({ timedOut: true, messages: [], truncated: false });
		expect.soft(times(run.stderr, WARNING)).toBe(1);
		expect.soft(run.stderr).toContain(PAUSED);
		expect.soft(loadState("receiver").cursor).toBe(STALE_CURSOR);
		expect.soft(loadState("receiver").lastPumpAt).toBeNull();
	});

	it("resumes from the cursor it had when it was paused from the first turn", async () => {
		const pair = await allowedPair();
		updateState("receiver", { cursor: STALE_CURSOR });
		await publish("sender", pair.receiver, "sent before the first turn");
		seam.beforeTransport = () => updateProfile("receiver", { allow: [JUNK] });
		let pollsWhilePaused = -1;
		onEverySleep((n) => {
			if (n === 3) {
				pollsWhilePaused = inboxPolls().length;
				updateProfile("receiver", { allow: pair.named });
				requests.length = 0;
			}
		});
		requests.length = 0;

		const run = await startWait({ profile: "receiver", timeout: "30" }).done;

		expect.soft(pollsWhilePaused).toBe(0);
		// The first request after the repair asks from where the last poll left off, not from now.
		expect.soft(inboxPolls()[0]?.[0]?.since).toBe(STALE_CURSOR - LOOKBACK_SEC);
		expect.soft(report(run).messages.map((m) => m.text)).toEqual(["sent before the first turn"]);
		expect.soft(times(run.stderr, WARNING)).toBe(1);
		expect.soft(times(run.stderr, RESUMED)).toBe(1);
		expect.soft(receiverStore().listMessages({ direction: "in" })).toHaveLength(1);
	});
});

describe("agx wait while the saved allowlist reads cleanly", () => {
	it("asks the relays on every turn", async () => {
		await allowedPair();
		const waiting = startWait({ profile: "receiver", timeout: "60" });
		let polls = 0;
		onEverySleep((n) => {
			if (n === 3) {
				polls = inboxPolls().length;
				waiting.controller.abort();
			}
		});

		const run = await waiting.done;

		expect(run.code).toBe(EXIT.interrupted);
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(run.stderr).not.toContain(PAUSED);
	});
});
