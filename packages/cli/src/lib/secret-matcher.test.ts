import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity, loadIdentityFile, saveIdentity } from "./identity.js";
import { holdsSecretKey, redactSecrets } from "./secrets.js";
import { agx, sandbox } from "../test/helpers.js";

// One rule says what "this text holds a secret key" means (`holdsSecretKey` in
// `@nostr-agx/nostr`), and the profile's own key is known to `redactSecrets` in
// every form it is written in. These tests drive the CLI's own uses of both.
//
// Every key here is made when the test runs, from a throwaway key.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
/** The whole of what the parser prints instead of an error that quotes a secret key. */
const REPLACED =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** Every character as `%xx`, the way a URL-encoder that escapes everything writes it. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** The first 10-character stretch of the key's data part (not the constant prefix) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string, prefix: number): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = prefix; i + 10 <= secret.length; i++) {
		const part = secret.slice(i, i + 10);
		if (text.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
});

afterEach(() => {
	box.restore();
});

describe("a secret key written as %xx escapes on a command line the parser rejects", () => {
	const escaped = escapeAll(NSEC);
	it.each([
		["an unknown command", [escaped]],
		["an unknown command, in lower-case digits", [escaped.toLowerCase()]],
		["an unknown command behind nostr:", [`nostr:${escaped}`]],
		["an unknown command, escaped twice", [escapeAll(escaped)]],
		["an unknown command, only the prefix escaped", [`${escapeAll("nsec1")}${NSEC.slice(5)}`]],
		["an unknown subcommand", ["identity", escaped]],
		["an unknown option", [`--${escaped}`]],
		["an unknown option of a subcommand", ["send", `--${escaped}`, "someone", "hello"]],
		["a surplus argument", ["config", "list", escaped]],
		["an unquoted message after a peer (too many arguments)", ["send", escaped, "hello", "world"]],
		["--json mode", ["--json", "send", escaped, "hello", "world"]],
		["an encrypted key (ncryptsec1…)", [escapeAll(NCRYPTSEC)]],
	])("%s: says why and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(REPLACED);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC, 5)).toBeNull();
			expect(leakedPart(out, NCRYPTSEC, 10)).toBeNull();
			expect(out.toLowerCase()).not.toContain("%6e%73%65%63");
		}
	});
});

describe("holdsSecretKey in the CLI", () => {
	it("sees a key written as %xx escapes, in any case, as the one shared rule does", () => {
		expect(holdsSecretKey(escapeAll(NSEC))).toBe(true);
		expect(holdsSecretKey(escapeAll(NSEC).toLowerCase())).toBe(true);
		expect(holdsSecretKey(`nostr:${NSEC.toUpperCase()}`)).toBe(true);
		expect(holdsSecretKey(NCRYPTSEC)).toBe(true);
	});

	it("still sees what it saw: a key, in capitals, behind nostr:, with a typo", () => {
		for (const text of [NSEC, NSEC.toUpperCase(), `nostr:${NSEC}`, `${NSEC}q`, NSEC.slice(0, 12), `--${NSEC}`]) {
			expect(holdsSecretKey(text)).toBe(true);
		}
	});

	it("is still false for text that is not a key", () => {
		for (const text of ["", "hello", "npub1abc", mine.publicKey, "a%20b", "100%"]) {
			expect(holdsSecretKey(text)).toBe(false);
		}
	});
});

describe("every other parser error is unchanged", () => {
	it("still names an ordinary 'too many arguments' and suggests the nearest command", async () => {
		const many = await agx("send", "npub1abc", "hello", "world");
		expect(many.code).toBe(1);
		expect(many.stderr).toContain("too many arguments for 'send'");
		expect(many.stderr).toContain("npub1abc, hello, world");
		const typo = await agx("sned");
		expect(typo.stderr).toContain("unknown command 'sned'");
		expect(typo.stderr).toContain("Did you mean send?");
	});

	it("still prints an unknown command that holds ordinary escapes", async () => {
		const run = await agx("a%20b%2Fc");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'a%20b%2Fc'");
	});
});

describe("the profile's own secret key", () => {
	const hex = mine.secretKeyHex;
	const nsec = nip19.nsecEncode(hexToBytes(hex));
	/** The same 32 bytes read as a public key: what `agx card <hex>` prints back for a pasted key. */
	const npubOfKey = nip19.npubEncode(hex);
	const forms = [hex, hex.toUpperCase(), nsec, nsec.toUpperCase(), npubOfKey, npubOfKey.toUpperCase()];

	it("is removed from an error message, in every form it is written in, once the profile is read", () => {
		loadIdentityFile("default");
		for (const form of forms) {
			expect(redactSecrets(`failed for ${form} just now`)).toBe("failed for [redacted] just now");
		}
		expect(redactSecrets(`nostr:${nsec}`)).toBe("nostr:[redacted]");
	});

	it("is removed wherever it stands in the text, more than once", () => {
		loadIdentityFile("default");
		expect(redactSecrets(`${hex} ${nsec} ${hex}`)).toBe("[redacted] [redacted] [redacted]");
	});

	it("leaves the profile's public key and everything else alone", () => {
		loadIdentityFile("default");
		for (const text of [mine.publicKey, mine.npub, "a message", "", `${mine.publicKey.slice(0, 32)}${hex.slice(32)}`, hex.slice(1)]) {
			expect(redactSecrets(text)).toBe(text);
		}
	});

	it("is not known before the profile is read", () => {
		// A key that no test in this file has read.
		const stranger = createIdentity();
		expect(redactSecrets(`value ${stranger.secretKeyHex}`)).toBe(`value ${stranger.secretKeyHex}`);
	});
});
