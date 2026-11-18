import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgxClient, DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { hexToBytes, localSigner, NostrTransport } from "@nostr-agx/nostr";
import kleur from "kleur";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, type IdentityFile, saveIdentity } from "../lib/identity.js";
import { profileDir, seenPath } from "../lib/paths.js";
import { loadState, updateState } from "../lib/state.js";
import { MAX_NEW_SENDERS_PER_HOUR, MessageStore } from "../lib/store/message-store.js";
import { type RelayOptions, type RunningRelay, startRelay } from "../relay/server.js";
import { agx, sandbox } from "../test/helpers.js";

// While the saved allowlist cannot be read, `agx serve` authorises nobody and pauses: it asks the
// relays for nothing, so nothing is stored, held, marked seen, answered or run, and its place in the
// inbox stays where it was. What arrived meanwhile is read once the list reads cleanly again.
// Real `serve --once` runs over an in-process relay on a free port, with throwaway identities.

/** Not a key: what a hand edit gone wrong leaves in the list. Distinctive, so a test can see whether it is printed. */
const JUNK = "pasted-entry-MARKER-7f3a";
/** What the fixed warning says about the pause. */
const PAUSED = "polling is paused";
/** NIP-59 gift wrap: what a serve or wait loop asks a relay for, once per poll. */
const GIFT_WRAP_KIND = 1059;
/** The last poll was an hour ago. A poll that runs moves this to now; a pause leaves it. */
const STALE_CURSOR = Math.floor(Date.now() / 1000) - 3600;

type Filters = Parameters<NonNullable<RelayOptions["onRequest"]>>[0];

let box: ReturnType<typeof sandbox>;
let relay: RunningRelay;
let receiver: IdentityFile;
let ally: IdentityFile;
let stranger: IdentityFile;
const requests: Filters[] = [];

const relayUrl = () => `ws://127.0.0.1:${relay.port}`;

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(async () => {
	box = sandbox();
	requests.length = 0;
	relay = await startRelay({
		port: 0,
		onRequest: (filters) => {
			requests.push(filters);
		},
	});
	receiver = createIdentity();
	ally = createIdentity();
	stranger = createIdentity();
	saveIdentity("default", receiver);
	updateProfile("default", { relays: [relayUrl()], allow: [ally.publicKey] });
	updateState("default", { cursor: STALE_CURSOR });
});

afterEach(async () => {
	await relay.close();
	box.restore();
});

/** The requests that read the receiver's inbox since the last serve run began: a poll makes one, or two when it finds mail. */
const inboxPolls = (): Filters[] =>
	requests.filter((filters) =>
		filters.some((f) => f.kinds?.includes(GIFT_WRAP_KIND) && (f["#p"] as string[] | undefined)?.includes(receiver.publicKey)),
	);

/** A message from `from` to the receiver, left on the relay for the next poll. */
async function sendMessage(from: IdentityFile, text: string): Promise<void> {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	try {
		const sent = await transport.publishMessage(receiver.npub, {
			text,
			subject: null,
			contextId: null,
			contentType: DEFAULT_CONTENT_TYPE,
		});
		expect(sent.ok).toBe(true);
	} finally {
		await transport.stop();
	}
}

/**
 * A task request from `from` for the receiver's built-in `invoice.review`, left on the relay.
 * `answer()` polls for what the receiver sends back and gives up after `ms`; `stop()` ends the sender.
 */
async function sendTaskRequest(from: IdentityFile) {
	const transport = await NostrTransport.create({
		signer: localSigner(hexToBytes(from.secretKeyHex)),
		relays: [relayUrl()],
		ws: WebSocket,
	});
	const client = new AgxClient({ transport, startCursor: Math.floor(Date.now() / 1000) - 60 });
	const before = relay.events().length;
	let outcome: { value?: unknown; error?: unknown } | undefined;
	client.request(receiver.npub, "invoice.review", { amount: 100 }, { timeoutMs: 30_000 }).then(
		(value) => {
			outcome = { value };
		},
		(error) => {
			outcome = { error };
		},
	);
	const published = Date.now() + 10_000;
	while (relay.events().length === before) {
		if (Date.now() > published) {
			throw new Error("the task request never reached the relay");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return {
		async answer(ms = 8_000): Promise<unknown> {
			const deadline = Date.now() + ms;
			while (outcome === undefined && Date.now() < deadline) {
				await client.pump();
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (outcome === undefined) {
				throw new Error("the sender got no answer");
			}
			if ("error" in outcome) {
				throw outcome.error;
			}
			return outcome.value;
		},
		async stop(): Promise<void> {
			await client.stop().catch(() => undefined);
			await transport.stop();
		},
	};
}

/**
 * A `--handler` module that rewrites the saved allowlist when serve loads it. That is after serve
 * has read the list at start-up and before its first poll: where a hand edit lands in a running serve.
 */
function allowlistEditedAtLoad(allow: string[]): string {
	const path = join(box.home, "edit-allowlist.mjs");
	writeFileSync(
		path,
		[
			'import { readFileSync, writeFileSync } from "node:fs";',
			"const file = `${process.env.AGX_HOME}/config.json`;",
			'const config = JSON.parse(readFileSync(file, "utf8"));',
			`config.profiles.default.allow = ${JSON.stringify(allow)};`,
			"writeFileSync(file, JSON.stringify(config));",
			"export default {};",
		].join("\n"),
	);
	return path;
}

/** One poll of a serve whose saved allowlist becomes `allow` right before it. */
async function serveOnceEditing(allow: string[], ...flags: string[]) {
	requests.length = 0;
	const run = await agx("serve", "--once", "--no-reply", "--handler", allowlistEditedAtLoad(allow), ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

/** One poll of a serve that starts with the allowlist as it is saved now. */
async function serveOnce(...flags: string[]) {
	requests.length = 0;
	const run = await agx("serve", "--once", "--no-reply", ...flags);
	expect(run.code, run.stderr).toBe(0);
	return run.stdout;
}

const stored = () => new MessageStore(profileDir("default"));
const inboxTexts = () => stored().listMessages({ direction: "in" }).map((m) => m.text);
const heldFrom = (sender: IdentityFile) => stored().listHeld().find((h) => h.npub === sender.npub);
const times = (text: string, part: string): number => text.split(part).length - 1;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));

describe("agx serve while the saved allowlist cannot be read", () => {
	it("asks the relays for nothing", async () => {
		await sendMessage(ally, "waits on the relay");

		await serveOnceEditing([JUNK]);

		expect(inboxPolls()).toHaveLength(0);
	});

	it("stores nothing and holds nothing: what arrived is still on the relay for later", async () => {
		await sendMessage(ally, "from a listed peer");
		await sendMessage(stranger, "from a stranger");

		await serveOnceEditing([JUNK]);

		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(stored().listHeld()).toEqual([]);
	});

	it("marks nothing as seen", async () => {
		await sendMessage(ally, "from a listed peer");

		await serveOnceEditing([JUNK]);

		expect(existsSync(seenPath("default"))).toBe(false);
	});

	it("leaves the place in the inbox where it was, and records no poll", async () => {
		await sendMessage(ally, "from a listed peer");

		await serveOnceEditing([JUNK]);

		expect.soft(loadState("default").cursor).toBe(STALE_CURSOR);
		expect.soft(loadState("default").lastPumpAt).toBeNull();
	});

	it("does not answer a task request: no DENY, no ALLOW, nothing runs", async () => {
		const sender = await sendTaskRequest(ally);

		const out = await serveOnceEditing([JUNK]);
		await sender.stop();

		expect.soft(out).not.toMatch(/DENY\s+task/);
		expect.soft(out).not.toMatch(/ALLOW\s+task/);
		expect.soft(out).not.toMatch(/TASK\s+invoice\.review/);
	});

	it("shows nothing as received, whether or not --allowed-only is set", async () => {
		await sendMessage(ally, "from a listed peer");
		await sendMessage(stranger, "from a stranger");

		const plain = await serveOnceEditing([JUNK]);
		const guarded = await serveOnceEditing([JUNK], "--allowed-only");

		for (const out of [plain, guarded]) {
			expect.soft(out).not.toMatch(/RECV/);
			expect.soft(out).not.toMatch(/HOLD/);
			expect.soft(out).not.toContain("from a listed peer");
			expect.soft(out).not.toContain("from a stranger");
		}
	});

	it("says once that nobody is authorised and polling is paused, without printing the entry", async () => {
		const out = await serveOnceEditing([JUNK]);

		expect.soft(times(out, "The allowlist cannot be read")).toBe(1);
		expect.soft(out).toContain("nobody is authorised");
		expect.soft(out).toContain(PAUSED);
		expect.soft(out).toContain("agx doctor --local");
		// Nothing was held, so there is nothing to release: no `agx held allow` step to point at.
		expect.soft(out).not.toContain("held allow");
		expect.soft(out).not.toContain(JUNK);
	});

	it("never prints a secret key left in the list", async () => {
		const out = await serveOnceEditing([NSEC]);

		expect(out).toContain("The allowlist cannot be read");
		const secret = NSEC.slice(5);
		for (let i = 0; i + 10 <= secret.length; i += 5) {
			expect(out.toLowerCase()).not.toContain(secret.slice(i, i + 10));
		}
	});

	it("is paused all the same when the list is already unreadable at start-up: one warning, no poll", async () => {
		await sendMessage(ally, "waits on the relay");
		updateProfile("default", { allow: [JUNK] });

		const out = await serveOnce();

		expect.soft(times(out, "The allowlist cannot be read")).toBe(1);
		expect.soft(out).toContain(PAUSED);
		// "Empty" would be the wrong thing to say, and `agx identity allow` cannot fix an unreadable list.
		expect.soft(out).not.toContain("The allowlist is empty");
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(inboxTexts()).toEqual([]);
		expect.soft(stored().listHeld()).toEqual([]);
		expect.soft(loadState("default").cursor).toBe(STALE_CURSOR);
	});

	it("is paused under --no-tasks too", async () => {
		await sendMessage(ally, "waits on the relay");
		updateProfile("default", { allow: [JUNK] });

		const out = await serveOnce("--no-tasks");

		expect.soft(out).toContain(PAUSED);
		expect.soft(out).not.toMatch(/RECV/);
		expect.soft(inboxPolls()).toHaveLength(0);
		expect.soft(stored().listHeld()).toEqual([]);
	});

	it("answers a task request sent during the outage once the list reads cleanly again", async () => {
		const sender = await sendTaskRequest(ally);

		await serveOnceEditing([JUNK]);
		updateProfile("default", { allow: [ally.publicKey] });
		const resumed = await serveOnce();

		expect.soft(resumed).toMatch(/ALLOW\s+task invoice\.review/);
		expect.soft(resumed).toMatch(/TASK\s+invoice\.review/);
		await expect(sender.answer()).resolves.toMatchObject({ ok: true, capability: "invoice.review" });
		await sender.stop();
	});

	it("reads what waited on the relay once the list reads cleanly again: each message once and none twice", async () => {
		await sendMessage(ally, "first, sent while paused");
		await sendMessage(ally, "second, sent while paused");
		await serveOnceEditing([JUNK], "--allowed-only");
		expect(inboxPolls()).toHaveLength(0);

		updateProfile("default", { allow: [ally.publicKey] });
		await serveOnce();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(inboxTexts().sort()).toEqual(["first, sent while paused", "second, sent while paused"]);
		expect(stored().listHeld()).toEqual([]);
		expect(loadState("default").cursor).toBeGreaterThan(STALE_CURSOR);

		// Nothing is delivered a second time, whether the next poll comes at once or after a new message.
		const again = await serveOnce();
		expect(again).not.toMatch(/RECV/);
		await sendMessage(ally, "third, sent after");
		const later = await serveOnce();
		expect(later.match(/RECV/g)).toHaveLength(1);
		expect(inboxTexts().sort()).toEqual(["first, sent while paused", "second, sent while paused", "third, sent after"]);
	});

	it("applies the list as repaired, not as it was: a peer taken off while it could not be read is held afterwards", async () => {
		await sendMessage(ally, "sent by a peer taken off the list");
		updateProfile("default", { allow: [ally.publicKey, JUNK] });

		await serveOnce("--allowed-only");
		expect(inboxPolls()).toHaveLength(0);

		updateProfile("default", { allow: [] });
		const out = await serveOnce("--allowed-only");

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/HOLD\s+from .*not on the allowlist/);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(ally)?.messages.map((m) => m.text)).toEqual(["sent by a peer taken off the list"]);
	});

	it("reads a message from a peer that was blocked once and allowed again, instead of dropping it", async () => {
		// A decision made long ago: blocking records the sender, and allowing the peer again does not clear it.
		expect((await agx("held", "block", stranger.npub)).code).toBe(0);
		expect((await agx("identity", "allow", stranger.npub)).code).toBe(0);
		expect(getProfile("default").allow).toContain(stranger.publicKey);
		await sendMessage(stranger, "sent while paused");
		const both = [ally.publicKey, stranger.publicKey];

		await serveOnceEditing([...both, JUNK]);
		updateProfile("default", { allow: both });
		await serveOnce();

		expect(inboxTexts()).toEqual(["sent while paused"]);
	});

	it("loses no mail from listed senders to the limit on new held senders", async () => {
		const senders = Array.from({ length: MAX_NEW_SENDERS_PER_HOUR + 1 }, () => createIdentity());
		const keys = senders.map((sender) => sender.publicKey);
		updateProfile("default", { allow: keys });
		for (const [i, sender] of senders.entries()) {
			await sendMessage(sender, `from sender ${i}`);
		}

		await serveOnceEditing([...keys, JUNK]);
		updateProfile("default", { allow: keys });
		await serveOnce();

		expect(inboxTexts().sort()).toEqual(senders.map((_, i) => `from sender ${i}`).sort());
	});
});

describe("agx serve when the saved allowlist reads cleanly", () => {
	it("polls and authorises a peer the list names", async () => {
		await sendMessage(ally, "from a listed peer");
		const sender = await sendTaskRequest(ally);

		const out = await serveOnceEditing([ally.publicKey], "--allowed-only");
		await sender.stop();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/ALLOW\s+task invoice\.review/);
		expect(out).toMatch(/TASK\s+invoice\.review/);
		expect(inboxTexts()).toContain("from a listed peer");
		expect(out).not.toContain(PAUSED);
		expect(loadState("default").cursor).toBeGreaterThan(STALE_CURSOR);
		expect(loadState("default").lastPumpAt).not.toBeNull();
	});

	it("polls when the list is empty, and holds a stranger: an empty list is a list", async () => {
		await sendMessage(stranger, "from a stranger");

		const out = await serveOnceEditing([], "--allowed-only");

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/HOLD\s+from .*not on the allowlist/);
		expect(out).not.toContain(PAUSED);
		expect(heldFrom(stranger)?.messages.map((m) => m.text)).toEqual(["from a stranger"]);
	});
});

describe("agx serve --allow-all while the saved allowlist cannot be read", () => {
	// `--allow-all` accepts task requests from anyone whatever the list says, so an unreadable list
	// takes nothing away from it. The poll goes on; no sender is on the list, so every sender is held.
	it("keeps polling: a task request from a stranger still runs, and a message is held", async () => {
		await sendMessage(stranger, "from a stranger");
		const sender = await sendTaskRequest(stranger);

		const out = await serveOnceEditing([JUNK], "--allow-all", "--allowed-only");
		await sender.stop();

		expect(inboxPolls().length).toBeGreaterThan(0);
		expect(out).toMatch(/TASK\s+invoice\.review/);
		expect(out).toContain("The allowlist cannot be read");
		expect(out).not.toContain(PAUSED);
		expect(out).not.toContain(JUNK);
		expect(inboxTexts()).toEqual([]);
		expect(heldFrom(stranger)?.messages.map((m) => m.text)).toContain("from a stranger");
	});
});
