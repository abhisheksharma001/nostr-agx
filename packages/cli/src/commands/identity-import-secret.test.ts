import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../lib/errors.js";
import { createIdentity, loadIdentityFile, saveIdentity } from "../lib/identity.js";
import { setStdinForTests } from "../lib/stdin.js";
import { agx, sandbox } from "../test/helpers.js";

// `agx identity import` takes a secret key. A key that does not decode (one
// character wrong, one missing, one too many) must be refused WITHOUT being
// printed: nostr-tools' decoder quotes its whole input in its error ("Invalid
// checksum in nsec1…"), and stderr lives on in terminal scrollback, logs and an
// agent's context. A key that is valid but written in capitals, or behind the
// `nostr:` scheme, is still a key: it imports.

let box: ReturnType<typeof sandbox>;
let restoreStdin: (() => void) | undefined;
const mine = createIdentity();
const incoming = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(incoming.secretKeyHex));
/** The whole of what is printed for a key that does not decode: pinned exactly, so it cannot be edited into one that shows part of the key. */
const COULD_NOT_DECODE =
	"Could not decode that nsec: it is not a valid secret key (a character is wrong or missing). It is not shown here.";

/** `value` with the character at `index` swapped for another valid bech32 character. */
function flip(value: string, index: number): string {
	return `${value.slice(0, index)}${value[index] === "q" ? "p" : "q"}${value.slice(index + 1)}`;
}

/** `value` with one letter inside it in the other case: bech32 forbids mixed case. */
function mixCase(value: string): string {
	const at = [...value].findIndex((char, index) => index > 10 && /[a-z]/.test(char));
	return `${value.slice(0, at)}${value[at].toUpperCase()}${value.slice(at + 1)}`;
}

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

function stored(): { secretKeyHex: string; npub: string } {
	return loadIdentityFile("default");
}

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
});

afterEach(() => {
	restoreStdin?.();
	restoreStdin = undefined;
	box.restore();
});

describe("a secret key that does not decode, given to identity import", () => {
	const BAD: Array<[string, string]> = [
		["a typo in the middle", flip(NSEC, 30)],
		["a typo in the first character after nsec1", flip(NSEC, 5)],
		["a typo in the last character", flip(NSEC, NSEC.length - 1)],
		["one character missing", NSEC.slice(0, -1)],
		["one character too many", `${NSEC}q`],
		["cut short", NSEC.slice(0, 25)],
		["a typo, in capitals", flip(NSEC, 30).toUpperCase()],
		["a typo, behind nostr:", `nostr:${flip(NSEC, 30)}`],
		["capitals and lower case mixed", mixCase(NSEC)],
		["capitals and lower case mixed, behind nostr:", `nostr:${mixCase(NSEC)}`],
		["a capital NSEC1 prefix and a lower-case rest", `NSEC1${NSEC.slice(5)}`],
	];

	it.each(BAD)("%s: says it could not be decoded and prints none of it", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NSEC);
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain(COULD_NOT_DECODE);
	});

	it.each(BAD)("%s: the same in --json mode", async (_name, value) => {
		const run = await agx("--json", "identity", "import", "--force", value);
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain(COULD_NOT_DECODE);
	});

	it.each(BAD)("%s: the same when piped in with --stdin", async (_name, value) => {
		restoreStdin = setStdinForTests(`${value}\n`);
		const run = await agx("identity", "import", "--stdin", "--force");
		for (const out of [run.stdout, run.stderr]) {
			expect(leakedPart(out, NSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain(COULD_NOT_DECODE);
	});

	it("leaves the identity that was there as it was", async () => {
		await agx("identity", "import", "--force", flip(NSEC, 30));
		await agx("identity", "import", "--force", mixCase(NSEC));
		expect(stored().secretKeyHex).toBe(mine.secretKeyHex);
	});
});

describe("a hex secret key that is not 64 characters, given to identity import", () => {
	it.each([
		["one character missing", incoming.secretKeyHex.slice(1)],
		["one character too many", `${incoming.secretKeyHex}a`],
		["a character that is not hex", `${incoming.secretKeyHex.slice(0, 63)}z`],
	])("%s: still says what is expected and prints none of it", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("Expected an `nsec1…` key or a 64-character hex secret key.");
		for (const out of [run.stdout, run.stderr]) {
			expect(out.toLowerCase()).not.toContain(incoming.secretKeyHex.slice(2, 14));
		}
	});
});

describe("a valid secret key given to identity import", () => {
	it.each([
		["nsec1… in lower case", NSEC],
		["NSEC1… in capitals", NSEC.toUpperCase()],
		["nsec1… behind nostr:", `nostr:${NSEC}`],
		["NSEC1… in capitals, behind nostr:", `nostr:${NSEC.toUpperCase()}`],
		["nsec1… behind NOSTR:", `NOSTR:${NSEC}`],
		["nsec1… with spaces and a newline around it", `  ${NSEC}\n`],
		["64 hex characters", incoming.secretKeyHex],
		["64 hex characters in capitals", incoming.secretKeyHex.toUpperCase()],
	])("%s: is imported", async (_name, value) => {
		const run = await agx("identity", "import", "--force", value);
		expect(run.stderr).toBe("");
		expect(run.code).toBe(EXIT.ok);
		expect(run.stdout).toContain(incoming.npub);
		expect(stored().secretKeyHex).toBe(incoming.secretKeyHex);
		expect(stored().npub).toBe(incoming.npub);
	});

	it("is imported from stdin in capitals too", async () => {
		restoreStdin = setStdinForTests(`${NSEC.toUpperCase()}\n`);
		const run = await agx("identity", "import", "--stdin", "--force");
		expect(run.code).toBe(EXIT.ok);
		expect(stored().secretKeyHex).toBe(incoming.secretKeyHex);
	});
});

describe("an ordinary mistake in identity import still gets a helpful message", () => {
	it("says what is expected when the value is not a key at all", async () => {
		const run = await agx("identity", "import", "--force", "not-a-key");
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("Expected an `nsec1…` key or a 64-character hex secret key.");
	});

	it("says how to give a key when there is none", async () => {
		restoreStdin = setStdinForTests(null);
		const run = await agx("identity", "import", "--force");
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("No secret key provided.");
		expect(run.stderr).toContain("agx identity import nsec1…");
	});

	it("says the profile already has an identity, and does not read the key", async () => {
		const run = await agx("identity", "import", flip(NSEC, 30));
		expect(run.code).toBe(EXIT.config);
		expect(run.stderr).toContain('Profile "default" already has an identity.');
		expect(leakedPart(run.stderr, NSEC)).toBeNull();
	});
});
