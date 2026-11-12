import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useWebSocketImplementation } = vi.hoisted(() => ({
	useWebSocketImplementation: vi.fn(),
}));

vi.mock("nostr-tools/relay", () => ({ useWebSocketImplementation }));

class NativeWebSocket extends EventTarget {}
Object.defineProperty(NativeWebSocket.prototype, Symbol.toStringTag, { value: "WebSocket" });
class EventEmitterWebSocket {
	on(): void {}
}

beforeEach(() => {
	vi.resetModules();
	useWebSocketImplementation.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("configureWebSocket", () => {
	it("rejects Node's own WebSocket instead of letting a relay crash the process", async () => {
		vi.stubGlobal("process", { versions: { undici: "6.24.1" } });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		const { configureWebSocket } = await import("./ws");

		expect(() => configureWebSocket()).not.toThrow();
		expect(() => configureWebSocket(NativeWebSocket)).not.toThrow();
		expect(useWebSocketImplementation).toHaveBeenCalledTimes(2);
		for (const call of useWebSocketImplementation.mock.calls) {
			const Guarded = call[0] as new (url: string) => unknown;
			expect(() => new Guarded("ws://relay.invalid")).toThrow("Node's own WebSocket is refused");
		}
	});

	it("rejects captured native constructors and native subclasses on Node", async () => {
		vi.stubGlobal("process", { versions: { undici: "6.24.1" } });
		const CapturedNative = NativeWebSocket;
		class NativeSubclass extends CapturedNative {}
		vi.stubGlobal("WebSocket", class Replacement extends EventTarget {});
		const { configureWebSocket } = await import("./ws");

		for (const impl of [CapturedNative, NativeSubclass]) {
			configureWebSocket(impl);
			const Guarded = useWebSocketImplementation.mock.lastCall?.[0] as new (url: string) => unknown;
			expect(() => new Guarded("ws://relay.invalid")).toThrow("Node's own WebSocket is refused");
		}
	});

	it("accepts an injected EventEmitter WebSocket such as ws on Node", async () => {
		vi.stubGlobal("process", { versions: { undici: "6.24.1" } });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		const { configureWebSocket } = await import("./ws");

		configureWebSocket(EventEmitterWebSocket);
		expect(useWebSocketImplementation).toHaveBeenCalledWith(EventEmitterWebSocket);
	});

	it("accepts a custom EventTarget socket without Node's native WebSocket tag", async () => {
		vi.stubGlobal("process", { versions: { undici: "6.24.1" } });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		class CustomEventTargetWebSocket extends EventTarget {}
		const { configureWebSocket } = await import("./ws");

		configureWebSocket(CustomEventTargetWebSocket);
		expect(useWebSocketImplementation).toHaveBeenCalledWith(CustomEventTargetWebSocket);
	});

	it("keeps a browser-style global WebSocket outside Node", async () => {
		vi.stubGlobal("process", { versions: {} });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		const { configureWebSocket } = await import("./ws");

		expect(() => configureWebSocket()).not.toThrow();
		expect(useWebSocketImplementation).not.toHaveBeenCalled();
	});
});
