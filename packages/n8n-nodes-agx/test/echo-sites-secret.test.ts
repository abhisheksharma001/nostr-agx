import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import { nip19 } from "nostr-tools";
import { encrypt } from "nostr-tools/nip49";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agx } from "../nodes/Agx/Agx.node";
import { numberOption } from "../nodes/shared/numbers";
import { parseCapabilities, parsePeer, parsePeerList } from "../nodes/shared/peers";
import { executeContext, newAgent, type RunningRelay, startTestRelay } from "./helpers";

/**
 * A secret key typed where an agent, a capability or a number belongs must not
 * be sent or shown back in an n8n error: the error lands in the execution log
 * and in the editor. A capability goes to the other agent inside the request
 * and onto the public Agent Card.
 *
 * Every key here is made at run time from a throwaway key. A test that passes
 * before the fix is a control: it guards behaviour the fix must keep.
 */

const KEYS = [
	{ kind: "nsec1…", key: nip19.nsecEncode(generateKeypair().secretKey), prefix: "nsec1" },
	// A NIP-49 string from a throwaway key (scrypt cost 2^4: fast, and no more real than the key).
	{ kind: "ncryptsec1…", key: encrypt(generateKeypair().secretKey, "throwaway-password", 4), prefix: "ncryptsec1" },
];

/** True when `text` holds any 12-character stretch of the key's data part (not its constant name), in any case. */
function leaksKey(text: string, key: string, prefix: string): boolean {
	const data = key.toLowerCase().slice(prefix.length);
	const lower = text.toLowerCase();
	for (let i = 0; i + 12 <= data.length; i++) {
		if (lower.includes(data.slice(i, i + 12))) {
			return true;
		}
	}
	return false;
}

/** The message of what `run` throws, or "" when it does not throw. */
function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

let relay: RunningRelay;
beforeAll(async () => {
	relay = await startTestRelay();
});
afterAll(async () => {
	await relay.close();
});

describe.each(KEYS)("a secret key ($kind) typed into a field of the n8n nodes", ({ key, prefix }) => {
	const forms = [
		{ name: "in plain", text: key },
		{ name: "in capitals, behind nostr:", text: `nostr:${key.toUpperCase()}` },
	];

	describe.each(forms)("$name", ({ text }) => {
		it("is not repeated when it is typed as an agent", () => {
			const message = messageOf(() => parsePeer(text));
			expect(message).toContain("not shown");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});

		it("is not repeated when it is typed in a list of agents", () => {
			const message = messageOf(() => parsePeerList(`${toNpub(generateKeypair().publicKey)}, ${text}`));
			expect(message).toContain("not shown");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});

		it("is not repeated when it is typed as a number", () => {
			const message = messageOf(() => numberOption(text, "Timeout (Seconds)", 30, { min: 1, max: 60 }));
			expect(message).toContain("Timeout (Seconds) must be a number");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});

		it("is refused as a capability a workflow serves", () => {
			const message = messageOf(() => parseCapabilities(`invoice.review, ${text}`));
			expect(message).toContain("not shown");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});

		it("is refused as the capability of a task request, and nothing is sent", async () => {
			const n8nAgent = newAgent(relay);
			const ctx = executeContext({
				credentials: n8nAgent.credentials,
				params: () => ({
					resource: "task",
					operation: "request",
					peer: newAgent(relay).publicKey,
					capability: text,
					payload: "{}",
					options: { timeout: 1 },
				}),
			});
			const error = await new Agx().execute.call(ctx).then(
				() => null,
				(e: unknown) => e,
			);
			const message = error instanceof Error ? error.message : "";
			expect(message).toContain("not shown");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});

		it("is refused as the capability asked about on an agent's card", async () => {
			const n8nAgent = newAgent(relay);
			const ctx = executeContext({
				credentials: n8nAgent.credentials,
				params: () => ({
					resource: "agent",
					operation: "getCard",
					peer: newAgent(relay).publicKey,
					options: { capability: text },
				}),
			});
			const error = await new Agx().execute.call(ctx).then(
				() => null,
				(e: unknown) => e,
			);
			const message = error instanceof Error ? error.message : "";
			expect(message).toContain("not shown");
			expect(leaksKey(message, key, prefix)).toBe(false);
		});
	});
});

describe("ordinary values are still quoted and accepted", () => {
	it("quotes a bad agent as written", () => {
		expect(messageOf(() => parsePeer("bob"))).toContain('"bob"');
	});

	it("quotes a bad entry of an allowlist as written", () => {
		expect(messageOf(() => parsePeerList("alice"))).toContain("alice");
	});

	it("quotes a bad number as written", () => {
		expect(messageOf(() => numberOption("soon", "Timeout (Seconds)", 30, { min: 1, max: 60 }))).toContain('"soon"');
	});

	it("accepts ordinary capability names", () => {
		expect(parseCapabilities("invoice.review, invoice.approve")).toEqual(["invoice.review", "invoice.approve"]);
	});
});
