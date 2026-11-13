import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "../lib/config.js";
import { createIdentity, saveIdentity } from "../lib/identity.js";
import { agx, sandbox } from "../test/helpers.js";

// Every command that takes a peer reads it through toHexPubkey. A secret key
// pasted into that slot must be refused without being printed in full to a
// terminal, a log or an agent's context.

let box: ReturnType<typeof sandbox>;
const mine = createIdentity();
const friend = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(createIdentity().secretKeyHex));
const secretPart = NSEC.slice(8, 40);

beforeEach(() => {
	box = sandbox();
	saveIdentity("default", mine);
	updateProfile("default", { allow: [friend.publicKey] });
});

afterEach(() => {
	box.restore();
});

describe("a secret key given where a peer belongs", () => {
	it.each([
		["agx send", ["send", NSEC, "hello"]],
		["agx identity allow", ["identity", "allow", NSEC]],
		["agx identity deny", ["identity", "deny", NSEC]],
		["agx held allow", ["held", "allow", NSEC]],
		["agx held block", ["held", "block", NSEC]],
		["agx card", ["card", NSEC]],
	])("%s refuses it and prints none of it", async (_name, args) => {
		const run = await agx(...args);
		expect(run.code).toBe(2);
		expect(run.stderr).toMatch(/secret key/i);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(NSEC);
			expect(out).not.toContain(secretPart);
		}
	});

	it("leaves the allowlist as it was", async () => {
		await agx("identity", "allow", NSEC);
		await agx("identity", "deny", NSEC);
		await agx("held", "allow", NSEC);
		expect(getProfile("default").allow).toEqual([friend.publicKey]);
	});

	it("prints no secret in JSON mode either", async () => {
		const run = await agx("identity", "allow", NSEC, "--json");
		expect(run.code).toBe(2);
		for (const out of [run.stdout, run.stderr]) {
			expect(out).not.toContain(secretPart);
		}
	});
});
