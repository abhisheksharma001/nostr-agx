import { bytesToHex, publicKeyFromSecret } from "@nostr-agx/nostr";
import { generateSecretKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliRun, agx, sandbox } from "../test/helpers.js";

// The command parser prints its own usage errors, quoting what was typed. A
// 64-digit hex SECRET key typed where a command name or an option name belongs
// (`agx <hex>`, `agx --<hex>`, `agx identity <hex>` after forgetting `import`)
// came back in full in `unknown command '…'` / `unknown option '…'`.
//
// This pins only that narrow case. Whether agx should hide ANY 64-hex string
// (a hex public key is legitimate in other errors) is an open question
// (issue #57), so every error that is not an unknown-command / unknown-option
// error quoting 64 hex digits must stay as it was.
//
// Assertions compare small summaries, never the printed text itself, so a
// failing run cannot dump a key into a log.

let box: ReturnType<typeof sandbox>;
const SECRET = bytesToHex(generateSecretKey());
/** A hex PUBLIC key: legitimate in parser errors, must stay visible. */
const PEER = publicKeyFromSecret(generateSecretKey());
const NSEC = nip19.nsecEncode(generateSecretKey());

/** The whole of what is printed instead: pinned exactly, so the message cannot be edited into one that shows part of the key. */
const REPLACED_HEX =
	"error: the command line has what may be a secret key (64 hex digits) where a command or option name belongs, so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";
/** The text PR #53 prints for an nsec1… key: unchanged. */
const REPLACED_NSEC =
	"error: the command line contains a secret key (nsec1…), so the error that quotes it is not shown. Check the arguments with `agx --help`.\n";

/** True when any 10-character stretch of `key` (in any case) is in `shown`. */
function leaks(shown: string, key: string): boolean {
	const text = shown.toLowerCase();
	const secret = key.toLowerCase();
	for (let i = 0; i + 10 <= secret.length; i++) {
		if (text.includes(secret.slice(i, i + 10))) {
			return true;
		}
	}
	return false;
}

/** What a run printed, without the printed text: safe to show in a failing assertion. */
function summarize(run: CliRun, key: string, replacement: string) {
	return {
		code: run.code,
		stdout: run.stdout === "" ? "" : "(something was printed)",
		stderr: run.stderr === replacement ? "(the fixed replacement)" : "(something else)",
		leaked: leaks(run.stdout + run.stderr, key),
	};
}

beforeEach(() => {
	box = sandbox();
});

afterEach(() => {
	box.restore();
});

const MISPLACED: Array<[string, (hex: string) => string[]]> = [
	["agx <hex>", (hex) => [hex]],
	["agx --<hex>", (hex) => [`--${hex}`]],
	["agx identity <hex> (forgot import)", (hex) => ["identity", hex]],
	["agx identity --<hex> import", (hex) => ["identity", `--${hex}`, "import"]],
	["agx --<hex> identity import", (hex) => [`--${hex}`, "identity", "import"]],
	["agx --<hex>=value", (hex) => [`--${hex}=value`]],
	["agx --secret=<hex>", (hex) => [`--secret=${hex}`]],
	["agx -<hex>", (hex) => [`-${hex}`]],
	["agx identity --<hex>", (hex) => ["identity", `--${hex}`]],
	["agx send --<hex> someone hello", (hex) => ["send", `--${hex}`, "someone", "hello"]],
	["a quote before the key", (hex) => [`it's${hex}`]],
	["a line break before the key", (hex) => [`a\n${hex}`]],
	["the key inside a longer word", (hex) => [`key-${hex}-copy`]],
	["a key twice as long", (hex) => [`${hex}${hex}`]],
];

describe("a 64-digit hex secret key typed as a command or option name", () => {
	describe.each([
		["lower case", SECRET],
		["UPPER CASE", SECRET.toUpperCase()],
	])("%s", (_label, hex) => {
		describe.each([
			["text", [] as string[]],
			["--json", ["--json"]],
		])("%s", (_mode, flags) => {
			it.each(MISPLACED)("%s: says why and prints none of it", async (_name, make) => {
				const run = await agx(...flags, ...make(hex));
				expect(summarize(run, SECRET, REPLACED_HEX)).toEqual({
					code: 1,
					stdout: "",
					stderr: "(the fixed replacement)",
					leaked: false,
				});
			});
		});
	});
});

describe("every other parser error is unchanged", () => {
	it("still shows a hex public key in 'too many arguments' (peer plus an unquoted message)", async () => {
		const run = await agx("send", PEER, "hello", "world");
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			`error: too many arguments for 'send'. Expected 2 arguments but got 3: ${PEER}, hello, world.\n`,
		);
	});

	it("still shows a hex public key in 'too many arguments' of an identity subcommand, in --json mode too", async () => {
		const run = await agx("--json", "identity", "show", PEER);
		expect(run.code).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(
			`error: too many arguments for 'show'. Expected 0 arguments but got 1: ${PEER}.\n`,
		);
	});

	it("does not replace 'too many arguments' because an argument looks like an unknown-command error", async () => {
		const run = await agx("send", "error: unknown command '", PEER, "extra");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(
			`error: too many arguments for 'send'. Expected 2 arguments but got 3: error: unknown command ', ${PEER}, extra.\n`,
		);
	});

	it("still names an unknown option of send, next to a hex public key", async () => {
		const run = await agx("send", PEER, "hello", "--bogus");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--bogus'\n");
	});

	it("still names a missing argument of identity deny", async () => {
		const run = await agx("identity", "deny");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: missing required argument 'peers'\n");
	});

	it("leaves identity allow <pubkey> <word> to its own error (not a parser error)", async () => {
		const run = await agx("identity", "allow", PEER, "extra");
		expect(run.code).toBe(2);
		expect(run.stderr).toContain('"extra" is not a valid peer');
	});

	it("still suggests the nearest command for a mistyped command", async () => {
		const run = await agx("sned");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown command 'sned'\n(Did you mean send?)\n");
	});

	it("still suggests the nearest subcommand of identity", async () => {
		const run = await agx("identity", "nwe");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown command 'nwe'\n(Did you mean new?)\n");
	});

	it("still names an unknown long option and suggests the nearest one", async () => {
		const run = await agx("--jsno");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '--jsno'\n(Did you mean --json?)\n");
	});

	it("still names an unknown short option", async () => {
		const run = await agx("-x");
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("error: unknown option '-x'\n");
	});

	it("still names an unknown command that is hex but shorter than a key (a commit id)", async () => {
		const commit = PEER.slice(0, 40);
		const run = await agx(commit);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(`error: unknown command '${commit}'\n`);
	});

	it("still names a 64-character unknown command that is not hex", async () => {
		const word = "g".repeat(64);
		const run = await agx(word);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(`error: unknown command '${word}'\n`);
	});

	it("keeps the nsec1 text for an nsec1 key, also next to a hex key", async () => {
		for (const args of [[NSEC], [`${NSEC}${SECRET}`], [`--${SECRET}${NSEC}`]]) {
			const run = await agx(...args);
			expect(summarize(run, SECRET, REPLACED_NSEC)).toEqual({
				code: 1,
				stdout: "",
				stderr: "(the fixed replacement)",
				leaked: false,
			});
		}
	});

	it("still prints the help and exits 0", async () => {
		const run = await agx("--help");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("Usage: agx");
		expect(run.stderr).toBe("");
	});

	it("still prints the version and exits 0", async () => {
		const run = await agx("--version");
		expect(run.code).toBe(0);
		expect(run.stdout).toMatch(/^\d+\.\d+\.\d+/);
		expect(run.stderr).toBe("");
	});
});
