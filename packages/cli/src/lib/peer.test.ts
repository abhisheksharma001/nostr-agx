import { hexToBytes } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { AgxCliError, EXIT } from "./errors.js";
import { createIdentity } from "./identity.js";
import { toHexPubkey } from "./peer.js";

const identity = createIdentity();
const NSEC = nip19.nsecEncode(hexToBytes(identity.secretKeyHex));

function failure(input: string, label?: string): AgxCliError {
	try {
		toHexPubkey(input, label);
	} catch (error) {
		expect(error).toBeInstanceOf(AgxCliError);
		return error as AgxCliError;
	}
	throw new Error(`toHexPubkey accepted ${JSON.stringify(input)}`);
}

describe("toHexPubkey", () => {
	it("accepts an npub and a hex pubkey and returns lowercase hex", () => {
		expect(toHexPubkey(identity.npub)).toBe(identity.publicKey);
		expect(toHexPubkey(identity.publicKey.toUpperCase())).toBe(identity.publicKey);
		expect(toHexPubkey(`  ${identity.npub}  `)).toBe(identity.publicKey);
	});

	it("names a bad value in its error, so a typo can be found", () => {
		const error = failure("npub1notakey", "recipient");
		expect(error.message).toContain('"npub1notakey"');
		expect(error.message).toContain("recipient");
		expect(error.exitCode).toBe(EXIT.usage);
	});

	describe("given a pasted secret key", () => {
		// 32 characters from the middle of the key: present in every variant pasted below.
		const secretPart = NSEC.slice(8, 40);

		it("refuses it without printing it", () => {
			const error = failure(NSEC, "recipient");
			expect(error.message).not.toContain(NSEC);
			expect(error.message).not.toContain(secretPart);
			expect(error.remediation ?? "").not.toContain(secretPart);
			expect(error.exitCode).toBe(EXIT.usage);
		});

		it("says why, and still says what to use instead", () => {
			const error = failure(NSEC, "recipient");
			expect(error.message).toMatch(/secret key/i);
			expect(error.message).toContain("recipient");
			expect(error.message).toContain("npub1");
		});

		it.each([
			["in capitals", NSEC.toUpperCase()],
			["with spaces around it", `  ${NSEC}\n`],
			["with the nostr: scheme", `nostr:${NSEC}`],
			["with a typo (one character too many)", `${NSEC}q`],
			["with a typo (cut short)", NSEC.slice(0, -4)],
		])("does not print it %s", (_name, pasted) => {
			const error = failure(pasted, "peer");
			const shown = `${error.message}\n${error.remediation ?? ""}`;
			expect(shown).not.toContain(secretPart);
			expect(shown.toLowerCase()).not.toContain(secretPart.toLowerCase());
		});
	});
});
