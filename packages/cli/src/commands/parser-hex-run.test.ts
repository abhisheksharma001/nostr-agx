import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed. A secret key written as
// 64 hex digits (the form a raw key has in a file or an env var) is not recognisable as a key by its
// prefix, so the parser's errors hide any 64-digit run, and say that the line may hold a key. Every
// key here is made when the test runs and none is real.

let box: ReturnType<typeof sandbox>;
const HEX = createIdentity().secretKeyHex;
const OTHER_HEX = createIdentity().secretKeyHex;
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
/** The whole of what is printed instead. Pinned exactly, so it cannot be edited into one that shows part of the key. */
const HIDDEN =
	"error: the command line may contain a secret key (a 64-character hex string), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";
/** The message for a key that starts with nsec1: unchanged. */
const HIDDEN_NSEC =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** Any 12-digit stretch of the run, in either case, also after %xx decoding; null if none. */
function leakedPart(shown: string, hex: string): string | null {
	const text = shown.toLowerCase();
	const decoded = text.replace(/%([0-9a-f]{2})/g, (_all, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)));
	for (let i = 0; i + 12 <= hex.length; i += 4) {
		const part = hex.slice(i, i + 12);
		if (text.includes(part) || decoded.includes(part)) {
			return part;
		}
	}
	return null;
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

describe("64 hex digits on a command line the parser rejects", () => {
	it.each([
		["an option written --name=<hex> (the case that was echoed whole)", [`--authkey=${HEX}`]],
		["an option written --name=<hex> of a subcommand", ["send", `--nope=${HEX}`, "someone", "hello"]],
		["an unknown command", [HEX]],
		["an unknown command, in capitals", [HEX.toUpperCase()]],
		["an unknown subcommand", ["identity", HEX]],
		["an unknown option made of the digits", [`--${HEX}`]],
		["too many arguments, the run among them", ["send", HEX, "hello", "world"]],
		["a choice option given the digits", ["register", "--slug", "demo", "--visibility", HEX]],
		["a run stuck to other text", [`key${HEX}more`]],
		["a run longer than 64 digits", [`${HEX}${HEX}`]],
		["the run written as %xx escapes", [[...HEX].map((ch) => `%${ch.charCodeAt(0).toString(16)}`).join("")]],
		["--json mode", ["--json", "send", HEX, "hello", "world"]],
		["two runs on one line", ["send", HEX, "hello", OTHER_HEX]],
	])("%s: says it may be a key and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(HIDDEN);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(HEX);
			expect(leakedPart(out, HEX)).toBeNull();
			expect(leakedPart(out, OTHER_HEX)).toBeNull();
		}
	});

	it("keeps the message for a key that starts with nsec1 as it was, and uses it when both are on the line", async () => {
		expect((await agx("send", NSEC, "hello", "world")).stderr).toBe(HIDDEN_NSEC);
		expect((await agx("send", NSEC, HEX, "hello", "world")).stderr).toBe(HIDDEN_NSEC);
	});

	it("does not hide an option written --name=<value> that holds no key: the usual help stays", async () => {
		const run = await agx("--authkey=abc123");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--authkey=abc123'\n");
	});
});

describe("every other parser error is unchanged", () => {
	it.each([
		["a typo in a command", ["sned"], ["unknown command 'sned'", "Did you mean send?"]],
		["a typo in an option", ["send", "--subjct", "x", "npub1abc", "hello"], ["unknown option '--subjct'", "Did you mean --subject?"]],
		["too many arguments", ["send", "npub1abc", "hello", "world"], ["too many arguments for 'send'", "npub1abc, hello, world"]],
		["a run of 63 digits", ["send", HEX.slice(0, 63), "hello", "world"], ["too many arguments for 'send'", HEX.slice(0, 63)]],
		["a run of 40 digits (a commit id)", ["send", HEX.slice(0, 40), "hello", "world"], ["too many arguments for 'send'", HEX.slice(0, 40)]],
		["a choice option with a wrong word", ["register", "--slug", "demo", "--visibility", "everyone"], ["argument 'everyone' is invalid", "Allowed choices are"]],
	])("%s", async (_name, args, expected) => {
		const run = await agx(...args);
		expect(run.code).toBe(1);
		for (const part of expected) {
			expect(run.stderr).toContain(part);
		}
		expect(run.stderr).not.toContain("secret key");
	});

	it("prints the usual help for --help and the version for --version", async () => {
		expect((await agx("--help")).stdout).toContain("Usage: agx");
		expect((await agx("--version")).stdout).toMatch(/^\d+\.\d+\.\d+/);
	});
});
