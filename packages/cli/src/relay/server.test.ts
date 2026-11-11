import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { startRelay, type RelayEvent, type RunningRelay } from "./server.js";

const relays: RunningRelay[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) {
		socket.terminate();
	}
	await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

async function connect(port: number): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}`);
	sockets.push(socket);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
}

function nextMessage(socket: WebSocket, timeoutMs = 1_000): Promise<unknown[]> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("timed out waiting for relay message"));
		}, timeoutMs);
		const onMessage = (data: RawData) => {
			cleanup();
			try {
				resolve(JSON.parse(data.toString()) as unknown[]);
			} catch (error) {
				reject(error);
			}
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once("message", onMessage);
		socket.once("error", onError);
	});
}

function publish(socket: WebSocket, event: RelayEvent): Promise<unknown[]> {
	const response = nextMessage(socket);
	socket.send(JSON.stringify(["EVENT", event]));
	return response;
}

function makeEvent(id: string, recipient: string): RelayEvent {
	return {
		id,
		pubkey: "sender",
		created_at: Math.floor(Date.now() / 1_000),
		kind: 1059,
		tags: [["p", recipient]],
		content: "",
		sig: "",
	};
}

describe("development relay subscriptions", () => {
	it("delivers matching published events until the client closes the subscription", async () => {
		const relay = await startRelay({ port: 0 });
		relays.push(relay);
		const subscriber = await connect(relay.port);
		const publisher = await connect(relay.port);

		subscriber.send(
			JSON.stringify([
				"REQ",
				"inbox",
				{ kinds: [1059], "#p": ["recipient"] },
			]),
		);
		expect(await nextMessage(subscriber)).toEqual(["EOSE", "inbox"]);

		const noOtherRecipient = expect(
			nextMessage(subscriber, 50),
		).rejects.toThrow("timed out");
		expect(
			await publish(publisher, makeEvent("other-recipient", "other")),
		).toEqual(["OK", "other-recipient", true, ""]);
		await noOtherRecipient;

		const matching = makeEvent("matching-event", "recipient");
		const liveEvent = nextMessage(subscriber);
		await publish(publisher, matching);
		expect(await liveEvent).toEqual([
			"EVENT",
			"inbox",
			matching,
		]);

		subscriber.send(JSON.stringify(["CLOSE", "inbox"]));
		expect(await nextMessage(subscriber)).toEqual(["CLOSED", "inbox", ""]);
		const noPostCloseEvent = expect(
			nextMessage(subscriber, 50),
		).rejects.toThrow("timed out");
		await publish(publisher, makeEvent("after-close", "recipient"));
		await noPostCloseEvent;
	});
});
