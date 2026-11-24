import { createServer, type Socket } from "node:net";
import { Agent } from "node:http";
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

	it("forwards the proxy wrapper's constructor options instead of dropping them", () => {
		// createProxyWebSocket passes its SOCKS agent in as the THIRD
		// constructor argument. A subclass that dropped it made zero proxy
		// connections while relayProxyUrl still reported the proxy — traffic
		// left directly. `ws` records its request synchronously on `_req`, so
		// the agent's arrival is assertable without opening a real socket.
		const agent = new Agent();
		const Timed = withHandshakeTimeout(200);
		const socket = new Timed("ws://127.0.0.1:1", undefined, { agent });
		socket.on("error", () => {});
		try {
			expect(
				(socket as { _req?: { agent?: unknown } })._req?.agent,
			).toBe(agent);
		} finally {
			socket.terminate();
		}
	});
});
