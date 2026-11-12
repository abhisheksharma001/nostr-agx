import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useWebSocketImplementation } = vi.hoisted(() => ({
	useWebSocketImplementation: vi.fn(),
}));

vi.mock("nostr-tools/relay", () => ({ useWebSocketImplementation }));

class NativeWebSocket extends EventTarget {}
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

		expect(() => configureWebSocket()).toThrow("Node's own WebSocket is refused");
		expect(() => configureWebSocket(NativeWebSocket)).toThrow("Node's own WebSocket is refused");
		expect(useWebSocketImplementation).not.toHaveBeenCalled();
	});

	it("accepts an injected EventEmitter WebSocket such as ws on Node", async () => {
		vi.stubGlobal("process", { versions: { undici: "6.24.1" } });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		const { configureWebSocket } = await import("./ws");

		configureWebSocket(EventEmitterWebSocket);
		expect(useWebSocketImplementation).toHaveBeenCalledWith(EventEmitterWebSocket);
	});

	it("keeps a browser-style global WebSocket outside Node", async () => {
		vi.stubGlobal("process", { versions: {} });
		vi.stubGlobal("WebSocket", NativeWebSocket);
		const { configureWebSocket } = await import("./ws");

		expect(() => configureWebSocket()).not.toThrow();
		expect(useWebSocketImplementation).not.toHaveBeenCalled();
	});
});
