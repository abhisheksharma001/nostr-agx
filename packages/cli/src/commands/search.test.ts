import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { agx, jsonDocuments, sandbox } from "../test/helpers.js";
import { type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";

let box: ReturnType<typeof sandbox>;
let mock: MockIndexServer;

beforeEach(async () => {
	box = sandbox();
	mock = await startMockIndexServer();
	updateProfile("default", { apiBaseUrl: mock.origin, relays: [] });
	const key = mock.addKey({ scoped: true, clientId: "agx" });
	setCredential("default", {
		apiBaseUrl: mock.origin,
		apiKey: key.key,
		apiKeyId: key.id,
		source: "login",
		clientId: "agx",
		organization: key.organization,
		user: null,
		scopes: ["listings:read"],
		expiresAt: null,
		createdAt: new Date().toISOString(),
	});
});

afterEach(async () => {
	await mock.close();
	box.restore();
});

describe("agx search --json", () => {
	it("escapes control characters a remote listing carries, without changing the data", async () => {
		const listing = {
			id: "l_1",
			slug: "evil",
			displayName: "Evil\u009b2JBot Inc",
			handle: null,
			npub: "npub1".padEnd(63, "q"),
			verified: false,
			capabilities: ["invoice\u0085.parse"],
			visibility: "public",
			status: "published",
			summary: "line\u007fone",
			relays: [],
		};
		mock.setRpc("agentIndex/searchListings", () => ({
			output: { listings: [listing], total: 1 },
		}));

		const run = await agx("search", "--json");

		expect(run.code).toBe(0);
		for (const ch of ["\u007f", "\u0085", "\u009b", " ", " "]) {
			expect(run.stdout).not.toContain(ch);
		}
		const [doc] = jsonDocuments(run.stdout) as [{ listings: unknown[]; total: number }];
		expect(doc.listings).toEqual([listing]);
	});
});
