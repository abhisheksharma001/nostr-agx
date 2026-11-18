import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import kleur from "kleur";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { agx, fakeClock, jsonDocuments, sandbox, useClock } from "../test/helpers.js";
import { CONTRACT, type MockIndexServer, startMockIndexServer } from "../test/mock-index-server.js";
import { renderListingRows } from "./listing.js";

// What `agx listing` and `agx search` print about listings the index returns. Every
// field of a listing is text somebody chose (a name, a handle, a summary, a capability),
// so it must reach the terminal as text. The index here is a stand-in on a free port.

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const LF = String.fromCharCode(0x0a);
const DEL = String.fromCharCode(0x7f);
const CSI = String.fromCharCode(0x9b);
const LS = String.fromCharCode(0x2028);
/** What each control character is printed as. */
const R = String.fromCharCode(0xfffd);

/** A listing in which every text field holds control characters. */
const ODD_LISTING = {
	id: `l_9${ESC}[2J`,
	slug: `evil${ESC}[31m-bot`,
	displayName: `Evil${ESC}[0m${LS}Fake${LF}FORGED ROW`,
	handle: `ceo${ESC}[1A@evil.example`,
	npub: `npub1${ESC}[31m${"q".repeat(54)}`,
	verified: false,
	capabilities: [`invoice${ESC}[1;31m.parse`, `pay${CR}PAID`],
	visibility: `public${ESC}[0m`,
	status: `listed${LF}FORGED STATUS`,
	summary: `line one${LF}  summary         FORGED LINE${DEL}${CSI}31m`,
	source: `team${ESC}[0m`,
	relays: [`wss://relay.example${ESC}[2J`],
};

/** The same, as it should be printed. */
const SHOWN = {
	id: `l_9${R}[2J`,
	slug: `evil${R}[31m-bot`,
	displayName: `Evil${R}[0m${R}Fake${R}FORGED ROW`,
	handle: `ceo${R}[1A@evil.example`,
	npub: `npub1${R}[31m${"q".repeat(54)}`,
	capabilities: `invoice${R}[1;31m.parse, pay${R}PAID`,
	visibility: `public${R}[0m`,
	status: `listed${R}FORGED STATUS`,
	summary: `line one${R}  summary         FORGED LINE${R}${R}31m`,
	source: `team${R}[0m`,
	relays: `wss://relay.example${R}[2J`,
};

/** A listing of ordinary text: accents, other scripts, emoji and a 200-character name. */
const CLEAN_LISTING = {
	id: "l_7",
	slug: "invoice-desk",
	displayName: "Café Ünïcode 日本語 🙂 ".padEnd(200, "n"),
	handle: "desk@example.com",
	npub: `npub1${"q".repeat(58)}`,
	verified: true,
	capabilities: ["invoice.review", "ñandú.résumé"],
	visibility: "public",
	status: "listed",
	summary: "Reviews invoices — café ☕ 日本語.",
	source: "external",
	relays: ["wss://relay.example.com"],
};

let box: ReturnType<typeof sandbox>;
let clock: ReturnType<typeof fakeClock>;
let restoreClock: () => void;
let mock: MockIndexServer;

beforeAll(() => {
	kleur.enabled = false;
});

beforeEach(async () => {
	box = sandbox();
	clock = fakeClock();
	restoreClock = useClock(clock);
	mock = await startMockIndexServer({ now: clock.now });
	const key = mock.addKey({
		scoped: true,
		scopes: CONTRACT.scopes,
		clientId: "agx",
		expiresAt: "2099-01-01T00:00:00.000Z",
	});
	setCredential("default", {
		apiBaseUrl: mock.origin,
		apiKey: key.key,
		apiKeyId: key.id,
		source: "login",
		clientId: "agx",
		organization: key.organization,
		user: null,
		scopes: CONTRACT.scopes,
		expiresAt: key.expiresAt,
		createdAt: new Date(clock.now()).toISOString(),
	});
	updateProfile("default", { apiBaseUrl: mock.origin, orgSlug: "acme-robotics", relays: [] });
});

afterEach(async () => {
	await mock.close();
	restoreClock();
	box.restore();
});

/** Every character a terminal or a line-oriented reader may act on, other than the newline that ends a line. */
function strayControls(text: string): string[] {
	const found: string[] = [];
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if ((code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
			found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
		}
	}
	return found;
}

/** What a `label   value` line of the human output shows after its label, or undefined when there is no such line. */
function field(stdout: string, label: string): string | undefined {
	const prefix = `  ${label}`;
	const line = stdout.split("\n").find((l) => l.startsWith(prefix) && l[prefix.length] === " ");
	return line?.slice(prefix.length).replace(/^ +/, "");
}

/** The lines of the table that starts at the header line beginning with `header`, up to the next empty line. */
function tableLines(stdout: string, header: string): string[] {
	const lines = stdout.split("\n");
	const start = lines.findIndex((l) => l.startsWith(header));
	if (start < 0) {
		return [];
	}
	const end = lines.findIndex((l, i) => i > start && l === "");
	return lines.slice(start, end < 0 ? undefined : end);
}

function lastJson(stdout: string): Record<string, any> {
	return jsonDocuments(stdout).at(-1) as Record<string, any>;
}

const answer = (path: string, output: unknown) => mock.setRpc(path, () => ({ output }));

describe("the rows agx search and agx listing build", () => {
	it("replace control characters in every text cell and keep each row to one line", () => {
		expect(renderListingRows([ODD_LISTING])).toEqual([
			[
				SHOWN.displayName,
				`npub1${R}[31mqq…qqqq`,
				`${SHOWN.handle} (unverified)`,
				"—",
				`invoice${R}[1;31m.parse,pay${R}PAID`,
			],
		]);
	});

	it("keep ordinary text as it is", () => {
		expect(renderListingRows([CLEAN_LISTING, { ...CLEAN_LISTING, handle: null, verified: false, capabilities: [] }])).toEqual([
			[CLEAN_LISTING.displayName, "npub1qqqqqqq…qqqq", "desk@example.com", "yes", "invoice.review,ñandú.résumé"],
			[CLEAN_LISTING.displayName, "npub1qqqqqqq…qqqq", "—", "—", ""],
		]);
	});
});

describe("agx search, when a listing holds control characters", () => {
	it("prints each listing on one table row with control characters replaced", async () => {
		answer("agentIndex/searchListings", { listings: [CLEAN_LISTING, ODD_LISTING], total: 2 });

		const run = await agx("search");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const table = tableLines(run.stdout, "NAME");
		expect(table).toHaveLength(3);
		const row = table[2] ?? "";
		let at = 0;
		for (const cell of [SHOWN.displayName, `npub1${R}[31mqq…qqqq`, `${SHOWN.handle} (unverified)`, "—", `invoice${R}[1;31m.parse,pay${R}PAID`]) {
			const found = row.indexOf(cell, at);
			expect(found, `cell ${cell} in row ${row}`).toBeGreaterThanOrEqual(at);
			at = found + cell.length;
		}
		expect(run.stdout.split("\n").filter((l) => l.startsWith("FORGED ROW"))).toEqual([]);
	});

	it("keeps the table the same width on every line", async () => {
		answer("agentIndex/searchListings", { listings: [CLEAN_LISTING, ODD_LISTING], total: 2 });

		const run = await agx("search");

		const widths = new Set(tableLines(run.stdout, "NAME").map((l) => l.length));
		expect([...widths]).toHaveLength(1);
	});
});

describe("agx listing list, when a listing holds control characters", () => {
	it("prints each listing on one table row with control characters replaced", async () => {
		answer("agentIndex/searchListings", { listings: [ODD_LISTING], total: 1 });

		const run = await agx("listing", "list");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const table = tableLines(run.stdout, "ID");
		expect(table).toHaveLength(2);
		expect(table[1]).toBe(
			[SHOWN.id, SHOWN.slug, SHOWN.status, SHOWN.visibility, `invoice${R}[1;31m.parse,pay${R}PAID`].join("  "),
		);
		expect(run.stdout.split("\n").filter((l) => l.startsWith("FORGED STATUS"))).toEqual([]);
	});
});

describe("agx listing get, when the listing holds control characters", () => {
	it("prints every field on its own line with control characters replaced", async () => {
		answer("agentIndex/getListing", { listing: ODD_LISTING, verificationEvents: [] });

		const run = await agx("listing", "get", "l_9");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(SHOWN.displayName);
		expect(field(run.stdout, "id")).toBe(SHOWN.id);
		expect(field(run.stdout, "slug")).toBe(SHOWN.slug);
		expect(field(run.stdout, "npub")).toBe(SHOWN.npub);
		expect(field(run.stdout, "handle")).toBe(`${SHOWN.handle} (unverified)`);
		expect(field(run.stdout, "status")).toBe(SHOWN.status);
		expect(field(run.stdout, "visibility")).toBe(SHOWN.visibility);
		expect(field(run.stdout, "capabilities")).toBe(SHOWN.capabilities);
		expect(field(run.stdout, "summary")).toBe(SHOWN.summary);
		expect(lines.filter((l) => l.startsWith("FORGED") || l.startsWith("  summary         FORGED"))).toEqual([]);
	});

	it("prints the visibility on the warning line with control characters replaced", async () => {
		answer("agentIndex/getListing", { listing: { ...ODD_LISTING, status: "listed" }, verificationEvents: [] });

		const run = await agx("listing", "get", "l_9");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout).toContain(`! Listed, but visibility is "${SHOWN.visibility}" — `);
	});
});

describe("agx listing, when the index answers a change with control characters", () => {
	it("create prints the new listing with control characters replaced", async () => {
		answer("agentIndex/createListing", ODD_LISTING);

		const run = await agx("listing", "create", "--team", "t_1", "--slug", "evil-bot");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(`✓ Created listing ${SHOWN.id}`);
		expect(field(run.stdout, "slug")).toBe(SHOWN.slug);
		expect(field(run.stdout, "source")).toBe(SHOWN.source);
		expect(field(run.stdout, "status")).toBe(SHOWN.status);
		expect(field(run.stdout, "visibility")).toBe(SHOWN.visibility);
		expect(field(run.stdout, "capabilities")).toBe(SHOWN.capabilities);
		expect(lines).toContain(`· Listings are born as drafts. Publish it with:  agx listing publish ${SHOWN.id}`);
	});

	it("create --pubkey prints the relays with control characters replaced", async () => {
		answer("agentIndex/createListing", ODD_LISTING);
		const npub = toNpub(generateKeypair().publicKey);

		const run = await agx("listing", "create", "--pubkey", npub, "--slug", "evil-bot", "--relay", "wss://relay.example.com");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(field(run.stdout, "relays")).toBe(SHOWN.relays);
	});

	it("publish prints the status, visibility and capabilities with control characters replaced", async () => {
		answer("agentIndex/publishListing", { listing: ODD_LISTING, cardPublished: false });

		const run = await agx("listing", "publish", "l_9");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		const lines = run.stdout.split("\n");
		expect(lines).toContain(`✓ Listing is now "${SHOWN.status}".`);
		expect(field(run.stdout, "visibility")).toBe(SHOWN.visibility);
		expect(field(run.stdout, "capabilities")).toBe(SHOWN.capabilities);
		expect(run.stdout).toContain(`! Visibility is "${SHOWN.visibility}" — `);
	});

	it("publish --wait prints the capabilities with control characters replaced", async () => {
		answer("agentIndex/getListing", {
			listing: { ...ODD_LISTING, status: "listed", visibility: "public" },
			verificationEvents: [],
		});

		const run = await agx("listing", "publish", "l_9", "--wait");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain("✓ The listing is public and listed.");
		expect(field(run.stdout, "capabilities")).toBe(SHOWN.capabilities);
	});

	it("set-visibility prints the visibility with control characters replaced", async () => {
		answer("agentIndex/updateListing", { ...ODD_LISTING, cardRetractionRequested: false });

		const run = await agx("listing", "set-visibility", "public", "l_9");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain(`✓ Visibility is now "${SHOWN.visibility}".`);
	});

	it("delist prints the status with control characters replaced", async () => {
		answer("agentIndex/delistListing", { listing: ODD_LISTING, cardRetractionRequested: false });

		const run = await agx("listing", "delist", "l_9");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(run.stdout.split("\n")).toContain(`✓ Listing is now "${SHOWN.status}".`);
	});

	it("set-policy prints the capabilities with control characters replaced", async () => {
		answer("agentIndex/updateListing", {
			...ODD_LISTING,
			autoAllowContact: true,
			autoAllowCapabilities: [`pay${ESC}[31m`, `read${LF}FORGED`],
			autoAllowDailyCap: 5,
		});

		const run = await agx("listing", "set-policy", "l_9", "--auto-allow", "--capability", "pay");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(field(run.stdout, "capabilities")).toBe(`pay${R}[31m, read${R}FORGED`);
		expect(field(run.stdout, "dailyCap")).toBe("5");
	});
});

describe("--json, when a listing holds control characters", () => {
	it("agx search --json keeps every value as the index sent it and writes no raw control character", async () => {
		answer("agentIndex/searchListings", { listings: [CLEAN_LISTING, ODD_LISTING], total: 2 });

		const run = await agx("search", "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(lastJson(run.stdout)).toEqual({ listings: [CLEAN_LISTING, ODD_LISTING], total: 2 });
	});

	it("agx listing list --json keeps every value as the index sent it and writes no raw control character", async () => {
		answer("agentIndex/searchListings", { listings: [ODD_LISTING], total: 1 });

		const run = await agx("listing", "list", "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(lastJson(run.stdout)).toEqual({ listings: [ODD_LISTING], total: 1 });
	});

	it("agx listing get --json keeps every value as the index sent it and writes no raw control character", async () => {
		answer("agentIndex/getListing", { listing: ODD_LISTING, verificationEvents: [] });

		const run = await agx("listing", "get", "l_9", "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(lastJson(run.stdout)).toEqual({ listing: ODD_LISTING, verificationEvents: [] });
	});

	it("agx listing create --json keeps every value as the index sent it and writes no raw control character", async () => {
		answer("agentIndex/createListing", ODD_LISTING);

		const run = await agx("listing", "create", "--team", "t_1", "--slug", "evil-bot", "--json");

		expect(run.code, run.stderr).toBe(0);
		expect(strayControls(run.stdout)).toEqual([]);
		expect(lastJson(run.stdout)).toEqual({ listing: ODD_LISTING });
	});
});

describe("agx search and agx listing, with ordinary text", () => {
	it("agx search prints accents, other scripts, emoji and a 200-character name exactly as sent", async () => {
		expect(CLEAN_LISTING.displayName).toHaveLength(200);
		answer("agentIndex/searchListings", { listings: [CLEAN_LISTING], total: 1 });

		const run = await agx("search");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		const [header, row] = tableLines(run.stdout, "NAME");
		expect(header).toContain("NPUB");
		expect(row).toBe(
			[CLEAN_LISTING.displayName, "npub1qqqqqqq…qqqq", "desk@example.com", "yes     ", "invoice.review,ñandú.résumé"].join("  "),
		);
	});

	it("agx listing list prints a row exactly as sent", async () => {
		answer("agentIndex/searchListings", { listings: [CLEAN_LISTING], total: 1 });

		const run = await agx("listing", "list");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		expect(tableLines(run.stdout, "ID")[1]).toBe(
			["l_7", "invoice-desk", "listed", "public    ", "invoice.review,ñandú.résumé"].join("  "),
		);
	});

	it("agx listing get prints every field exactly as sent", async () => {
		answer("agentIndex/getListing", { listing: CLEAN_LISTING, verificationEvents: [] });

		const run = await agx("listing", "get", "l_7");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		expect(run.stdout.split("\n")).toContain(CLEAN_LISTING.displayName);
		expect(field(run.stdout, "id")).toBe("l_7");
		expect(field(run.stdout, "slug")).toBe("invoice-desk");
		expect(field(run.stdout, "npub")).toBe(CLEAN_LISTING.npub);
		expect(field(run.stdout, "handle")).toBe("desk@example.com");
		expect(field(run.stdout, "verified")).toBe("yes");
		expect(field(run.stdout, "capabilities")).toBe("invoice.review, ñandú.résumé");
		expect(field(run.stdout, "summary")).toBe("Reviews invoices — café ☕ 日本語.");
	});

	it("agx listing get shows a dash for a listing with no summary and no handle", async () => {
		answer("agentIndex/getListing", {
			listing: { ...CLEAN_LISTING, summary: null, handle: null, capabilities: [] },
			verificationEvents: [],
		});

		const run = await agx("listing", "get", "l_7");

		expect(run.code, run.stderr).toBe(0);
		expect(field(run.stdout, "summary")).toBe("—");
		expect(field(run.stdout, "handle")).toBe("—");
		expect(field(run.stdout, "capabilities")).toBe("—");
	});

	it("agx listing create prints every field exactly as sent", async () => {
		answer("agentIndex/createListing", { ...CLEAN_LISTING, source: "team", status: "draft", visibility: "private" });

		const run = await agx("listing", "create", "--team", "t_1", "--slug", "invoice-desk");

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).not.toContain(R);
		expect(run.stdout.split("\n")).toContain("✓ Created listing l_7");
		expect(field(run.stdout, "slug")).toBe("invoice-desk");
		expect(field(run.stdout, "source")).toBe("team");
		expect(field(run.stdout, "capabilities")).toBe("invoice.review, ñandú.résumé");
		expect(run.stdout.split("\n")).toContain("· Listings are born as drafts. Publish it with:  agx listing publish l_7");
	});
});
