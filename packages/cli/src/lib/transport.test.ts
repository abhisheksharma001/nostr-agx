import { createServer, type Socket } from "node:net";
import { withBoundedPong } from "@nostr-agx/nostr";
import { describe, expect, it } from "vitest";
import { withHandshakeTimeout } from "./transport.js";

describe("withHandshakeTimeout", () => {
	it("gives up on a relay that takes the connection and never answers, and lets the socket go", async () => {
		// A relay that accepts TCP and never answers the WebSocket upgrade.
		const held = new Set<Socket>();
		const relay = createServer((socket) => {
			held.add(socket);
			socket.on("close", () => held.delete(socket));
		});
		await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
		const { port } = relay.address() as { port: number };
		try {
			const Timed = withHandshakeTimeout(200);
			const socket = new Timed(`ws://127.0.0.1:${port}`);
			const error = await new Promise<Error>((resolve) => socket.on("error", resolve));
			expect(error.message).toMatch(/handshake has timed out/);
			await new Promise((r) => setTimeout(r, 100));
			expect(socket.readyState).toBe(socket.CLOSED);
		} finally {
			for (const socket of held) {
				socket.destroy();
			}
			relay.close();
		}
	});

	it("forwards automatic-pong disablement through the handshake-timeout subclass", () => {
		const Timed = withBoundedPong(withHandshakeTimeout(200));
		const socket = new Timed("ws://127.0.0.1:1");
		socket.on("error", () => {});
		try {
			expect((socket as unknown as { _autoPong: boolean })._autoPong).toBe(false);
		} finally {
			socket.terminate();
		}
	});
});
