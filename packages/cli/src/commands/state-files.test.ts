import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { lockPath, seenPath, statePath } from "../lib/paths.js";
import { agx, fakeClock, jsonDocuments, sandbox, useClock } from "../test/helpers.js";
import { type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";

// A damaged or newer state.json must stop the commands that use it with exit 3
// and a message that names the file. It must not cost `agx doctor` its report,
// and it must stop `register` and `listing create` BEFORE they change anything
// on the index.

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

const NEWER = JSON.stringify({ version: 2, cursor: 500 });

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
	updateProfile("default", { apiBaseUrl: mock.origin, relays: [] });
	const key = mock.addKey({
		scoped: true,
		clientId: "agx",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	setCredential("default", {
		apiBaseUrl: mock.origin,
		apiKey: key.key,
		apiKeyId: key.id,
		source: "login",
		clientId: "agx",
		organization: key.organization,
		user: null,
		scopes: ["listings:read"],
		expiresAt: "2099-01-01T00:00:00.000Z",
		createdAt: new Date(clock.now()).toISOString(),
	});
	mkdirSync(dirname(statePath("default")), { recursive: true });
	writeFileSync(statePath("default"), NEWER);
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

const remoteCalls = () => mock.requests.filter((r) => r.path.startsWith("/api/rpc/"));

describe("a state file the CLI cannot use", () => {
	it("agx doctor still prints its report and fails the state check", async () => {
		mock.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
		const run = await agx("doctor", "--json");
		const doc = jsonDocuments(run.stdout)[0] as {
			checks: Array<{ name: string; verdict: string; detail: string; remediation?: string }>;
		};
		expect(doc).toBeDefined();
		const state = doc.checks.find((c) => c.name === "state files");
		expect(state).toMatchObject({ verdict: "fail" });
		expect(state?.detail).toContain(statePath("default"));
		expect(doc.checks.some((c) => c.name === "credential source")).toBe(true);
		expect(run.code).toBe(3);
		expect(readFileSync(statePath("default"), "utf8")).toBe(NEWER);
	});

	it("agx listing create stops before it calls the index", async () => {
		const run = await agx(
			"listing",
			"create",
			"--team",
			"team_1",
			"--slug",
			"payables",
			"--display-name",
			"Payables",
		);
		expect(run.code).toBe(3);
		expect(run.stderr).toContain(statePath("default"));
		expect(remoteCalls()).toEqual([]);
		expect(readFileSync(statePath("default"), "utf8")).toBe(NEWER);
	});

	it("agx register stops before it calls the index", async () => {
		const run = await agx("register", "--slug", "payables", "--display-name", "Payables");
		expect(run.code).toBe(3);
		expect(run.stderr).toContain(statePath("default"));
		expect(remoteCalls()).toEqual([]);
		expect(readFileSync(statePath("default"), "utf8")).toBe(NEWER);
	});

	it.each([
		["state.json", () => statePath("default")],
		["seen.json", () => seenPath("default")],
	])("agx serve gives its lock back when %s is unusable", async (_name, file) => {
		saveIdentity("default", createIdentity());
		writeFileSync(statePath("default"), "{ not json");
		if (file() === seenPath("default")) {
			writeFileSync(statePath("default"), JSON.stringify({ version: 1 }));
			writeFileSync(seenPath("default"), NEWER);
		}
		const run = await agx("serve", "--once");
		expect(run.code).toBe(3);
		expect(run.stderr).toContain(file());
		expect(existsSync(lockPath("default"))).toBe(false);
	});
});
