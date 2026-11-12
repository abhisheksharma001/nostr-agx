import { useWebSocketImplementation } from "nostr-tools/relay";

/**
 * WebSocket injection. Browsers and edge runtimes can use their global. Node
 * hosts must inject the `ws` package: Node's own WebSocket comes from undici,
 * where relay-controlled frames and handshake headers have caused process exits.
 */

/** A WHATWG-compatible WebSocket constructor (e.g. the Node `ws` package's
 * default export, or the browser/edge global). nostr-tools' setter is untyped, so
 * this stays structural. */
export type WebSocketImpl = unknown;

let configured = false;

function globalWebSocket(): unknown {
	return typeof globalThis === "undefined"
		? undefined
		: (globalThis as { WebSocket?: unknown }).WebSocket;
}

function isNodeNativeWebSocket(impl: unknown): boolean {
	return (
		impl === globalWebSocket() &&
		(globalThis as { process?: { versions?: { undici?: string } } }).process?.versions?.undici !== undefined &&
		typeof (impl as { prototype?: { on?: unknown } }).prototype?.on !== "function"
	);
}

function assertSafeNodeWebSocket(impl: unknown): void {
	if (isNodeNativeWebSocket(impl)) {
		throw new Error("Node's own WebSocket is refused (a relay can crash it): pass ws (the ws package's WebSocket)");
	}
}

/** Configure the WebSocket implementation for relay connections. On Node, pass
 * the `ws` package; its native `WebSocket` is refused. In a browser/edge runtime,
 * omit to use the global. Idempotent — a repeat call with the same intent is a no-op. */
export function configureWebSocket(impl?: WebSocketImpl): void {
	if (impl) {
		assertSafeNodeWebSocket(impl);
		useWebSocketImplementation(
			impl as Parameters<typeof useWebSocketImplementation>[0],
		);
		configured = true;
		return;
	}
	if (configured) {
		return;
	}
	const globalImpl = globalWebSocket();
	if (globalImpl !== undefined) {
		assertSafeNodeWebSocket(globalImpl);
		configured = true;
	}
}
