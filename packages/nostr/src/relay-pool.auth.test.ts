import { type Event, finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GIFT_WRAP_KIND } from "./kinds";
import {
	fetchByAuthorWithStatus,
	listenEvents,
	pollInbox,
	publishToRelays,
} from "./relay-pool";
import { type AgxSigner, localSigner } from "./signer";
import { configureWebSocket } from "./ws";

// These tests use the REAL nostr-tools relay client against a small relay that
// listens on a loopback port. relay-pool.test.ts replaces the client with a
// stand-in, and the failure pinned here lives inside the client: when a relay
// sends an AUTH challenge, nostr-tools signs a reply and keeps a promise for the
// relay's answer to it. If the connection is closed first, or the relay answers
// "no", that promise is rejected and nobody is listening, so Node ends the
// whole process. A stand-in client cannot show that.

beforeAll(() => {
	configureWebSocket(WebSocket);
});

const ME = getPublicKey(generateSecretKey());
/** How long the relay waits before it answers the client's REQ or EVENT. The AUTH
 * reply is on the wire well within this, and still unanswered when the answer
 * arrives and the client closes the connection. */
const ANSWER_DELAY_MS = 50;
/** A turn of the event loop is enough for Node to report an unhandled rejection;
 * this leaves room for a slow machine. */
const SETTLE_MS = 80;

interface RelayBehaviour {
	/** Send `["AUTH", challenge]` when the first REQ or EVENT arrives. */
	challenge: boolean;
	/** What the relay says to the client's own AUTH event. */
	authReply: "silent" | "accept" | "refuse";
	/** What the relay says to an EVENT. */
	eventReply: "accept" | "auth-required" | "invalid";
}

interface LoopbackRelay {
	url: string;
	/** Every frame the relay received, in order. */
	frames: unknown[][];
	close(): Promise<void>;
}

const openRelays: LoopbackRelay[] = [];

async function startRelay(
	behaviour: Partial<RelayBehaviour> = {},
): Promise<LoopbackRelay> {
	const b: RelayBehaviour = {
		challenge: true,
		authReply: "silent",
		eventReply: "accept",
		...behaviour,
	};
	const frames: unknown[][] = [];
	const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise((resolve) => wss.once("listening", resolve));
	wss.on("connection", (socket) => {
		let challenged = false;
		const send = (frame: unknown[]) => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(frame));
			}
		};
		socket.on("message", (raw) => {
			const frame = JSON.parse(raw.toString()) as unknown[];
			frames.push(frame);
			if (frame[0] === "AUTH") {
				const id = (frame[1] as { id: string }).id;
				if (b.authReply === "accept") {
					send(["OK", id, true, ""]);
				} else if (b.authReply === "refuse") {
					send(["OK", id, false, "restricted: this key is not on the list"]);
				}
				return;
			}
			if (frame[0] !== "REQ" && frame[0] !== "EVENT") {
				return;
			}
			if (b.challenge && !challenged) {
				challenged = true;
				send(["AUTH", "challenge-1"]);
			}
			setTimeout(() => {
				if (frame[0] === "REQ") {
					send(["EOSE", frame[1] as string]);
					return;
				}
				const id = (frame[1] as { id: string }).id;
				if (b.eventReply === "accept") {
					send(["OK", id, true, ""]);
				} else if (b.eventReply === "auth-required") {
					send(["OK", id, false, "auth-required: sign in first"]);
				} else {
					send(["OK", id, false, "invalid: event too large"]);
				}
			}, ANSWER_DELAY_MS);
		});
	});
	const relay: LoopbackRelay = {
		url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
		frames,
		close: async () => {
			for (const client of wss.clients) {
				client.terminate();
			}
			await new Promise((resolve) => wss.close(resolve));
		},
	};
	openRelays.push(relay);
	return relay;
}

// Node reports a rejection nobody handled to `unhandledRejection`; by default
// that ends the process. Vitest listens too, and would fail the whole run
// instead of the one test, so its listeners step aside while a test runs and
// the rejections are collected here and asserted on.
const unhandled: unknown[] = [];
const collect = (reason: unknown) => {
	unhandled.push(reason);
};
let displaced: NodeJS.UnhandledRejectionListener[] = [];

beforeEach(() => {
	unhandled.length = 0;
	displaced = process.listeners("unhandledRejection");
	process.removeAllListeners("unhandledRejection");
	process.on("unhandledRejection", collect);
});

afterEach(async () => {
	process.off("unhandledRejection", collect);
	for (const listener of displaced) {
		process.on("unhandledRejection", listener);
	}
	await Promise.all(openRelays.splice(0).map((r) => r.close()));
});

/** Let any rejection the last call left behind reach `unhandledRejection`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

function signedEvent(): Event {
	return finalizeEvent(
		{ kind: GIFT_WRAP_KIND, created_at: 1_700_000_000, tags: [["p", ME]], content: "x" },
		generateSecretKey(),
	);
}

const signer = () => localSigner(generateSecretKey());

describe("publishing to a relay that sends an AUTH challenge", () => {
	it("counts the event as published when the relay accepts it, whatever it does with our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, total: 1, rejected: [] });
		expect(unhandled.map(String)).toEqual([]);
	});

	it("reports a relay that wants AUTH as a normal per-relay refusal", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "auth-required" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		expect(res.rejected).toEqual([
			{
				relay: relay.url,
				error: "auth-required: sign in first",
				kind: "refused",
			},
		]);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("still delivers to the other relays in the list", async () => {
		const wantsAuth = await startRelay({ authReply: "silent", eventReply: "auth-required" });
		const plain = await startRelay({ challenge: false });
		const res = await publishToRelays(
			[wantsAuth.url, plain.url],
			signedEvent(),
			signer(),
		);
		await settle();

		expect(res.ok).toBe(true);
		expect(res.accepted).toBe(1);
		expect(res.total).toBe(2);
		expect(res.rejected.map((r) => r.relay)).toEqual([wantsAuth.url]);
		expect(plain.frames.some((f) => f[0] === "EVENT")).toBe(true);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("is not brought down by a relay that answers our AUTH reply with a refusal", async () => {
		const relay = await startRelay({ authReply: "refuse", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(unhandled.map(String)).toEqual([]);
	});
});

describe("reading from a relay that sends an AUTH challenge", () => {
	it("answers a lookup by author", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const res = await fetchByAuthorWithStatus({
			relays: [relay.url],
			author: ME,
			kinds: [10002],
			signer: signer(),
		});
		await settle();

		expect(res).toEqual({ events: [], answered: 1 });
		expect(unhandled.map(String)).toEqual([]);
	});

	it("completes an inbox poll", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const res = await pollInbox({
			relays: [relay.url],
			pubkey: ME,
			since: 1000,
			signer: signer(),
		});
		await settle();

		expect(res).toEqual({ events: [], complete: true });
		expect(unhandled.map(String)).toEqual([]);
	});
});

describe("listening on a relay that sends an AUTH challenge", () => {
	it("keeps listening when the relay refuses our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "refuse" });
		const subs = await listenEvents(signer(), [relay.url], { pubkey: ME }, () => {});
		await settle();
		const stillOpen = subs.map((s) => s.relay.connected);
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expect(stillOpen).toEqual([true]);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("can be stopped while the relay has not answered our AUTH reply", async () => {
		const relay = await startRelay({ authReply: "silent" });
		const subs = await listenEvents(signer(), [relay.url], { pubkey: ME }, () => {});
		await settle();
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(true);
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}
		await settle();

		expect(unhandled.map(String)).toEqual([]);
	});
});

describe("a signer that is slower than the relay", () => {
	// A remote signer can take longer to sign the AUTH reply than the relay takes
	// to answer the event. By then the connection is closed; nostr-tools sends the
	// reply anyway, and the failed send is an unhandled rejection.
	const SLOW_SIGNER_MS = 150;
	const slowSigner = (): AgxSigner => {
		const inner = signer();
		return {
			...inner,
			signEvent: async (template) => {
				await new Promise((resolve) => setTimeout(resolve, SLOW_SIGNER_MS));
				return inner.signEvent(template);
			},
		};
	};

	it("does not send, or fail on, an AUTH reply it finishes signing after the connection is closed", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), slowSigner());
		await new Promise((resolve) => setTimeout(resolve, SLOW_SIGNER_MS + SETTLE_MS));

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("still sends the AUTH reply when the connection is still open", async () => {
		const relay = await startRelay({ authReply: "accept" });
		const subs = await listenEvents(slowSigner(), [relay.url], { pubkey: ME }, () => {});
		await new Promise((resolve) => setTimeout(resolve, SLOW_SIGNER_MS + SETTLE_MS));
		for (const sub of subs) {
			sub.close();
			sub.relay.close();
		}

		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(true);
		expect(unhandled.map(String)).toEqual([]);
	});
});

describe("controls: what must keep working", () => {
	it("a relay that never sends an AUTH challenge still takes the event", async () => {
		const relay = await startRelay({ challenge: false });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, total: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("a relay that refuses for another reason is still a refusal with its own reason", async () => {
		const relay = await startRelay({ challenge: false, eventReply: "invalid" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());

		expect(res.ok).toBe(false);
		expect(res.rejected).toEqual([
			{ relay: relay.url, error: "invalid: event too large", kind: "refused" },
		]);
	});

	it("still answers the challenge with a signed AUTH event for this relay", async () => {
		const relay = await startRelay({ authReply: "accept", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent(), signer());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		const auth = relay.frames.find((f) => f[0] === "AUTH");
		expect(auth).toBeDefined();
		const authEvent = (auth as unknown[])[1] as Event;
		expect(authEvent.kind).toBe(22242);
		expect(authEvent.tags).toContainEqual(["challenge", "challenge-1"]);
		const relayTag = authEvent.tags.find((t) => t[0] === "relay");
		expect(relayTag?.[1]).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/?$/);
		expect(unhandled.map(String)).toEqual([]);
	});

	it("without a signer the challenge is left alone and the event still goes through", async () => {
		const relay = await startRelay({ authReply: "silent", eventReply: "accept" });
		const res = await publishToRelays([relay.url], signedEvent());
		await settle();

		expect(res).toMatchObject({ ok: true, accepted: 1, rejected: [] });
		expect(relay.frames.some((f) => f[0] === "AUTH")).toBe(false);
		expect(unhandled.map(String)).toEqual([]);
	});
});
