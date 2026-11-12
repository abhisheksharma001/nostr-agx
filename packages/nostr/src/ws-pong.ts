import type { WebSocketImpl } from "./ws";

const MAX_PONG_BUFFER_BYTES = 64 * 1024;

type WsSocket = {
	bufferedAmount: number;
	on(event: "ping", listener: (data: unknown) => void): unknown;
	pong(data: unknown): unknown;
};

type WsConstructor = new (...args: any[]) => WsSocket;

function isWsConstructor(implementation: unknown): implementation is WsConstructor {
	if (typeof implementation !== "function") {
		return false;
	}
	const prototype = (implementation as { prototype?: Partial<WsSocket> }).prototype;
	return (
		typeof prototype?.on === "function" &&
		typeof prototype?.pong === "function"
	);
}

/** Bound automatic replies to a relay's pings. Non-`ws` implementations keep
 * their own ping policy. */
export function withBoundedPong<T extends WebSocketImpl>(implementation: T): T {
	if (!isWsConstructor(implementation)) {
		return implementation;
	}
	return new Proxy(implementation, {
		construct(target, args) {
			const nextArgs = [...args];
			const optionsIndex =
				typeof args[1] === "object" &&
				args[1] !== null &&
				!Array.isArray(args[1])
					? 1
					: 2;
			const current = args[optionsIndex];
			const options =
				typeof current === "object" && current !== null ? current : {};
			nextArgs[optionsIndex] = { ...options, autoPong: false };
			const socket = Reflect.construct(target, nextArgs);
			socket.on("ping", (data) => {
				if (socket.bufferedAmount < MAX_PONG_BUFFER_BYTES) {
					socket.pong(data);
				}
			});
			return socket;
		},
	}) as T;
}
