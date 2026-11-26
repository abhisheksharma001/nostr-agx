import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The discovery functions dial relays themselves. Without a WebSocket argument
// they use the runtime's global WebSocket, which Node 20 does not have, so a
// lookup there finds nothing and says nothing. An example that calls one of them
// has to hand over the same WebSocket class it gives the transport.

const DISCOVERY_FUNCTIONS = [
	"fetchByAuthor",
	"fetchByAuthorWithStatus",
	"resolveNip05",
	"resolvePeerCard",
	"resolvePeerCardWithStatus",
	"resolvePeerRelays",
	"resolvePeerRelaysWithPins",
];

/** The text between the parentheses of each call to one of the functions. */
function discoveryCalls(source: string): string[] {
	const calls: string[] = [];
	const pattern = new RegExp(`(?<![\\w.])(${DISCOVERY_FUNCTIONS.join("|")})\\(`, "g");
	for (const match of source.matchAll(pattern)) {
		const start = (match.index ?? 0) + match[0].length;
		let depth = 1;
		let end = start;
		while (end < source.length && depth > 0) {
			const ch = source[end];
			depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
			end += 1;
		}
		calls.push(source.slice(start, end - 1));
	}
	return calls;
}

const passesWebSocket = (args: string) => /\b(ws|WebSocket|webSocket)\b/.test(args);

function exampleFiles(dir: URL): URL[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) {
			return [];
		}
		const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
		if (entry.isDirectory()) {
			return exampleFiles(child);
		}
		return /\.(mjs|ts)$/.test(entry.name) ? [child] : [];
	});
}

describe("finding discovery calls in example code", () => {
	it("sees a call that passes no WebSocket", () => {
		const [args] = discoveryCalls("const card = await resolvePeerCard(pk, [RELAY]);");
		expect(args).toBe("pk, [RELAY]");
		expect(passesWebSocket(args ?? "")).toBe(false);
	});

	it("sees a call that passes one, however it is spelled", () => {
		for (const source of [
			"await resolvePeerCard(pk, [RELAY], undefined, WebSocket);",
			"await resolvePeerCard(pk, [RELAY], signer, transport.webSocket);",
			"await fetchByAuthor({ relays, author, kinds: [1], ws: WebSocket });",
		]) {
			const [args] = discoveryCalls(source);
			expect(passesWebSocket(args ?? ""), source).toBe(true);
		}
	});

	it("ignores a method with the same name on another object", () => {
		expect(discoveryCalls("await client.resolvePeerCard(pk);")).toEqual([]);
	});
});

describe("the examples", () => {
	const examples = exampleFiles(new URL("../examples/", import.meta.url));

	it("include code that makes a discovery call", () => {
		const calls = examples.flatMap((file) =>
			discoveryCalls(readFileSync(file, "utf8")),
		);
		expect(calls.length).toBeGreaterThan(0);
	});

	it.each(examples.map((file) => [fileURLToPath(file).split("/examples/")[1]!, file] as const))(
		"%s passes a WebSocket to every discovery call it makes",
		(_name, file) => {
			for (const args of discoveryCalls(readFileSync(file, "utf8"))) {
				expect(passesWebSocket(args), `call with arguments: ${args}`).toBe(true);
			}
		},
	);
});
