import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx search <query>` and `agx peers accept|refuse|ignore|block --peer <id>`
// hand a value to the remote index. A secret key typed there by mistake must be
// refused on this machine, before anything is sent: once it is in a request it
// is on the network and in the server's logs.

let box: ReturnType<typeof sandbox>;
let server: Server;
let received: Array<{ method: string; url: string; body: string }>;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));

/** The first 10-character stretch of the key's data part (not the constant `nsec1`) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = 5; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(async () => {
	box = sandbox();
	saveIdentity("default", createIdentity());
	received = [];
	// A loopback stand-in for the index. It records every request and refuses it,
	// so no test depends on the shape of a real answer.
	server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			received.push({
				method: req.method ?? "",
				url: req.url ?? "",
				body: Buffer.concat(chunks).toString("utf8"),
			});
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: "rejected", message: "rejected" } }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	process.env.AGX_API_URL = `http://127.0.0.1:${port}`;
	process.env.AGX_API_KEY = "throwaway-test-key";
	process.env.AGX_ORG = "acme";
});

afterEach(async () => {
	await new Promise<void>((done) => server.close(() => done()));
	box.restore();
});

/** Everything the index saw, as one string. */
const sent = (): string => received.map((r) => `${r.method} ${r.url} ${r.body}`).join("\n");

function expectRefusedAndSilent(run: { code: number; stdout: string; stderr: string }): void {
	expect(run.code).toBe(2);
	expect(run.stderr).toMatch(/secret key/i);
	expect(received).toEqual([]);
	for (const out of [run.stdout, run.stderr]) {
		expect(out).not.toContain(NSEC);
		expect(leakedPart(out, NSEC)).toBeNull();
	}
}

const DECIDE = [
	["accept", []],
	["refuse", ["--reason", "not now"]],
	["ignore", []],
	["block", []],
] as const;

describe("a secret key given as the search text", () => {
	it("agx search refuses it, sends nothing and prints none of it", async () => {
		const run = await agx("search", NSEC);
		expectRefusedAndSilent(run);
		expect(run.stderr).toContain("search");
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["with spaces around it", `  ${NSEC}  `],
		["after other words", `find me ${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		expectRefusedAndSilent(await agx("search", value));
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("search", NSEC, "--json");
		expect(run.code).toBe(2);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});

	it("refuses it before it looks for credentials", async () => {
		delete process.env.AGX_API_KEY;
		const run = await agx("search", NSEC);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		expect(leakedPart(run.stdout + run.stderr, NSEC)).toBeNull();
	});
});

describe("search text that is not a secret key", () => {
	it("still reaches the index, as typed", async () => {
		await agx("search", "payables agent");
		expect(received).toHaveLength(1);
		expect(decodeURIComponent(sent())).toContain("payables agent");
	});

	it("still reaches the index with no search text at all", async () => {
		await agx("search");
		expect(received).toHaveLength(1);
	});

	it("is not refused for containing the letters nsec without the 1", async () => {
		await agx("search", "nsec-reader");
		expect(received).toHaveLength(1);
	});
});

describe("a secret key given as the peer id of a peers decision", () => {
	it.each(DECIDE)("agx peers %s refuses it, sends nothing and prints none of it", async (action, extra) => {
		const run = await agx("peers", action, "--team", "t1", "--peer", NSEC, ...extra);
		expectRefusedAndSilent(run);
		expect(run.stderr).toContain("peer id");
		expect(run.stderr).toContain("agx peers list --team t1");
	});

	it.each([
		["in capitals", NSEC.toUpperCase()],
		["after nostr:", `nostr:${NSEC}`],
		["after other text", `peer=${NSEC}`],
	])("refuses a key %s", async (_form, value) => {
		for (const [action, extra] of DECIDE) {
			expectRefusedAndSilent(await agx("peers", action, "--team", "t1", "--peer", value, ...extra));
		}
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("peers", "block", "--team", "t1", "--peer", NSEC, "--json");
		expect(run.code).toBe(2);
		expect(received).toEqual([]);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
	});
});

describe("an ordinary peer id given to a peers decision", () => {
	it.each(DECIDE)("agx peers %s still reaches the index, with the id as typed", async (action, extra) => {
		await agx("peers", action, "--team", "t1", "--peer", "peer_123", ...extra);
		expect(received).toHaveLength(1);
		expect(sent()).toContain("peer_123");
	});
});
