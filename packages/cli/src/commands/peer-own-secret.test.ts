import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectiveProfile, getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { identityPath } from "../lib/paths.js";
import { refuseOwnSecretKey } from "../lib/peer.js";
import { agx, sandbox } from "../test/helpers.js";

// A secret key is also 64 hex characters, so `agx` cannot tell one from a public key by its shape. The one
// secret key it does know is its own: the profile's identity file. Given as a peer, that key must be refused
// without being shown, or it is stored in config.json, printed back as an npub that decodes to the same
// bytes, sent as the recipient of a message, or put in a request to a relay.

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	publishMessage: vi.fn(),
	fetchByAuthor: vi.fn(),
	stop: vi.fn(async () => undefined),
}));

vi.mock("../lib/transport.js", () => ({
	createTransport: mocks.createTransport,
	makeLogger: () => undefined,
}));

vi.mock("@nostr-agx/nostr", async (importOriginal) => ({
	...(await importOriginal<typeof import("@nostr-agx/nostr")>()),
	fetchByAuthor: mocks.fetchByAuthor,
}));

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const friend = createIdentity();
const other = createIdentity();

/** Every way the secret key could be written down: its hex, and the npub and nsec that carry the same bytes. */
function formsOf(secretHex: string): string[] {
	const bytes = hexToBytes(secretHex);
	return [secretHex, nip19.npubEncode(secretHex), nip19.nsecEncode(bytes)];
}

/** The first 10-character stretch of the key (data part only, in any case, in any written form) found in `shown`; null if none. */
function leakedPart(shown: string, secretHex: string): string | null {
	const text = shown.toLowerCase();
	for (const form of formsOf(secretHex)) {
		const key = form.toLowerCase();
		const from = form === secretHex ? 0 : 5;
		for (let i = from; i + 10 <= key.length; i++) {
			if (text.includes(key.slice(i, i + 10))) {
				return key.slice(i, i + 10);
			}
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
	vi.clearAllMocks();
	mocks.createTransport.mockImplementation(async () => ({
		publishMessage: mocks.publishMessage,
		stop: mocks.stop,
	}));
	mocks.publishMessage.mockResolvedValue({
		ok: true,
		eventId: "evt1",
		contextId: "ctx1",
		accepted: 1,
		total: 1,
		rejected: [],
		errors: [],
	});
	mocks.fetchByAuthor.mockResolvedValue([]);
	saveIdentity("default", mine);
	saveIdentity("other", other);
	updateProfile("default", { allow: [friend.publicKey] });
});

afterEach(() => {
	process.exitCode = undefined;
	box.restore();
});

describe("this profile's own secret key given where a peer belongs", () => {
	it.each([
		["agx identity allow", (key: string) => ["identity", "allow", key]],
		["agx held allow", (key: string) => ["held", "allow", key]],
		["agx send", (key: string) => ["send", key, "hello"]],
		["agx request", (key: string) => ["request", key, "agx.ping", "--timeout", "1000"]],
		["agx card", (key: string) => ["card", key]],
	])("%s refuses it, prints none of it, and reaches no relay", async (_name, argsFor) => {
		const run = await agx(...argsFor(mine.secretKeyHex));
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
		expect(mocks.createTransport).not.toHaveBeenCalled();
		expect(mocks.publishMessage).not.toHaveBeenCalled();
		expect(mocks.fetchByAuthor).not.toHaveBeenCalled();
	});

	it("is refused however it is written: upper case, padded, or as the npub that carries the same bytes", async () => {
		for (const form of [
			mine.secretKeyHex.toUpperCase(),
			`  ${mine.secretKeyHex}  `,
			nip19.npubEncode(mine.secretKeyHex),
		]) {
			const run = await agx("identity", "allow", form);
			expect(run.code, form).toBe(2);
			expect(run.stderr).toMatch(/own secret key/i);
			for (const out of [run.stdout, run.stderr]) {
				expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
			}
		}
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("stores nothing: not the key, and not a valid peer given with it", async () => {
		await agx("identity", "allow", mine.secretKeyHex);
		await agx("identity", "allow", createIdentity().publicKey, mine.secretKeyHex);
		await agx("held", "allow", mine.secretKeyHex);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("prints no part of it in JSON mode either", async () => {
		const run = await agx("identity", "allow", mine.secretKeyHex, "--json");
		expect(run.code).toBe(2);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, mine.secretKeyHex)).toBeNull();
		}
	});

	it("is refused when the identity file is readable by others, the one case `loadIdentity` itself refuses", async () => {
		chmodSync(identityPath("default"), 0o644);
		const run = await agx("identity", "allow", mine.secretKeyHex);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		expect(run.stderr).not.toMatch(/readable by other users/);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("is the key of the profile named with --profile that is refused", async () => {
		const run = await agx("--profile", "other", "identity", "allow", other.secretKeyHex);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/own secret key/i);
		expect(effectiveProfile("other").allow).toEqual([]);
	});
});

// What this step does not change: ordinary input, and the keys it cannot tell from a public key.
describe("input that is still accepted", () => {
	it("a valid npub and a valid hex pubkey are allowed as before", async () => {
		const a = createIdentity();
		const b = createIdentity();
		const run = await agx("identity", "allow", a.npub, b.publicKey);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey, a.publicKey, b.publicKey]);
	});

	it("a recipient and an agent that are not this profile's secret key are still used", async () => {
		const sent = await agx("send", friend.npub, "hello");
		expect(sent.code).toBe(0);
		expect(mocks.publishMessage).toHaveBeenCalledWith(friend.publicKey, expect.anything());
		await agx("card", friend.npub);
		expect(mocks.fetchByAuthor).toHaveBeenCalled();
	});

	it("this profile's own public key is not refused by this change", async () => {
		const run = await agx("identity", "allow", mine.npub);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toContain(mine.publicKey);
	});

	it("another profile's secret key cannot be told from a public key, so it is not refused", async () => {
		const run = await agx("identity", "allow", other.secretKeyHex);
		expect(run.code).toBe(0);
		expect(getProfile("default").allow).toContain(other.secretKeyHex);
		const inTheOther = await agx("--profile", "other", "identity", "allow", mine.secretKeyHex);
		expect(inTheOther.code).toBe(0);
	});

	it("identity deny and held block still take such an entry out", async () => {
		updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
		expect((await agx("identity", "deny", mine.secretKeyHex)).code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
		updateProfile("default", { allow: [friend.publicKey, mine.secretKeyHex] });
		expect((await agx("held", "block", mine.secretKeyHex)).code).toBe(0);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("a profile with no identity yet can still allow a peer", async () => {
		const run = await agx("--profile", "fresh", "identity", "allow", friend.publicKey);
		expect(run.code).toBe(0);
		expect(effectiveProfile("fresh").allow).toEqual([friend.publicKey]);
	});

	it("an identity file that cannot be read does not stop identity allow", async () => {
		mkdirSync(dirname(identityPath("broken")), { recursive: true });
		writeFileSync(identityPath("broken"), "not json", { mode: 0o600 });
		const run = await agx("--profile", "broken", "identity", "allow", friend.publicKey);
		expect(run.code).toBe(0);
		expect(effectiveProfile("broken").allow).toEqual([friend.publicKey]);
	});
});

describe("refuseOwnSecretKey", () => {
	it("throws a usage error that does not contain the key, in any written form", () => {
		for (const form of formsOf(mine.secretKeyHex)) {
			if (form.startsWith("nsec1")) {
				continue;
			}
			let message = "";
			try {
				refuseOwnSecretKey(form, "default", "peer");
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message, form).toMatch(/^The peer you gave is this profile's own secret key/);
			expect(leakedPart(message, mine.secretKeyHex)).toBeNull();
		}
	});

	it("takes its wording from the label it is given", () => {
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "default", "recipient")).toThrow(/^The recipient you gave/);
	});

	it("returns for anything that is not this profile's secret key", () => {
		for (const input of [friend.publicKey, friend.npub, mine.publicKey, mine.npub, "hello", "", "nostr:npub1abc"]) {
			expect(() => refuseOwnSecretKey(input, "default")).not.toThrow();
		}
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "other")).not.toThrow();
		expect(() => refuseOwnSecretKey(mine.secretKeyHex, "profile-without-identity")).not.toThrow();
	});
});
