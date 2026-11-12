import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { configureWebSocket } from "./ws";

const { implementations } = vi.hoisted(() => ({
	implementations: [] as unknown[],
}));

vi.mock("nostr-tools/relay", () => ({
	useWebSocketImplementation: (implementation: unknown) => {
		implementations.push(implementation);
	},
}));

const LIMIT = 64 * 1024;
const clients: WebSocket[] = [];
const servers: Array<WebSocketServer | net.Server> = [];
const connections = new Set<net.Socket>();

afterEach(async () => {
	for (const client of clients.splice(0)) {
		client.terminate();
	}
	for (const connection of connections) {
		connection.destroy();
	}
	connections.clear();
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
});

class FakeSocket extends EventEmitter {
	bufferedAmount = 0;
	readonly options: Record<string, unknown>;
	readonly pongs: unknown[] = [];

	constructor(_url: string, ...args: unknown[]) {
		super();
		const candidate = args.length === 1 ? args[0] : args[1];
		this.options =
			typeof candidate === "object" && candidate !== null
				? (candidate as Record<string, unknown>)
				: {};
	}

	pong(data: unknown): void {
		this.pongs.push(data);
	}
}

function configuredConstructor(
	implementation: unknown,
): new (...args: any[]) => any {
	configureWebSocket(implementation);
	return implementations.at(-1) as new (...args: any[]) => any;
}

async function listen<T extends WebSocketServer | net.Server>(
	server: T,
): Promise<string> {
	servers.push(server);
	if (server instanceof WebSocketServer) {
		await new Promise<void>((resolve) => server.once("listening", resolve));
	} else {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	}
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("relay did not bind");
	}
	return `ws://127.0.0.1:${address.port}`;
}

async function pingFloodRelay(): Promise<string> {
	const pings = Buffer.alloc(64 * 1024);
	for (let i = 0; i < pings.length; i += 2) {
		pings[i] = 0x89;
		pings[i + 1] = 0;
	}
	const server = net.createServer((socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => {});
		socket.once("data", (chunk) => {
			const key = /sec-websocket-key: *(\S+)/i.exec(chunk.toString())?.[1];
			if (!key) {
				socket.destroy();
				return;
			}
			const accept = createHash("sha1")
				.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			socket.pause();
			const pump = () => {
				while (!socket.destroyed && socket.write(pings)) {}
				if (!socket.destroyed) {
					socket.once("drain", pump);
				}
			};
			pump();
		});
	});
	return listen(server);
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("condition did not become true");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("WebSocket ping backpressure", () => {
	it("disables automatic pong without discarding other client options", () => {
		const Socket = configuredConstructor(FakeSocket);
		const socket = new Socket("ws://relay", {
			autoPong: true,
			handshakeTimeout: 1234,
		});
		expect(socket.options).toMatchObject({
			autoPong: false,
			handshakeTimeout: 1234,
		});
	});

	it("answers ordinary pings but stops when the outgoing queue reaches its cap", () => {
		const Socket = configuredConstructor(FakeSocket);
		const socket = new Socket("ws://relay");
		socket.emit("ping", "one");
		expect(socket.pongs).toEqual(["one"]);
		socket.bufferedAmount = LIMIT;
		socket.emit("ping", "two");
		expect(socket.pongs).toEqual(["one"]);
	});

	it("still answers an ordinary ping on a real ws socket", async () => {
		const server = new WebSocketServer({ port: 0, autoPong: false });
		const pong = new Promise<Buffer>((resolve, reject) => {
			server.on("connection", (socket) => {
				socket.once("pong", resolve);
				socket.once("error", reject);
				socket.ping("hello");
			});
		});
		const url = await listen(server);
		const Socket = configuredConstructor(WebSocket);
		const client = new Socket(url) as WebSocket;
		clients.push(client);
		await expect(Promise.race([
			pong,
			new Promise((_, reject) => setTimeout(() => reject(new Error("no pong")), 3000)),
		])).resolves.toEqual(Buffer.from("hello"));
	});

	it("bounds queued pongs when a real relay floods pings and never reads", async () => {
		const url = await pingFloodRelay();
		const Socket = configuredConstructor(WebSocket);
		const client = new Socket(url) as WebSocket;
		clients.push(client);
		await waitFor(() => client.bufferedAmount >= LIMIT);
		const queued = client.bufferedAmount;
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client.bufferedAmount).toBeLessThanOrEqual(LIMIT + 1024);
		expect(queued).toBeGreaterThanOrEqual(LIMIT);
	}, 10_000);
});
