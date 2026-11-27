import { scrubSecretKeys } from "@nostr-agx/nostr";
import { redactSecrets } from "./secrets.js";

/**
 * The last net before output. Every line the CLI prints (`output.ts`), every error it
 * reports and every body the gateway sends (`gateway/http.ts`) goes through here, so a
 * secret key that no check at its own slot looked for still does not come out.
 *
 * Two rules, in this order:
 *
 * 1. Anything shaped like a secret key (`nsec1…` or `ncryptsec1…`, any case, behind
 *    `nostr:`, written as `%xx` escapes) is replaced: the shared rule in `@nostr-agx/nostr`.
 * 2. Every value {@link redactSecrets} knows is replaced: the profile's own key in each
 *    form agx can print it, once its identity file has been read, and every API key.
 *
 * A run of 64 hex digits that is not one of those known values is NOT touched: it is as
 * likely a public key or an event id as a secret key. This is a net under the checks at
 * each slot, not a replacement for them.
 */

/** What takes the place of a key. The same text {@link redactSecrets} writes. */
export const REDACTED = "[redacted]";

/** `text` with every secret key in it replaced by {@link REDACTED}. Never throws: if anything goes wrong, the whole text is replaced. */
export function scrubOutput(text: string): string {
	try {
		return redactSecrets(scrubSecretKeys(text, REDACTED));
	} catch {
		return REDACTED;
	}
}

/**
 * `JSON.stringify(value, null, space)` with every string, and every name, run through
 * {@link scrubOutput}. The scrub is done on the values, not on the finished text: a
 * line feed is written in JSON as a backslash and an `n`, and the `n` would start a
 * match, so scrubbing the text could leave a lone backslash and break the document.
 * When nothing holds a key, the answer is exactly what `JSON.stringify` gives.
 *
 * Typed `string` as `JSON.stringify` is, though it answers `undefined` for `undefined`.
 */
export function scrubbedJson(value: unknown, space?: number): string {
	return JSON.stringify(value, scrubValue, space);
}

function scrubValue(_name: string, value: unknown): unknown {
	if (typeof value === "string") {
		return scrubOutput(value);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const names = Object.keys(value);
	const scrubbed = names.map(scrubOutput);
	if (names.every((name, i) => name === scrubbed[i])) {
		return value;
	}
	// No prototype, so a name that scrubs to `__proto__` is an ordinary name.
	const rebuilt = Object.create(null) as Record<string, unknown>;
	names.forEach((name, i) => {
		rebuilt[scrubbed[i] as string] = (value as Record<string, unknown>)[name];
	});
	return rebuilt;
}
