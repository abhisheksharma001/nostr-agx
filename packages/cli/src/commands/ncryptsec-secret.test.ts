import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// A password-protected secret key (NIP-49, `ncryptsec1…`) is a secret key of
// the same class as an `nsec1…`: low severity, since it needs the password, but
// it must not come back in an error either. The two checks that keep an nsec out
// of stderr (the peer check and the command parser's error) match both.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const friend = createIdentity();
/** A real NIP-49 string, made here from a throwaway key (scrypt cost 2^4: fast, and no more real than the key). */
const NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
const OTHER_NCRYPTSEC = encrypt(hexToBytes(createIdentity().secretKeyHex), "throwaway-password", 4);
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
/** The whole of what the parser prints instead of an error that quotes a secret key. */
const REPLACED =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** The first 10-character stretch of the key's data part (not the constant `ncryptsec1`) found in `shown`, in any case; null if none. */
function leakedPart(shown: string, key: string): string | null {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = "ncryptsec1".length; i + 10 <= secret.length; i++) {
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
	updateProfile("default", { allow: [friend.publicKey] });
});

afterEach(() => {
	box.restore();
});

describe("an encrypted secret key (ncryptsec1…) given where a peer belongs", () => {
	it("is a real NIP-49 string", () => {
		expect(NCRYPTSEC.startsWith("ncryptsec1")).toBe(true);
		expect(NCRYPTSEC.length).toBeGreaterThan(100);
	});

	it.each([
		["agx send", ["send", NCRYPTSEC, "hello"]],
		["agx identity allow", ["identity", "allow", NCRYPTSEC]],
		["agx identity deny", ["identity", "deny", NCRYPTSEC]],
		["agx held allow", ["held", "allow", NCRYPTSEC]],
		["agx held block", ["held", "block", NCRYPTSEC]],
		["agx card", ["card", NCRYPTSEC]],
		["agx identity allow, in capitals", ["identity", "allow", NCRYPTSEC.toUpperCase()]],
		["agx identity allow, behind nostr:", ["identity", "allow", `nostr:${NCRYPTSEC}`]],
		["agx identity allow, cut short", ["identity", "allow", NCRYPTSEC.slice(0, 60)]],
		["agx identity allow, in --json mode", ["identity", "allow", NCRYPTSEC, "--json"]],
	])("%s: refuses it and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NCRYPTSEC);
			expect(leakedPart(out, NCRYPTSEC)).toBeNull();
		}
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toMatch(/secret key/i);
	});

	it("leaves the allowlist as it was", async () => {
		await agx("identity", "allow", NCRYPTSEC);
		await agx("identity", "deny", NCRYPTSEC);
		await agx("held", "allow", NCRYPTSEC);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("says the same thing as it does for an nsec1…", async () => {
		const encrypted = await agx("identity", "allow", NCRYPTSEC);
		const plain = await agx("identity", "allow", NSEC);
		expect(encrypted.stderr).toBe(plain.stderr);
		expect(encrypted.code).toBe(plain.code);
	});
});

describe("an encrypted secret key (ncryptsec1…) on a command line the parser rejects", () => {
	it.each([
		["an unquoted message after a peer (too many arguments)", ["send", NCRYPTSEC, "hello", "world"]],
		["an unknown command", [NCRYPTSEC]],
		["an unknown command, in capitals", [NCRYPTSEC.toUpperCase()]],
		["an unknown command behind nostr:", [`nostr:${NCRYPTSEC}`]],
		["an unknown subcommand", ["identity", NCRYPTSEC]],
		["an unknown option", [`--${NCRYPTSEC}`]],
		["an unknown option of a subcommand", ["send", `--${NCRYPTSEC}`, "someone", "hello"]],
		["--json mode", ["--json", "send", NCRYPTSEC, "hello", "world"]],
		["a key cut short", [NCRYPTSEC.slice(0, 60)]],
		["two keys on one line", ["send", NCRYPTSEC, "hello", OTHER_NCRYPTSEC]],
		["one of each kind on one line", ["send", NCRYPTSEC, "hello", NSEC]],
	])("%s: says why and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NCRYPTSEC);
			expect(leakedPart(out, NCRYPTSEC)).toBeNull();
			expect(leakedPart(out, OTHER_NCRYPTSEC)).toBeNull();
		}
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(REPLACED);
	});

	it("does not hide text that only looks like the start of one", async () => {
		const run = await agx("ncryptsec");
		expect(run.code).toBe(1);
		expect(run.stderr).toContain("unknown command 'ncryptsec'");
	});
});
