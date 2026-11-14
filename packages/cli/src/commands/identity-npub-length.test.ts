import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveProfile } from "../lib/config.js";
import { EXIT } from "../lib/errors.js";
import { setJsonMode } from "../lib/output.js";
import { agx, sandbox } from "../test/helpers.js";

// An npub is bech32 for exactly 32 bytes. nostr-tools encodes and decodes one of any length, so
// `agx` has to check the length itself, or a junk entry lands in the allowlist and `send` fails later.

let box: ReturnType<typeof sandbox>;

beforeEach(async () => {
	box = sandbox();
	await agx("identity", "new");
});

afterEach(() => {
	setJsonMode(false);
	process.exitCode = undefined;
	box.restore();
});

describe("a peer given as an npub that does not carry 32 bytes", () => {
	it.each([20, 33])("identity allow refuses an npub that carries %i bytes and stores nothing", async (bytes) => {
		const run = await agx("identity", "allow", toNpub("ab".repeat(bytes)));
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("is not a valid peer");
		expect(effectiveProfile("default").allow).toEqual([]);
	});

	it("identity allow stores nothing from a list when one entry is the wrong length", async () => {
		const run = await agx("identity", "allow", toNpub("cd".repeat(32)), toNpub("ab".repeat(20)));
		expect(run.code).toBe(EXIT.usage);
		expect(effectiveProfile("default").allow).toEqual([]);
	});

	it("identity deny refuses it too", async () => {
		const run = await agx("identity", "deny", toNpub("ab".repeat(20)));
		expect(run.code).toBe(EXIT.usage);
		expect(run.stderr).toContain("is not a valid peer");
	});

	it("an npub that carries 32 bytes is still allowed", async () => {
		const run = await agx("identity", "allow", toNpub("cd".repeat(32)));
		expect(run.code).toBe(EXIT.ok);
		expect(effectiveProfile("default").allow).toEqual(["cd".repeat(32)]);
	});
});
