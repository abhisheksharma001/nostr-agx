import { useWebSocketImplementation } from "nostr-tools/relay";

/**
 * WebSocket injection. Browsers and edge runtimes can use their global. Node
 * hosts must inject an EventEmitter-style implementation such as the `ws` package:
 * Node's own WebSocket comes from undici, where relay-controlled frames and
 * handshake headers have caused process exits. Other WHATWG/EventTarget-style
 * constructors, including bound constructors, are refused on Node as well.
 */

/** A WHATWG-compatible WebSocket constructor (e.g. the Node `ws` package's
 * default export, or the browser/edge global). nostr-tools' setter is untyped, so
 * this stays structural. */
export type WebSocketImpl = unknown;

type ConfiguredWebSocket = Parameters<typeof useWebSocketImplementation>[0];

let configured = false;

function globalWebSocket(): unknown {
	return typeof globalThis === "undefined"
		? undefined
		: (globalThis as { WebSocket?: unknown }).WebSocket;
}

function isUnsafeNodeWebSocket(impl: unknown): boolean {
	const prototype = (impl as { prototype?: { on?: unknown; [Symbol.toStringTag]?: unknown } }).prototype;
	return (
		(globalThis as { process?: { versions?: { undici?: string } } }).process?.versions?.undici !== undefined &&
		(prototype?.[Symbol.toStringTag] === "WebSocket" || typeof prototype?.on !== "function")
	);
}

function guardUnsafeNodeWebSocket(impl: unknown): unknown {
	if (!isUnsafeNodeWebSocket(impl)) {
		return impl;
	}
	return new Proxy(impl as new (...args: unknown[]) => unknown, {
		construct: () => {
			throw new Error("Node's own WebSocket is refused (a relay can crash it): pass ws (the ws package's WebSocket)");
		},
	});
}

/** Configure the WebSocket implementation for relay connections. On Node, pass
 * an EventEmitter-style implementation such as `ws`; native, bound and custom
 * EventTarget-style constructors are refused when dialed. In a browser/edge runtime,
 * omit to use the global. Idempotent — a repeat call with the same intent is a no-op. */
export function configureWebSocket(impl?: WebSocketImpl): void {
	if (impl) {
		useWebSocketImplementation(guardUnsafeNodeWebSocket(impl) as ConfiguredWebSocket);
		configured = true;
		return;
	}
	if (configured) {
		return;
	}
	const globalImpl = globalWebSocket();
	if (globalImpl !== undefined) {
		if (isUnsafeNodeWebSocket(globalImpl)) {
			useWebSocketImplementation(guardUnsafeNodeWebSocket(globalImpl) as ConfiguredWebSocket);
		}
		configured = true;
	}
}
