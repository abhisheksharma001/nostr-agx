import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { cardCommand } from "./card.js";

const { configureWebSocket, fetchByAuthor } = vi.hoisted(() => ({
	configureWebSocket: vi.fn(),
	fetchByAuthor: vi.fn(),
}));

vi.mock("@nostr-agx/nostr", async (importOriginal) => ({
	...(await importOriginal<typeof import("@nostr-agx/nostr")>()),
	configureWebSocket,
	fetchByAuthor,
}));

vi.mock("../lib/config.js", () => ({
	effectiveProfile: () => ({ relays: [] }),
	resolveProfileName: () => "default",
}));

describe("agx card relay socket", () => {
	beforeEach(() => {
		configureWebSocket.mockReset();
		fetchByAuthor.mockReset();
		fetchByAuthor.mockResolvedValue([]);
	});

	it("injects ws before standalone card and relay-list reads", async () => {
		await expect(
			cardCommand("a".repeat(64), { relay: ["ws://127.0.0.1:1"] }),
		).rejects.toThrow("No Agent Card found");
		expect(configureWebSocket).toHaveBeenCalledWith(WebSocket);
		expect(fetchByAuthor).toHaveBeenCalledTimes(2);
	});
});
