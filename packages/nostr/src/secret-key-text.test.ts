import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { describe, expect, it } from "vitest";
import { normalizePubkey } from "./address";
import { bytesToHex, generateKeypair } from "./keys";
import {
	hexKeyRuns,
	holdsSecretKey,
	readSecretKeyInput,
	secretKeyKinds,
} from "./secret-key-text";

// Every key here is made when the test runs, from a throwaway key: none is real
// and none is written to a file.
const pair = generateKeypair();
const HEX = bytesToHex(pair.secretKey);
const NSEC = nip19.nsecEncode(pair.secretKey);
const NCRYPTSEC = encrypt(pair.secretKey, "throwaway-password", 4);
const NPUB = nip19.npubEncode(pair.publicKey);

/** Every character as `%xx`, the way a URL-encoder that escapes everything writes it. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

describe("holdsSecretKey (lenient: for text that is about to be shown or kept)", () => {
	it.each([
		["an nsec1…", NSEC],
		["an nsec1… in capitals", NSEC.toUpperCase()],
		["an nsec1… behind nostr:", `nostr:${NSEC}`],
		["an nsec1… behind NOSTR: in capitals", `NOSTR:${NSEC.toUpperCase()}`],
		["an ncryptsec1…", NCRYPTSEC],
		["an ncryptsec1… in capitals", NCRYPTSEC.toUpperCase()],
		["a key inside a sentence", `my key is ${NSEC} and please keep it safe`],
		["a key behind two dashes, as an option name", `--${NSEC}`],
		["a key with one character too many", `${NSEC}q`],
		["a key cut short", NSEC.slice(0, 25)],
		["a key cut very short", NSEC.slice(0, 8)],
		["a key with a character changed", `${NSEC.slice(0, 30)}${NSEC[30] === "q" ? "p" : "q"}${NSEC.slice(31)}`],
		["a key with every character %xx-escaped", escapeAll(NSEC)],
		["a key with every character %xx-escaped, in lower-case digits", escapeAll(NSEC).toLowerCase()],
		["a key escaped in part", `nsec%31${NSEC.slice(5)}`],
		["an ncryptsec1… escaped", escapeAll(NCRYPTSEC)],
		["a key escaped twice", escapeAll(escapeAll(NSEC))],
		["a key escaped behind nostr%3A", `nostr%3A${escapeAll(NSEC)}`],
	])("is true for %s", (_name, text) => {
		expect(holdsSecretKey(text)).toBe(true);
	});

	it.each([
		["nothing", ""],
		["an ordinary sentence", "Hi Alice, can you review invoice 1234?"],
		["a public key (npub1…)", NPUB],
		["a public key as hex", pair.publicKey],
		["a secret key as hex (that is what hexKeyRuns is for)", HEX],
		["a url with ordinary escapes", "https://example.com/a%20b?q=%7Efoo%2Fbar"],
		["a word that only starts like a key", "nsec is not a key, and neither is ncrypt sec"],
	])("is false for %s", (_name, text) => {
		expect(holdsSecretKey(text)).toBe(false);
	});

	it("never throws, whatever the escapes look like", () => {
		for (const text of ["%", "%%", "%zz", "%e", "%%41", "%00", "%ff%fe", "100%", `${String.fromCharCode(0xd800)}%41`, "%25".repeat(5000)]) {
			expect(() => holdsSecretKey(text)).not.toThrow();
			expect(holdsSecretKey(text)).toBe(false);
		}
	});

	it("copes with a very long text full of escapes and with long runs of key characters", () => {
		// No time limit is asserted (a wall clock is a poor test on a busy machine); a regular expression
		// that backtracked without end would run into the test timeout instead.
		expect(holdsSecretKey(`${"%41%42%43 ".repeat(50_000)}${escapeAll("nsec1")}`)).toBe(true);
		expect(holdsSecretKey("%41%42%43 ".repeat(50_000))).toBe(false);
		expect(secretKeyKinds(`${("nsec1" + "q".repeat(1000) + "b").repeat(1000)}`)).toEqual([]);
		expect(secretKeyKinds(`nsec1${"q".repeat(200_000)}b`)).toEqual([]);
		expect(hexKeyRuns("a".repeat(200_000))).toEqual([]);
	});
});

describe("secretKeyKinds (strict: for a warning the user can dismiss)", () => {
	it.each([
		["an nsec1…", NSEC, ["nsec"]],
		["an nsec1… in capitals", NSEC.toUpperCase(), ["nsec"]],
		["an nsec1… behind nostr:", `nostr:${NSEC}`, ["nsec"]],
		["an nsec1… inside a sentence", `my key is ${NSEC} and please keep it safe`, ["nsec"]],
		["an nsec1… with every character %xx-escaped", escapeAll(NSEC), ["nsec"]],
		["an ncryptsec1…", NCRYPTSEC, ["ncryptsec"]],
		["an ncryptsec1… in capitals", NCRYPTSEC.toUpperCase(), ["ncryptsec"]],
		["an ncryptsec1… with every character %xx-escaped", escapeAll(NCRYPTSEC), ["ncryptsec"]],
		["both, whichever comes first", `${NCRYPTSEC} and ${NSEC}`, ["nsec", "ncryptsec"]],
		["the same kind twice", `${NSEC} ${NSEC}`, ["nsec"]],
		["a key with a typo in it (the data is still bech32)", `${NSEC.slice(0, 30)}q${NSEC.slice(31)}`, ["nsec"]],
		// A key written as it is, followed by an escape that decodes to a letter, a digit or an underscore:
		// the text as given still shows the key before a `%`, so it is flagged (the decoded text alone is not).
		["a key followed by an escaped underscore", `${NSEC}%5F`, ["nsec"]],
		["a key followed by an escaped letter", `${NSEC}%62`, ["nsec"]],
		["a key followed by an escaped digit", `${NSEC}%31`, ["nsec"]],
		["a key followed by an escaped percent sign and a letter", `${NSEC}%2562`, ["nsec"]],
		["a key in capitals followed by an escaped letter", `${NSEC.toUpperCase()}%62`, ["nsec"]],
		["a key in a URL, followed by an escaped underscore", `https://example.com/cb?key=${NSEC}%5Fbackup`, ["nsec"]],
		["an ncryptsec1… followed by an escaped letter", `${NCRYPTSEC}%62`, ["ncryptsec"]],
	])("finds %s", (_name, text, kinds) => {
		expect(secretKeyKinds(text)).toEqual(kinds);
	});

	it("needs 20 characters of data after the prefix", () => {
		expect(secretKeyKinds(`nsec1${"q".repeat(19)}`)).toEqual([]);
		expect(secretKeyKinds(`nsec1${"q".repeat(20)}`)).toEqual(["nsec"]);
		expect(secretKeyKinds(`ncryptsec1${"q".repeat(19)}`)).toEqual([]);
		expect(secretKeyKinds(`ncryptsec1${"q".repeat(20)}`)).toEqual(["ncryptsec"]);
	});

	it.each([
		["nothing", ""],
		["the bare word", "paste your nsec1 here, or your ncryptsec1"],
		["a public key", NPUB],
		["a secret key as hex", HEX],
		["a key stuck to a letter in front of it", `x${NSEC}`],
		["a key followed by a letter that bech32 does not use", `${NSEC}b`],
		["an ncryptsec1… stuck to a letter in front of it", `x${NCRYPTSEC}`],
		["an ncryptsec1… followed by a letter that bech32 does not use", `${NCRYPTSEC}b`],
		["a data part with a character bech32 does not use", `nsec1${"q".repeat(10)}b${"q".repeat(30)}`],
		["a url with ordinary escapes", "https://example.com/a%20b?q=%7Efoo%2Fbar"],
	])("does not flag %s", (_name, text) => {
		expect(secretKeyKinds(text)).toEqual([]);
	});

	it("never throws on a bad escape", () => {
		for (const text of ["%", "%zz", "%%41", `${String.fromCharCode(0xd800)}%41`]) {
			expect(secretKeyKinds(text)).toEqual([]);
		}
	});

	it("does not throw on one run of millions of key characters, and says what the prefix says", () => {
		// A regular expression over a run this long runs out of stack in V8 (about 6 million characters). The
		// answer then comes from the prefix alone, which cannot fail, so a long run is read as a key.
		const run = "q".repeat(6_000_000);
		expect(secretKeyKinds(`nsec1${run} `)).toEqual(["nsec"]);
		expect(secretKeyKinds(`ncryptsec1${run} `)).toEqual(["ncryptsec"]);
		expect(secretKeyKinds(`${run} `)).toEqual([]);
	});
});

describe("hexKeyRuns (candidates: a public key looks the same)", () => {
	it("finds 64 hex digits in either case, with where they start", () => {
		expect(hexKeyRuns(HEX)).toEqual([{ hex: HEX, index: 0 }]);
		expect(hexKeyRuns(HEX.toUpperCase())).toEqual([{ hex: HEX.toUpperCase(), index: 0 }]);
		const mixed = HEX.slice(0, 32) + HEX.slice(32).toUpperCase();
		expect(hexKeyRuns(`key: ${mixed}.`)).toEqual([{ hex: mixed, index: 5 }]);
	});

	it("finds every run and gives each its place", () => {
		const other = bytesToHex(generateKeypair().secretKey);
		const text = `a=${HEX}, b=${other}`;
		expect(hexKeyRuns(text)).toEqual([
			{ hex: HEX, index: 2 },
			{ hex: other, index: text.indexOf(other) },
		]);
	});

	it("takes a run beside punctuation and white space", () => {
		for (const text of [`(${HEX})`, `"${HEX}"`, `${HEX}\n`, `\t${HEX}`, `x:${HEX}`, `${HEX}.`, `-${HEX}`]) {
			expect(hexKeyRuns(text).map((run) => run.hex)).toEqual([HEX]);
		}
	});

	it.each([
		["63 digits", HEX.slice(1)],
		["65 digits", `${HEX}a`],
		["128 digits, one run", HEX + HEX],
		["a run stuck to a letter", `g${HEX}`],
		["a run stuck to a letter behind it", `${HEX}g`],
		["a run stuck to an underscore", `${HEX}_`],
		["a run stuck to a digit", `0${HEX}`],
		["nothing", ""],
		["an npub", NPUB],
		["an nsec", NSEC],
	])("does not take %s", (_name, text) => {
		expect(hexKeyRuns(text)).toEqual([]);
	});

	it("does not decode escapes, so an index is a place in the text given", () => {
		expect(hexKeyRuns(escapeAll(HEX))).toEqual([]);
	});

	it("cannot tell a public key from a secret key: both are returned", () => {
		expect(normalizePubkey(pair.publicKey)).toBe(pair.publicKey);
		expect(hexKeyRuns(pair.publicKey).map((run) => run.hex)).toEqual([pair.publicKey]);
	});
});

describe("readSecretKeyInput (the whole of what was typed)", () => {
	it.each([
		["an nsec1…", NSEC],
		["an nsec1… with white space around it", `  ${NSEC}\n`],
		["an nsec1… behind nostr:", `nostr:${NSEC}`],
		["an nsec1… behind NOSTR:", `NOSTR:${NSEC}`],
	])("takes %s", (_name, text) => {
		expect(readSecretKeyInput(text)).toEqual({ kind: "nsec", bech32: NSEC });
	});

	it("takes an nsec1… in capitals as it is written", () => {
		expect(readSecretKeyInput(NSEC.toUpperCase())).toEqual({ kind: "nsec", bech32: NSEC.toUpperCase() });
		expect(readSecretKeyInput(`nostr:${NSEC.toUpperCase()}`)).toEqual({ kind: "nsec", bech32: NSEC.toUpperCase() });
	});

	it("does not check that an nsec1… decodes: a mistyped one is still an nsec", () => {
		expect(readSecretKeyInput(`${NSEC}q`)?.kind).toBe("nsec");
		expect(readSecretKeyInput(NSEC.slice(0, 12))?.kind).toBe("nsec");
	});

	it("takes 64 hex digits and gives them in lower case", () => {
		expect(readSecretKeyInput(HEX)).toEqual({ kind: "hex", hex: HEX });
		expect(readSecretKeyInput(HEX.toUpperCase())).toEqual({ kind: "hex", hex: HEX });
		expect(readSecretKeyInput(`\n ${HEX} \t`)).toEqual({ kind: "hex", hex: HEX });
	});

	it.each([
		["nothing", ""],
		["white space", "  \n"],
		["a public key", NPUB],
		["an ncryptsec1…", NCRYPTSEC],
		["hex behind nostr:", `nostr:${HEX}`],
		["63 hex digits", HEX.slice(1)],
		["65 hex digits", `${HEX}a`],
		["an nsec1… inside a sentence", `my key is ${NSEC}`],
		["an escaped nsec1…", escapeAll(NSEC)],
	])("does not take %s", (_name, text) => {
		expect(readSecretKeyInput(text)).toBeNull();
	});
});
