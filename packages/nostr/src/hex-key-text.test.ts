import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { bytesToHex, generateKeypair } from "./keys";
import { holdsHexKey } from "./secret-key-text";

// Every key here is made when the test runs: none is real and none is written to a file.
const pair = generateKeypair();
const HEX = bytesToHex(pair.secretKey);

/** Every character as `%xx`. */
function escapeAll(text: string): string {
	return [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

describe("holdsHexKey: 64 hex digits in a row anywhere in a text", () => {
	it.each([
		["a bare run", HEX],
		["a run in capitals", HEX.toUpperCase()],
		["a run in mixed case", HEX.slice(0, 20).toUpperCase() + HEX.slice(20)],
		["a run after an equals sign (--name=<hex>)", `--authkey=${HEX}`],
		["a run in a sentence", `my key is ${HEX} and please keep it safe`],
		["a run behind a prefix with no separator", `key${HEX}`],
		["a run with a letter stuck behind it", `${HEX}z`],
		["a longer run (65 digits)", `${HEX}a`],
		["a much longer run (128 digits)", HEX + HEX],
		["a run written as %xx escapes", escapeAll(HEX)],
		["a run written as %xx escapes twice", escapeAll(escapeAll(HEX))],
		["a run broken only by an escaped digit", `${HEX.slice(0, 30)}%${HEX.charCodeAt(30).toString(16)}${HEX.slice(31)}`],
		["a run on the second line", `first line\n${HEX}`],
	])("finds %s", (_name, text) => {
		expect(holdsHexKey(text)).toBe(true);
	});

	it.each([
		["an empty text", ""],
		["63 hex digits", HEX.slice(0, 63)],
		["a 40-digit commit id", HEX.slice(0, 40)],
		["64 characters that are not all hex digits", `${HEX.slice(0, 63)}g`],
		["two shorter runs", `${HEX.slice(0, 32)} ${HEX.slice(32)}`],
		["a run broken by a dash", `${HEX.slice(0, 32)}-${HEX.slice(32)}`],
		["ordinary words", "agx send npub1abc hello world"],
		["an npub", nip19.npubEncode(pair.publicKey)],
		["an nsec1 key (a different shape, not 64 hex)", nip19.nsecEncode(pair.secretKey)],
	])("does not find %s", (_name, text) => {
		expect(holdsHexKey(text)).toBe(false);
	});

	it("with a known key: finds that key and no other, as given, in capitals, escaped, or inside a longer run", () => {
		const other = bytesToHex(generateKeypair().secretKey);
		for (const text of [HEX, HEX.toUpperCase(), `my key ${HEX} ok`, `${HEX}a`, `a${HEX}`, escapeAll(HEX), escapeAll(escapeAll(HEX)), `--authkey=${HEX}`]) {
			expect(holdsHexKey(text, HEX), text.slice(0, 6)).toBe(true);
			expect(holdsHexKey(text, other), text.slice(0, 6)).toBe(false);
		}
		expect(holdsHexKey(HEX.toLowerCase(), HEX.toUpperCase())).toBe(true);
		expect(holdsHexKey(HEX.slice(0, 63), HEX)).toBe(false);
		expect(holdsHexKey("", HEX)).toBe(false);
	});

	it("reads a very long text in linear time", () => {
		const started = performance.now();
		expect(holdsHexKey("g".repeat(2_000_000))).toBe(false);
		expect(holdsHexKey("%47".repeat(300_000))).toBe(false);
		expect(holdsHexKey(`${"%47".repeat(300_000)}${HEX}`)).toBe(true);
		expect(holdsHexKey(`${"g".repeat(2_000_000)}${HEX}`, HEX)).toBe(true);
		expect(performance.now() - started).toBeLessThan(5000);
	});
});
