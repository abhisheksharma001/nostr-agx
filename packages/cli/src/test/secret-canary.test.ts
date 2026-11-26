import dns from "node:dns";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createServer, Server as HttpServer } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Command, CommanderError } from "commander";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hexToBytes } from "@nostr-agx/nostr";
import { effectiveProfile, updateProfile } from "../lib/config.js";
import { setCredential } from "../lib/credentials.js";
import { saveIdentity } from "../lib/identity.js";
import { redactSecrets, rememberSecret } from "../lib/secrets.js";
import { startGateway } from "../lib/gateway/gateway.js";
import { createGatewayKey } from "../lib/gateway/keys.js";
import { setStdinForTests } from "../lib/stdin.js";
import { buildProgram, reportCliError, runCli } from "../program.js";
import { type RunningRelay, startRelay } from "../relay/server.js";
import {
	blockedReason,
	type CommandNode,
	changedSince,
	type ConnectAttempt,
	FORBIDDEN_PORTS,
	FORM_DESCRIPTION,
	FORMS,
	type Form,
	guardConnections,
	holdsKey,
	listenPortOf,
	mask,
	percentEscapeAll,
	plant,
	type Planted,
	readTree,
	type SlotInfo,
	type TreeListing,
	walkProgram,
	WINDOW,
} from "./canary-kit.js";
import { capture, sandbox } from "./helpers.js";
import { type MockIndexServer, startMockIndexServer } from "./mock-index-server.js";

/**
 * The secret-key canary.
 *
 * A secret key pasted into the wrong place must not come back out: not on the
 * screen, not in a request, not in a file name or a file. This test walks every
 * command, option and positional that `buildProgram()` declares, pastes a
 * throwaway key into each one in every form listed in `canary-kit.ts` (and into
 * the slots that are not options at all: an unknown command, an unknown option,
 * a surplus argument, standard input, the `--profile` name), runs the real
 * program in this process and looks for any 10-character stretch of the key in
 * everything the run left behind. The gateway's HTTP API gets the same
 * treatment, one request per slot (a path, a header, a field of the body).
 *
 * It is a ratchet. `main` still has places that repeat a key, so they are written
 * down in KNOWN_LEAKS, with the reason each is there. The test fails when
 *   - a slot leaks that is not listed (a new leak), or
 *   - a listed slot no longer leaks (remove the entry: it is fixed), or
 *   - a command, option or positional is not in the slot table (classify it).
 * So the list only ever gets shorter, and a fix is done when its entries are gone.
 * INTENDED lists the few slots whose job is to take a secret and keep it.
 *
 * Nothing leaves this machine: a guard refuses every connection that is not to
 * 127.0.0.1 or to a port that is never to be used, the relay is the in-process
 * one and the index is the in-process mock.
 *
 * The whole matrix takes a few minutes. To work on one command, run only it:
 * `CANARY_ONLY=search pnpm exec vitest run src/test/secret-canary.test.ts`
 * (every command whose name starts with the text is run and checked against the lists;
 * several texts go in one value, separated by commas).
 */

// ===================================================================== slot table

/**
 * Four classes of slot, as the plan names them (secret, public key, identifier,
 * free text), plus the identifier-like values that have a shape of their own. A
 * class says what an ordinary, valid value looks like (so the other slots of the
 * command are filled with something that works) and what the slot is for.
 */
type Kind = "secret" | "pubkey" | "id" | "text" | "number" | "duration" | "url" | "relay" | "path" | "json" | "choice";

interface Spec {
	kind: Kind;
	/** A fixed valid value for this slot, when the class's default is not accepted. */
	fill?: string;
	/** A flag that reads the slot's value from standard input instead of the command line. */
	stdin?: true;
	/** Other slots whose value changes what this slot means: the probe is run once for each. */
	vary?: Record<string, string>[];
	/** Flags this slot only does anything with. */
	with?: string[];
	/** A value that is not valid here makes the command wait for ever: stop watching it after a moment. */
	waits?: true;
}

interface CommandEntry {
	slots: Record<string, Kind | Spec>;
	/** Arguments every probe of the command carries so it ends quickly and stays on this machine. */
	base?: string[];
	/** The command starts a server and runs until Ctrl-C: the probe stops it the way Ctrl-C would. */
	listens?: true;
}

const REGISTER_SLOTS: CommandEntry["slots"] = {
	"--slug": { kind: "id", fill: "demo-agent" },
	"--display-name": "text",
	"--org": "id",
	"--capability": "id",
	"--summary": "text",
	"--description": "text",
	"--use-cases": "text",
	"--category": "id",
	"--tag": "id",
	"--runtime": "text",
	"--visibility": "choice",
	"--handle": "id",
	"--domain-id": "id",
};

const CONFIG_KEYS = ["apiKey", "apiBaseUrl", "orgSlug", "relays", "org", "nip05"];

/**
 * Every command, with a class for every slot that takes a value. A flag that takes
 * no value has nothing to paste into and is not listed, except the three flags
 * that read standard input (`stdin: true`). The test fails for a command, option
 * or positional that is missing here, and for an entry that no longer exists.
 */
const SLOT_TABLE: Record<string, CommandEntry> = {
	"(program)": { slots: { "--profile": "id" } },
	login: {
		slots: { "--api-base-url": "url", "--org": "id", "--org-name": "text", "--org-slug": "id" },
		base: ["--no-browser", "--no-wait"],
	},
	logout: { slots: {} },
	whoami: { slots: {} },
	org: { slots: {} },
	"org list": { slots: {} },
	"org create": {
		slots: { "<name>": "text", "--slug": "id", "--api-base-url": "url" },
		base: ["--no-browser", "--no-wait"],
	},
	config: { slots: {} },
	"config show": { slots: {} },
	"config set": {
		slots: {
			"<key>": "id",
			"[value]": { kind: "text", vary: CONFIG_KEYS.map((key) => ({ "<key>": key })) },
			"--stdin": { kind: "secret", stdin: true, vary: CONFIG_KEYS.map((key) => ({ "<key>": key })) },
		},
	},
	"config use": { slots: { "<profile>": "id" } },
	"config list": { slots: {} },
	"config path": { slots: {} },
	identity: { slots: {} },
	"identity new": { slots: {} },
	"identity show": { slots: {} },
	"identity import": { slots: { "[secret]": "secret", "--stdin": { kind: "secret", stdin: true } }, base: ["--force"] },
	"identity export": { slots: {} },
	"identity sign": { slots: { "<nonce>": "text" } },
	"identity allow": { slots: { "[peers...]": "pubkey" } },
	"identity deny": { slots: { "<peers...>": "pubkey" } },
	"identity register": { slots: REGISTER_SLOTS },
	register: { slots: REGISTER_SLOTS },
	listing: { slots: {} },
	"listing create": {
		slots: {
			"--slug": { kind: "id", fill: "demo-agent" },
			"--team": "id",
			"--pubkey": "pubkey",
			"--display-name": "text",
			"--capability": "id",
			"--summary": "text",
			"--description": "text",
			"--category": "id",
			"--tag": "id",
			"--runtime": "text",
			"--visibility": "choice",
			"--handle": "id",
			"--domain-id": "id",
			"--relay": "relay",
			"--org": "id",
		},
	},
	"listing list": { slots: { "--org": "id", "--limit": "number" } },
	"listing get": { slots: { "[listingId]": "id", "--org": "id" } },
	"listing publish": {
		slots: {
			"[listingId]": "id",
			"--org": "id",
			"--visibility": "choice",
			"--timeout": { kind: "duration", with: ["--wait"] },
		},
	},
	"listing set-visibility": { slots: { "<level>": { kind: "choice", fill: "public" }, "[listingId]": "id", "--org": "id" } },
	"listing delist": { slots: { "[listingId]": "id", "--org": "id" } },
	"listing delete": { slots: { "[listingId]": "id", "--org": "id" }, base: ["--yes"] },
	"listing set-policy": {
		slots: { "[listingId]": "id", "--org": "id", "--capability": "id", "--daily-cap": "number" },
		base: ["--auto-allow"],
	},
	domain: { slots: {} },
	"domain add": { slots: { "<domain>": { kind: "id", fill: "example.com" }, "--handle": "id", "--org": "id" } },
	"domain list": { slots: { "--org": "id" } },
	"domain verify": { slots: { "<domainId>": "id", "--timeout": { kind: "duration", with: ["--wait"] }, "--org": "id" } },
	"domain remove": { slots: { "<domainId>": "id", "--org": "id" }, base: ["--yes"] },
	search: {
		slots: {
			"[query]": "text",
			"--org": "id",
			"--capability": "id",
			"--category": "id",
			"--limit": "number",
			"--offset": "number",
		},
	},
	peers: { slots: {} },
	"peers list": { slots: { "--team": "id", "--org": "id" } },
	"peers allowlist": { slots: { "--team": "id", "--npub": "pubkey", "--name": "text", "--org": "id" } },
	"peers accept": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	"peers refuse": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" }, base: ["--reason", "no"] },
	"peers ignore": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	"peers block": { slots: { "--team": "id", "--peer": "id", "--reason": "text", "--org": "id" } },
	serve: {
		slots: {
			"--allow": "pubkey",
			"--capability": "id",
			"--handler": "path",
			"--poll-interval": "number",
			"--max-auto-depth": "number",
			"--reply-text": "text",
		},
		base: ["--once"],
	},
	gateway: {
		slots: { "--host": { kind: "id", fill: "127.0.0.1" }, "--port": { kind: "number", fill: "0" }, "--poll-interval": { kind: "number", fill: "500" } },
		base: ["--port", "0"],
		listens: true,
	},
	"gateway key": { slots: {} },
	"gateway key new": { slots: { "--label": "text" } },
	"gateway key list": { slots: {} },
	"gateway key revoke": { slots: { "<id>": "id" } },
	inbox: { slots: { "--wait": "number", "--thread": "id" }, base: ["--wait", "1"] },
	wait: { slots: { "--timeout": "number" }, base: ["--timeout", "1"] },
	held: { slots: {} },
	"held list": { slots: {} },
	"held allow": { slots: { "<npub>": "pubkey" } },
	"held ignore": { slots: { "<npub>": "pubkey" } },
	"held block": { slots: { "<npub>": "pubkey" } },
	threads: { slots: {} },
	thread: { slots: { "<contextId>": "id" } },
	send: { slots: { "<peer>": "pubkey", "<message>": "text", "--subject": "text", "--context-id": "id" } },
	ui: {
		slots: { "--port": { kind: "number", fill: "0" }, "--compose": "path", "--drafts": "path", "--idle": "number", "--dev-store": "path" },
		base: ["--no-open"],
		listens: true,
	},
	request: {
		slots: { "<peer>": "pubkey", "<capability>": "id", "--payload": "json", "--timeout": { kind: "number", fill: "300", waits: true } },
		base: ["--timeout", "300"],
	},
	card: { slots: { "<peer>": "pubkey", "--relay": "relay" } },
	relay: {
		slots: { "--port": { kind: "number", fill: "0" }, "--tls-port": { kind: "number", fill: "0" } },
		base: ["--port", "0"],
		listens: true,
	},
	tailscale: { slots: {} },
	"tailscale enable": {
		slots: {
			"--auth-key": "secret",
			"--auth-key-stdin": { kind: "secret", stdin: true },
			"--oauth-url": "url",
			"--oauth-client-id": "id",
			"--oauth-client-secret": "secret",
			"--oauth-client-secret-stdin": { kind: "secret", stdin: true },
			"--oauth-scope": "text",
			"--oauth-tailnet": "id",
			"--oauth-token-auth": "choice",
			"--oauth-api-base-url": "url",
			"--tag": "id",
			"--hostname": "id",
			"--state-dir": "path",
		},
		base: ["--no-up"],
	},
	"tailscale up": {
		slots: { "--auth-key": "secret", "--auth-key-stdin": { kind: "secret", stdin: true }, "--hostname": "id", "--state-dir": "path" },
	},
	"tailscale status": { slots: {} },
	"tailscale disable": { slots: {} },
	doctor: { slots: {} },
};

// ====================================================================== the world

/** What every probe shares: an index, a relay and a peer, all on this machine. */
interface World {
	index: MockIndexServer;
	indexKey: string;
	relay: RunningRelay;
	relayUrl: string;
	relayLog: string[];
	peerNpub: string;
	attempts: ConnectAttempt[];
}

let world: World;
let startedIn = "";
let restoreGuard: () => void;

function fillOf(slot: SlotInfo, spec: Spec, home: string): string {
	if (spec.fill !== undefined) {
		return spec.fill;
	}
	switch (spec.kind) {
		case "secret":
			return "throwaway-secret";
		case "pubkey":
			return world.peerNpub;
		case "id":
			return "demo-1";
		case "text":
			return "hello";
		case "number":
			return "1";
		case "duration":
			return "1m";
		case "url":
			return world.index.origin;
		case "relay":
			return "wss://relay.example.com";
		case "path":
			return join(home, "input.json");
		case "json":
			return "{}";
		case "choice":
			return slot.choices?.[0] ?? "x";
	}
}

function specOf(value: Kind | Spec): Spec {
	return typeof value === "string" ? { kind: value } : value;
}

// ==================================================================== the probes

/** What a probe plants a key into. */
type Target =
	| { type: "slot"; slot: SlotInfo; spec: Spec; vary: Record<string, string> | null }
	| { type: "profile" }
	| { type: "unknown-option" }
	| { type: "extra-argument" }
	| { type: "unknown-subcommand" }
	| { type: "unknown-command" }
	| { type: "help-argument" };

interface Plan {
	command: string;
	slot: string;
	node: CommandNode;
	target: Target;
}

function label(target: Target, vary: Record<string, string> | null): string {
	switch (target.type) {
		case "slot": {
			const suffix = vary ? ` (${Object.entries(vary).map(([k, v]) => `${k.replace(/[<>]/g, "")}=${v}`).join(", ")})` : "";
			return `${target.slot.name}${target.spec.stdin ? " (stdin)" : ""}${suffix}`;
		}
		case "profile":
			return "--profile";
		case "unknown-option":
			return "<unknown option>";
		case "extra-argument":
			return "<extra argument>";
		case "unknown-subcommand":
			return "<unknown subcommand>";
		case "unknown-command":
			return "<unknown command>";
		case "help-argument":
			return "<help argument>";
	}
}

/** The command line for a probe, and what is piped in. */
function lineFor(plan: Plan, planted: string, home: string, json: boolean): { args: string[]; stdin: string | null } {
	const entry = SLOT_TABLE[plan.command] as CommandEntry;
	const node = plan.node;
	const target = plan.target;
	const front: string[] = json ? ["--json"] : [];
	if (target.type === "unknown-command") {
		return { args: [...front, planted], stdin: null };
	}
	if (target.type === "help-argument") {
		return { args: [...front, "help", planted], stdin: null };
	}
	if (target.type === "profile") {
		front.push("--profile", planted);
	}
	const slotted = target.type === "slot" ? target.slot : null;
	const arguments_ = node.slots.filter((slot) => slot.kind === "argument");
	const options = node.slots.filter((slot) => slot.kind === "option" && slot.takesValue);
	const plantedIndex = slotted?.kind === "argument" ? arguments_.indexOf(slotted) : -1;
	const vary = target.type === "slot" ? target.vary : null;

	const positional: string[] = [];
	arguments_.forEach((slot, index) => {
		const spec = specOf(entry.slots[slot.name] ?? "text");
		if (slot === slotted) {
			positional.push(planted);
		} else if (vary && slot.name in vary) {
			positional.push(vary[slot.name] as string);
		} else if (slot.required || index < plantedIndex || target.type === "extra-argument") {
			positional.push(fillOf(slot, spec, home));
		}
	});
	if (target.type === "extra-argument") {
		positional.push(planted);
	}

	const optionTokens: string[] = [];
	for (const slot of options) {
		if (slot === slotted) {
			optionTokens.push(slot.name, planted);
		} else if (slot.required) {
			optionTokens.push(slot.name, fillOf(slot, specOf(entry.slots[slot.name] ?? "text"), home));
		}
	}

	// The command's own base arguments, minus any option the probe is planting into.
	const base: string[] = [];
	const known = new Map(node.slots.map((slot) => [slot.name, slot]));
	for (let i = 0; i < (entry.base?.length ?? 0); i++) {
		const token = (entry.base as string[])[i] as string;
		const info = known.get(token);
		if (info && slotted && info.name === slotted.name) {
			i += info.takesValue ? 1 : 0;
			continue;
		}
		base.push(token);
		if (info?.takesValue) {
			base.push((entry.base as string[])[++i] as string);
		}
	}

	const tail: string[] = [];
	let stdin: string | null = null;
	if (target.type === "unknown-option") {
		tail.push(`--${planted}`);
	}
	if (target.type === "slot" && target.spec.stdin) {
		tail.push(target.slot.name);
		stdin = planted;
	}
	if (target.type === "slot" && target.spec.with) {
		tail.push(...target.spec.with);
	}
	if (target.type === "unknown-subcommand") {
		return { args: [...front, ...node.path, planted], stdin: null };
	}
	return { args: [...front, ...node.path, ...positional, ...optionTokens, ...base, ...tail], stdin };
}

// ------------------------------------------------------------- channels and runs

const CHANNELS = [
	"stdout",
	"stderr",
	"json-stdout",
	"json-stderr",
	"request",
	"relay",
	"file-name",
	"file-content",
	"connect",
	"response",
	"log",
] as const;
type Channel = (typeof CHANNELS)[number];

interface Observed {
	code: number | null;
	threw: string | null;
	/** The command was still waiting when watching stopped (only for a slot marked `waits`). */
	abandoned: boolean;
	/** Channels in which a stretch of the key was found. */
	channels: Set<Channel>;
	millis: number;
	/** What the guard stopped on a forbidden port. */
	forbidden: ConnectAttempt[];
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Handler = (...args: unknown[]) => unknown;

function signalHandlers(): Map<string, Handler[]> {
	return new Map(SIGNALS.map((signal) => [signal, process.listeners(signal) as Handler[]]));
}

/** The signal handlers a run added, in order. */
function addedHandlers(before: Map<string, Handler[]>): Array<[string, Handler]> {
	const added: Array<[string, Handler]> = [];
	for (const signal of SIGNALS) {
		const known = new Set(before.get(signal));
		for (const handler of process.listeners(signal) as Handler[]) {
			if (!known.has(handler)) {
				added.push([signal, handler]);
			}
		}
	}
	return added;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Finished = { code: number } | { error: string };

/**
 * Run the program. A command that serves (`listens`) is stopped the way Ctrl-C
 * stops it: through the signal handlers it registered, once it is up. Nothing is
 * signalled for real, and `process.exit` is recorded, never carried out.
 */
async function drive(run: Promise<number>, listens: boolean, before: Map<string, Handler[]>, exits: number[]): Promise<Finished | null> {
	let finished: Finished | null = null;
	void run.then(
		(code) => {
			finished = { code };
		},
		(error: unknown) => {
			finished = { error: error instanceof Error ? error.message : String(error) };
		},
	);
	if (listens) {
		const deadline = Date.now() + 15_000;
		while (finished === null && addedHandlers(before).length === 0 && Date.now() < deadline) {
			await pause(5);
		}
		await pause(40);
		const handlers = addedHandlers(before);
		for (const [, handler] of handlers) {
			await Promise.resolve(handler());
		}
		const stopBy = Date.now() + 5_000;
		while (finished === null && exits.length === 0 && Date.now() < stopBy) {
			await pause(5);
		}
	} else {
		await run.catch(() => undefined);
	}
	return finished;
}

/** One run of `args` in a fresh home; looks for `planted` everywhere it could have gone. */
async function runOnce(
	lineFor: (home: string) => { args: string[]; stdin: string | null },
	planted: Planted,
	json: boolean,
	options: { listens?: boolean; waits?: boolean; keeps?: boolean; run?: (args: string[]) => Promise<number> } = {},
): Promise<Observed> {
	const run = options.run ?? runCli;
	const started = performance.now();
	const box = sandbox();
	homesMade.push(box.home);
	const cwd = process.cwd();
	const { args, stdin } = lineFor(box.home);
	const restoreStdin = setStdinForTests(stdin);
	const requestsBefore = world.index.requests.length;
	const relayBefore = world.relayLog.length;
	const attemptsBefore = world.attempts.length;
	try {
		// A relative path a command is given lands in the throwaway home, not in the repository.
		process.chdir(box.home);
		saveIdentity("default", planted.identity);
		updateProfile("default", { apiBaseUrl: world.index.origin, orgSlug: "acme", relays: [world.relayUrl] });
		setCredential("default", {
			apiBaseUrl: world.index.origin,
			apiKey: world.indexKey,
			apiKeyId: null,
			source: "manual",
			clientId: null,
			organization: null,
			user: null,
			scopes: null,
			expiresAt: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		process.env.AGX_API_URL = world.index.origin;
		process.env.AGX_RELAY = world.relayUrl;
		world.relay.clear();
		// The stock profile's relay is ws://127.0.0.1:7447, somebody's own. Every profile a command can name must resolve to the throwaway relay.
		const named = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : undefined;
		for (const name of new Set(["default", ...(named ? [named] : [])])) {
			let relays: string[] = [];
			try {
				relays = effectiveProfile(name).relays;
			} catch {
				continue; // a name that is not a profile name: the command refuses it before it can connect
			}
			if (relays.length !== 1 || relays[0] !== world.relayUrl) {
				throw new Error(`the throwaway home does not pin the relay for profile "${name.length > 24 ? mask(name) : name}": ${relays.join(", ")}`);
			}
		}

		let code: number | null = null;
		let threw: string | null = null;
		const exits: number[] = [];
		const before = signalHandlers();
		// Timers a command starts and never stops (a lock heartbeat, say) must not outlive its run.
		const intervals: NodeJS.Timeout[] = [];
		const startInterval = globalThis.setInterval;
		const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
			const handle = startInterval(...args);
			intervals.push(handle);
			return handle;
		}) as typeof setInterval);
		let abandoned = false;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((exitCode?: number) => {
			exits.push(exitCode ?? 0);
			return undefined as never;
		}) as never);
		const { stdout, stderr } = await capture(async () => {
			try {
				const finished = await withDeadline(drive(run(args), options.listens === true, before, exits), options.waits ? WAITS_MS : 30_000, args);
				if (finished && "code" in finished) {
					code = finished.code;
				} else if (finished) {
					threw = finished.error;
				}
			} catch (error) {
				if (options.waits && error instanceof Stuck) {
					abandoned = true;
				} else {
					threw = error instanceof Error ? error.message : String(error);
				}
			}
			return null;
		});
		exitSpy.mockRestore();
		intervalSpy.mockRestore();
		for (const handle of intervals) {
			clearInterval(handle);
		}
		for (const [signal, handler] of addedHandlers(before)) {
			process.removeListener(signal, handler);
		}
		if (exits.some((exitCode) => exitCode !== 0)) {
			threw ??= `process.exit(${exits.join(",")}) was called`;
		}

		const own = planted.form === "hex" || planted.form === "HEX";
		// The redactor only knows what a command told it to remember. A stranger's key in there would hide leaks from this test.
		// (`config set apiKey` hands its value to the redactor on purpose: that is what an API key is for.)
		if (!own && !options.keeps && redactSecrets(planted.value) !== planted.value) {
			threw ??= "the program remembered the planted key for redaction";
		}
		const tree = readTree(box.home, own ? new Set(["profiles/default/identity.json"]) : new Set());
		const requests = world.index.requests
			.slice(requestsBefore)
			.map((r) => `${r.method} ${r.path}\n${JSON.stringify(r.headers)}\n${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`)
			.join("\n");
		const attempts = world.attempts.slice(attemptsBefore);
		const texts: Record<Channel, string> = {
			stdout: json ? "" : stdout,
			stderr: json ? "" : stderr,
			"json-stdout": json ? stdout : "",
			"json-stderr": json ? stderr : "",
			request: requests,
			relay: world.relayLog.slice(relayBefore).join("\n"),
			"file-name": tree.names,
			"file-content": tree.contents,
			connect: attempts.map((a) => `${a.host}:${a.port}`).join("\n"),
			response: "",
			log: "",
		};
		const channels = new Set<Channel>();
		for (const channel of CHANNELS) {
			if (holdsKey(texts[channel], planted.needles)) {
				channels.add(channel);
			}
		}
		return { code, threw, abandoned, channels, millis: performance.now() - started, forbidden: attempts.filter((a) => a.blocked === "port") };
	} finally {
		restoreStdin();
		process.chdir(cwd);
		box.restore();
	}
}

/** Every throwaway home a run made: all must be gone when the matrix is done. */
const homesMade: string[] = [];

const WAITS_MS = 1_500;

class Stuck extends Error {}

/** A run that never ends is a failure of the harness, not a result: say which line stuck. */
async function withDeadline<T>(promise: Promise<T>, ms: number, args: string[]): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Stuck(`the command did not finish in ${ms} ms: agx ${args.map((a) => (a.length > 24 ? mask(a) : a)).join(" ")}`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------- the matrix plans

function plansFor(nodes: CommandNode[]): Plan[] {
	const plans: Plan[] = [];
	for (const node of nodes) {
		const entry = SLOT_TABLE[node.label];
		if (!entry) {
			continue;
		}
		const isProgram = node.path.length === 0;
		const runnable = !isProgram && (!node.hasSubcommands || node.slots.some((slot) => slot.takesValue));
		const add = (target: Target, vary: Record<string, string> | null = null): void => {
			plans.push({ command: node.label, slot: label(target, vary), node, target });
		};
		if (isProgram) {
			add({ type: "unknown-command" });
			add({ type: "help-argument" });
			continue;
		}
		for (const slot of node.slots) {
			const raw = entry.slots[slot.name];
			if (raw === undefined || (!slot.takesValue && !specOf(raw).stdin)) {
				continue;
			}
			const spec = specOf(raw);
			for (const vary of spec.vary ?? [null]) {
				add({ type: "slot", slot, spec, vary }, vary);
			}
		}
		if (runnable) {
			add({ type: "profile" });
		}
		add({ type: "unknown-option" });
		if (node.hasSubcommands) {
			add({ type: "unknown-subcommand" });
		} else if (!node.slots.some((slot) => slot.kind === "argument" && slot.variadic)) {
			add({ type: "extra-argument" });
		}
	}
	return plans;
}

// ====================================================================== the checks

/** Slots and commands that are in the program but not in the table, or the other way round. */
function unclassified(nodes: CommandNode[]): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		seen.add(node.label);
		const entry = SLOT_TABLE[node.label];
		if (!entry) {
			problems.push(`command "${node.label}" is not in SLOT_TABLE`);
			continue;
		}
		const names = new Set(node.slots.map((slot) => slot.name));
		for (const slot of node.slots) {
			const raw = entry.slots[slot.name];
			if (slot.takesValue && raw === undefined) {
				problems.push(`"${node.label}" ${slot.name} takes a value and has no class in SLOT_TABLE`);
			}
			if (!slot.takesValue && raw !== undefined && !specOf(raw).stdin) {
				problems.push(`"${node.label}" ${slot.name} takes no value; list it only with stdin: true if it reads standard input`);
			}
		}
		for (const name of Object.keys(entry.slots)) {
			if (!names.has(name)) {
				problems.push(`SLOT_TABLE lists "${node.label}" ${name}, which the program no longer has`);
			}
		}
	}
	for (const label of Object.keys(SLOT_TABLE)) {
		if (!seen.has(label)) {
			problems.push(`SLOT_TABLE lists command "${label}", which the program no longer has`);
		}
	}
	return problems;
}

// ================================================================= the matrix run

interface Leak {
	command: string;
	slot: string;
	form: Form;
	channel: Channel;
}

interface MatrixResult {
	leaks: Leak[];
	probes: number;
	runs: number;
	millis: number;
	threw: string[];
	forbidden: string[];
	slow: Array<{ line: string; millis: number }>;
	slots: number;
	commands: number;
}

// ================================================== the gateway's HTTP API

/**
 * `agx gateway` answers HTTP requests for n8n and other tools. Each probe is one
 * request with the key in one place (a path, a header, a field of the body); what
 * is watched is the answer, the lines the gateway logs, the relay, and the files
 * it changes. One gateway is started per key form, as the profile whose own key
 * the hex forms are.
 */
const GATEWAY_API = "gateway (HTTP API)";
const AFTER_STOP = "<saved when the gateway stops>";

interface HttpRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	body?: string;
}

interface HttpProbe {
	slot: string;
	send: (value: string, peer: string) => HttpRequest;
}

const asJson = (value: unknown): string => JSON.stringify(value);
const here = (value: string): string => encodeURIComponent(value);

const HTTP_PROBES: HttpProbe[] = [
	{ slot: "POST /v1/tasks peer", send: (v) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer: v, capability: "demo.run", timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks capability", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer, capability: v, timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks payload", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", body: asJson({ peer, capability: "demo.run", payload: { note: v }, timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks Idempotency-Key", send: (v, peer) => ({ method: "POST", path: "/v1/tasks", headers: { "idempotency-key": v }, body: asJson({ peer, capability: "demo.run", timeoutSec: 1 }) }) },
	{ slot: "POST /v1/tasks (body)", send: (v) => ({ method: "POST", path: "/v1/tasks", body: v }) },
	{ slot: "GET /v1/tasks/:id", send: (v) => ({ method: "GET", path: `/v1/tasks/${here(v)}` }) },
	{ slot: "POST /v1/messages peer", send: (v) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer: v, text: "hello" }) }) },
	{ slot: "POST /v1/messages text", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: v }) }) },
	{ slot: "POST /v1/messages subject", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: "hello", subject: v }) }) },
	{ slot: "POST /v1/messages contextId", send: (v, peer) => ({ method: "POST", path: "/v1/messages", body: asJson({ peer, text: "hello", contextId: v }) }) },
	{ slot: "GET /v1/agents/:peer", send: (v) => ({ method: "GET", path: `/v1/agents/${here(v)}` }) },
	{ slot: "GET /v1/agents/:peer ?capability", send: (v, peer) => ({ method: "GET", path: `/v1/agents/${peer}?verifyNip05=false&capability=${here(v)}` }) },
	{ slot: "POST /v1/subscriptions url", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: v, events: ["message"], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions label", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", label: v, events: ["message"], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions capabilities", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: ["task"], capabilities: [v], acceptAll: true }) }) },
	{ slot: "POST /v1/subscriptions allowedPeers", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: ["message"], allowedPeers: [v] }) }) },
	{ slot: "POST /v1/subscriptions events", send: (v) => ({ method: "POST", path: "/v1/subscriptions", body: asJson({ url: "http://127.0.0.1:9/hook", events: [v], acceptAll: true }) }) },
	{ slot: "GET /v1/subscriptions/:id", send: (v) => ({ method: "GET", path: `/v1/subscriptions/${here(v)}` }) },
	{ slot: "DELETE /v1/subscriptions/:id", send: (v) => ({ method: "DELETE", path: `/v1/subscriptions/${here(v)}` }) },
	{ slot: "<unknown path> under /v1", send: (v) => ({ method: "GET", path: `/v1/${here(v)}` }) },
	{ slot: "<unknown path>", send: (v) => ({ method: "GET", path: `/${here(v)}` }) },
	{ slot: "Authorization", send: (v) => ({ method: "GET", path: "/v1/identity", headers: { authorization: `Bearer ${v}` } }) },
];

/** What one HTTP probe is watched against: where to send it, what the gateway logged, and the files before it. */
interface HttpWatch {
	url: string;
	key: string;
	home: string;
	lines: string[];
	skip: ReadonlySet<string>;
	tree: TreeListing;
}

/** Send one probe and say in which channels `value` came back; the watch moves on to the state after it. */
async function sendProbe(watch: HttpWatch, probe: HttpProbe, value: Planted): Promise<{ channels: Set<Channel>; error: string | null }> {
	const linesBefore = watch.lines.length;
	const relayBefore = world.relayLog.length;
	const attemptsBefore = world.attempts.length;
	const request = probe.send(value.value, world.peerNpub);
	let response = "";
	let error: string | null = null;
	try {
		response = await withDeadline(
			fetch(`${watch.url}${request.path}`, {
				method: request.method,
				headers: { authorization: `Bearer ${watch.key}`, "content-type": "application/json", ...request.headers },
				body: request.body,
			}).then(async (res) => `${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${await res.text()}`),
			30_000,
			[request.method, request.path],
		);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	const after = readTree(watch.home, watch.skip);
	const changed = changedSince(watch.tree, after);
	watch.tree = after;
	const texts: Partial<Record<Channel, string>> = {
		response,
		log: watch.lines.slice(linesBefore).join("\n"),
		relay: world.relayLog.slice(relayBefore).join("\n"),
		"file-name": changed.names,
		"file-content": changed.contents,
		connect: world.attempts.slice(attemptsBefore).map((a) => `${a.host}:${a.port}`).join("\n"),
	};
	const channels = new Set<Channel>();
	for (const [channel, text] of Object.entries(texts) as Array<[Channel, string]>) {
		if (holdsKey(text, value.needles)) {
			channels.add(channel);
		}
	}
	return { channels, error };
}

async function runGatewayMatrix(result: MatrixResult): Promise<void> {
	for (const form of FORMS) {
		const fixed = plant(form, "http");
		const hexForm = form === "hex" || form === "HEX";
		const skip: ReadonlySet<string> = hexForm ? new Set(["profiles/default/identity.json"]) : new Set();
		const box = sandbox();
		const planted = new Map<string, Planted>();
		const found = new Map<string, Set<Channel>>();
		const note = (slot: string, channel: Channel): void => {
			const channels = found.get(slot) ?? new Set<Channel>();
			channels.add(channel);
			found.set(slot, channels);
		};
		let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
		try {
			saveIdentity("default", fixed.identity);
			updateProfile("default", { relays: [world.relayUrl] });
			const lines: string[] = [];
			const key = createGatewayKey("default", "canary").key;
			gateway = await startKeepingConnections(() => startGateway({ profile: "default", port: 0, pollIntervalMs: 200, log: (line) => lines.push(line) }));
			const watch: HttpWatch = { url: gateway.url, key, home: box.home, lines, skip, tree: readTree(box.home, skip) };
			for (const probe of HTTP_PROBES) {
				// A new key for every request, so a file that holds it can be traced to the request; the profile's own key is one value.
				const value = hexForm ? fixed : plant(form, `http|${probe.slot}`);
				planted.set(probe.slot, value);
				const sent = await sendProbe(watch, probe, value);
				if (sent.error) {
					result.threw.push(`${GATEWAY_API} | ${probe.slot} | ${form}: ${sent.error}`);
				}
				for (const channel of sent.channels) {
					note(probe.slot, channel);
				}
				result.runs += 1;
			}
			await gateway.close();
			gateway = null;
			// What an earlier request left that only shows once the gateway has saved its state.
			const last = readTree(box.home, skip);
			const owners: Array<[string, Planted]> = hexForm ? [[AFTER_STOP, fixed]] : [...planted.entries()];
			for (const [slot, value] of owners) {
				if (holdsKey(last.names, value.needles)) {
					note(slot, "file-name");
				}
				if (holdsKey(last.contents, value.needles)) {
					note(slot, "file-content");
				}
			}
		} finally {
			await gateway?.close().catch(() => undefined);
			box.restore();
		}
		for (const [slot, channels] of found) {
			for (const channel of channels) {
				result.leaks.push({ command: GATEWAY_API, slot, form, channel });
			}
		}
		result.probes += HTTP_PROBES.length;
	}
}

let matrix: Promise<MatrixResult> | null = null;

function runMatrix(): Promise<MatrixResult> {
	matrix ??= (async () => {
		const started = performance.now();
		const nodes = walkProgram(buildProgram());
		const plans = plansFor(nodes).filter((plan) => inScopeName(plan.command));
		const result: MatrixResult = { leaks: [], probes: 0, runs: 0, millis: 0, threw: [], forbidden: [], slow: [], slots: 0, commands: nodes.length };
		const slotKeys = new Set<string>();
		for (const plan of plans) {
			slotKeys.add(`${plan.command}|${plan.slot}`);
			for (const form of FORMS) {
				const planted = plant(form, `${plan.command}|${plan.slot}`);
				result.probes += 1;
				const found = new Map<Channel, true>();
				for (const json of [false, true]) {
					const observed = await runOnce((home) => lineFor(plan, planted.value, home, json), planted, json, {
						listens: SLOT_TABLE[plan.command]?.listens === true,
						waits: plan.target.type === "slot" && plan.target.spec.waits === true,
						keeps: plan.command === "config set" && plan.target.type === "slot" && plan.target.vary?.["<key>"] === "apiKey",
					});
					result.runs += 1;
					if (observed.threw) {
						result.threw.push(`${plan.command} | ${plan.slot} | ${form}: ${observed.threw}`);
					}
					for (const attempt of observed.forbidden) {
						result.forbidden.push(`${plan.command} | ${plan.slot} | ${form}: ${attempt.host}:${attempt.port}`);
					}
					if (observed.millis > 2000) {
						result.slow.push({ line: `${plan.command} | ${plan.slot} | ${form}`, millis: Math.round(observed.millis) });
					}
					for (const channel of observed.channels) {
						found.set(channel, true);
					}
				}
				for (const channel of found.keys()) {
					result.leaks.push({ command: plan.command, slot: plan.slot, form, channel });
				}
			}
		}
		if (inScopeName(GATEWAY_API)) {
			await runGatewayMatrix(result);
			for (const probe of HTTP_PROBES) {
				slotKeys.add(`${GATEWAY_API}|${probe.slot}`);
			}
		}
		result.slots = slotKeys.size;
		result.millis = performance.now() - started;
		return result;
	})();
	return matrix;
}

/**
 * Starts a server that never closes an idle connection by itself. Node closes one
 * after 5 seconds; a client that reuses it just then gets a reset, and a run that
 * pauses between two requests to the mock would fail by chance.
 */
async function startKeepingConnections<T>(start: () => Promise<T>): Promise<T> {
	const inherited = HttpServer.prototype.listen as (this: HttpServer, ...args: unknown[]) => HttpServer;
	const own = HttpServer.prototype as unknown as { listen?: unknown };
	own.listen = function (this: HttpServer, ...args: unknown[]): HttpServer {
		this.keepAliveTimeout = 0;
		return inherited.apply(this, args);
	};
	try {
		return await start();
	} finally {
		delete own.listen;
	}
}

beforeAll(async () => {
	startedIn = process.cwd();
	const guard = guardConnections();
	restoreGuard = guard.restore;
	const relayLog: string[] = [];
	const relay = await startKeepingConnections(() =>
		startRelay({
			port: 0,
			onEvent: (event) => relayLog.push(`EVENT ${JSON.stringify(event)}`),
			onRequest: (filters) => relayLog.push(`REQ ${JSON.stringify(filters)}`),
		}),
	);
	expect(FORBIDDEN_PORTS.has(relay.port)).toBe(false);
	const index = await startKeepingConnections(() => startMockIndexServer());
	index.setRpc("agentIndex/searchListings", () => ({ output: { listings: [], total: 0 } }));
	index.setRpc("agentIndex/listDomains", () => ({ output: { domains: [] } }));
	index.setRpc("exchange/listPeers", () => ({ output: { peers: [] } }));
	world = {
		index,
		indexKey: index.addKey().key,
		relay,
		relayUrl: `ws://127.0.0.1:${relay.port}`,
		relayLog,
		peerNpub: plant("nsec", "peer").identity.npub,
		attempts: guard.attempts,
	};
}, 30_000);

afterAll(async () => {
	restoreGuard?.();
	await world?.relay.close();
	await world?.index.close();
});

// ============================================================= the known leaks

type Channels = readonly Channel[];

/**
 * One reviewable line of what leaks today. An entry names a set of slots and what
 * leaks there: every combination of command, slot, key form and channel it spells
 * out is expected to leak, and nothing else. The test fails for a leak that is
 * not covered here, and for a listed combination that no longer leaks.
 */
interface KnownLeak {
	/** The commands (as typed after `agx`), or "*" for every command that has all of `slots`. */
	commands: readonly string[] | "*";
	slots: readonly string[];
	forms: readonly Form[] | "*";
	channels: Channels;
	/** The open pull request that fixes it, or why it is not fixed. */
	reason: string;
}

const ALL = "*" as const;

const WHY = {
	pr61: "open PR #61 hides a hex run of 56 or more digits in an unknown command or option",
	tooMany: "the parser's 'too many arguments' quotes every extra word (issue #57; PR #61 leaves it on purpose)",
	parserEscaped: "a parser error quotes a %xx-escaped key as typed; no check decodes %xx yet",
	pr64_66: "open PRs #64 and #66 refuse a profile name that holds nsec1 or ncryptsec1",
	profileName: "a hex or %xx-escaped profile name is a valid folder name; no rule yet says what a profile name may hold",
	pr65: "open PR #65 refuses a value that holds nsec1 or ncryptsec1",
	pr75: "open PR #75 refuses and hides a value that holds a key, also %xx-escaped",
	messageText: "open decision: should message text and subjects stop for a key (the UI asks first)?",
	afterStop: "a task keeps its agent as typed in the task file; the profile's own key as hex is a valid public key",
	sendDecision: "open decision: should `agx send` refuse a key in the message, subject or context id?",
	ownHex: "the profile's own key as 64 hex characters has no nsec1 shape; only matching its exact value, or knowing what the slot may hold, can tell",
	escaped: "a key written as %xx escapes does not match the nsec1 shape check; a matcher that decodes %xx would catch it",
	unchecked: "no open PR covers this slot yet",
} as const;

/** Slots whose job is to take a secret and keep it: the value is expected in a file or a request. */
const INTENDED: readonly KnownLeak[] = [
	{ commands: ["tailscale enable"], slots: ["--auth-key", "--auth-key-stdin (stdin)", "--oauth-client-secret", "--oauth-client-secret-stdin (stdin)"], forms: "*", channels: ["file-content"], reason: "a Tailscale secret is kept in tailscale.json" },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=apiKey)", "[value] (key=apiKey)"], forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr", "escaped"], channels: ["file-content", "request"], reason: "config set apiKey keeps the API key and sends it to the index as the bearer" },
	{ commands: ["identity import"], slots: ["--stdin (stdin)", "[secret]"], forms: ["nsec", "nostr"], channels: ["file-content"], reason: "identity import keeps the key it is given, in identity.json" },
];

/** What `main` still repeats, writes or sends. Each fix deletes its lines. */
const KNOWN_LEAKS: readonly KnownLeak[] = [
	{ commands: ["gateway (HTTP API)"], slots: ["<saved when the gateway stops>"], forms: ["hex", "HEX"], channels: ["file-content"], reason: WHY.afterStop },
	{ commands: ["serve"], slots: ["--allow", "--handler"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: "*", slots: ["--api-base-url"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["search"], slots: ["--capability", "--category", "[query]"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["serve"], slots: ["--capability"], forms: ["escaped"], channels: ["stdout"], reason: WHY.escaped },
	{ commands: ["ui"], slots: ["--compose", "--idle"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["domain add"], slots: ["--handle"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["gateway"], slots: ["--host"], forms: ["escaped"], channels: ["connect", "json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["tailscale enable"], slots: ["--hostname", "--state-dir"], forms: ["escaped"], channels: ["file-content", "stdout"], reason: WHY.escaped },
	{ commands: ["gateway key new"], slots: ["--label"], forms: ["escaped"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.escaped },
	{ commands: ["peers allowlist"], slots: ["--name", "--npub"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["tailscale enable"], slots: ["--oauth-api-base-url", "--oauth-client-id", "--oauth-scope", "--oauth-tailnet", "--oauth-url", "--tag"], forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ commands: ["tailscale enable"], slots: ["--oauth-token-auth"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["domain add", "domain remove", "domain verify", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse"], slots: ["--org"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["domain list", "identity register", "listing list", "register", "search"], slots: ["--org"], forms: ["escaped"], channels: ["request", "stdout"], reason: WHY.escaped },
	{ commands: ["login"], slots: ["--org"], forms: ["escaped"], channels: ["file-content", "request"], reason: WHY.escaped },
	{ commands: "*", slots: ["--peer", "--reason"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["gateway", "ui"], slots: ["--port"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["listing create"], slots: ["--pubkey"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["card"], slots: ["--relay"], forms: ["escaped"], channels: ["connect", "json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["org create"], slots: ["--slug", "<name>"], forms: ["escaped"], channels: ["file-content", "request"], reason: WHY.escaped },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=apiBaseUrl)", "<key>", "[value] (key=apiBaseUrl)"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=nip05)", "--stdin (stdin) (key=org)", "--stdin (stdin) (key=orgSlug)", "--stdin (stdin) (key=relays)", "[value] (key=nip05)", "[value] (key=org)", "[value] (key=orgSlug)", "[value] (key=relays)"], forms: ["escaped"], channels: ["file-content"], reason: WHY.escaped },
	{ commands: ["listing create", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers refuse"], slots: ["--team"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["peers list"], slots: ["--team"], forms: ["escaped"], channels: ["request", "stdout"], reason: WHY.escaped },
	{ commands: ["domain verify", "wait"], slots: ["--timeout"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: "*", slots: ["--visibility"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["inbox"], slots: ["--wait"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["request"], slots: ["<capability>"], forms: ["escaped"], channels: ["json-stdout", "stdout"], reason: WHY.escaped },
	{ commands: ["thread"], slots: ["<contextId>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["domain add"], slots: ["<domain>"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: "*", slots: ["<domainId>"], forms: ["escaped"], channels: ["request"], reason: WHY.escaped },
	{ commands: ["gateway key revoke"], slots: ["<id>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["identity sign"], slots: ["<nonce>"], forms: ["escaped"], channels: ["json-stdout", "stdout"], reason: WHY.escaped },
	{ commands: "*", slots: ["<npub>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: "*", slots: ["<peer>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["identity deny"], slots: ["<peers...>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: "*", slots: ["[listingId]"], forms: ["escaped"], channels: ["file-content", "request"], reason: WHY.escaped },
	{ commands: ["identity allow"], slots: ["[peers...]"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.escaped },
	{ commands: ["gateway (HTTP API)"], slots: ["POST /v1/messages subject", "POST /v1/messages text"], forms: ["nsec", "ncryptsec", "nostr", "escaped", "sentence"], channels: ["file-content"], reason: WHY.messageText },
	{ commands: "*", slots: ["--api-base-url"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["search"], slots: ["--capability", "--category", "[query]"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["serve"], slots: ["--capability"], forms: ["hex", "HEX"], channels: ["stdout"], reason: WHY.ownHex },
	{ commands: ["ui"], slots: ["--compose", "--idle"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["domain add"], slots: ["--handle"], forms: ["HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["serve"], slots: ["--handler"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["gateway"], slots: ["--host"], forms: ["hex", "HEX"], channels: ["connect", "json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["tailscale enable"], slots: ["--hostname", "--state-dir"], forms: ["hex", "HEX"], channels: ["file-content", "stdout"], reason: WHY.ownHex },
	{ commands: ["gateway key new"], slots: ["--label"], forms: ["hex", "HEX"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.ownHex },
	{ commands: ["peers allowlist"], slots: ["--name", "--npub"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["tailscale enable"], slots: ["--oauth-api-base-url", "--oauth-client-id", "--oauth-scope", "--oauth-tailnet", "--oauth-url", "--tag"], forms: ["hex", "HEX"], channels: ["file-content"], reason: WHY.ownHex },
	{ commands: ["tailscale enable"], slots: ["--oauth-token-auth"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["domain add", "domain remove", "domain verify", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse"], slots: ["--org"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["domain list", "identity register", "listing list", "register", "search"], slots: ["--org"], forms: ["hex", "HEX"], channels: ["request", "stdout"], reason: WHY.ownHex },
	{ commands: ["login"], slots: ["--org"], forms: ["hex", "HEX"], channels: ["file-content", "request"], reason: WHY.ownHex },
	{ commands: ["request"], slots: ["--payload"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: "*", slots: ["--peer", "--reason"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["gateway", "ui"], slots: ["--port"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["listing create"], slots: ["--pubkey"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["card"], slots: ["--relay"], forms: ["hex", "HEX"], channels: ["connect", "json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["org create"], slots: ["--slug", "<name>"], forms: ["hex", "HEX"], channels: ["file-content", "request"], reason: WHY.ownHex },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=apiBaseUrl)", "<key>", "[value] (key=apiBaseUrl)"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=nip05)", "--stdin (stdin) (key=org)", "--stdin (stdin) (key=orgSlug)", "--stdin (stdin) (key=relays)", "[value] (key=nip05)", "[value] (key=org)", "[value] (key=orgSlug)", "[value] (key=relays)"], forms: ["hex", "HEX"], channels: ["file-content"], reason: WHY.ownHex },
	{ commands: ["listing create", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers refuse"], slots: ["--team"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["peers list"], slots: ["--team"], forms: ["hex", "HEX"], channels: ["request", "stdout"], reason: WHY.ownHex },
	{ commands: ["domain verify", "wait"], slots: ["--timeout"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: "*", slots: ["--visibility"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["inbox"], slots: ["--wait"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["request"], slots: ["<capability>"], forms: ["hex", "HEX"], channels: ["json-stdout", "stdout"], reason: WHY.ownHex },
	{ commands: ["thread"], slots: ["<contextId>"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["domain add"], slots: ["<domain>"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: "*", slots: ["<domainId>"], forms: ["hex", "HEX"], channels: ["request"], reason: WHY.ownHex },
	{ commands: ["gateway key revoke"], slots: ["<id>"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.ownHex },
	{ commands: ["identity sign"], slots: ["<nonce>"], forms: ["hex", "HEX"], channels: ["json-stdout", "stdout"], reason: WHY.ownHex },
	{ commands: "*", slots: ["<npub>"], forms: ["hex", "HEX"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.ownHex },
	{ commands: ["card"], slots: ["<peer>"], forms: ["hex", "HEX"], channels: ["json-stderr", "relay", "stderr"], reason: WHY.ownHex },
	{ commands: ["request"], slots: ["<peer>"], forms: ["hex", "HEX"], channels: ["json-stderr", "relay", "stderr", "stdout"], reason: WHY.ownHex },
	{ commands: ["send"], slots: ["<peer>"], forms: ["hex", "HEX"], channels: ["file-content", "json-stdout", "relay", "stdout"], reason: WHY.ownHex },
	{ commands: ["identity deny"], slots: ["<peers...>"], forms: ["hex", "HEX"], channels: ["stdout"], reason: WHY.ownHex },
	{ commands: ["gateway (HTTP API)"], slots: ["<unknown path>", "<unknown path> under /v1", "DELETE /v1/subscriptions/:id", "GET /v1/agents/:peer ?capability", "GET /v1/subscriptions/:id", "POST /v1/messages contextId", "POST /v1/subscriptions allowedPeers", "POST /v1/subscriptions capabilities", "POST /v1/subscriptions label", "POST /v1/subscriptions url"], forms: ["hex", "HEX"], channels: ["response"], reason: WHY.ownHex },
	{ commands: ["gateway (HTTP API)"], slots: ["GET /v1/agents/:peer", "POST /v1/messages peer", "POST /v1/tasks capability", "POST /v1/tasks peer"], forms: ["hex", "HEX"], channels: ["relay", "response"], reason: WHY.ownHex },
	{ commands: "*", slots: ["[listingId]"], forms: ["hex", "HEX"], channels: ["file-content", "request"], reason: WHY.ownHex },
	{ commands: ["identity allow"], slots: ["[peers...]"], forms: ["hex", "HEX"], channels: ["file-content", "stdout"], reason: WHY.ownHex },
	{ commands: ["(program)"], slots: ["<unknown command>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.parserEscaped },
	{ commands: ["card", "config", "config list", "config path", "config set", "config show", "config use", "doctor", "domain", "domain add", "domain list", "domain remove", "domain verify", "gateway", "gateway key", "gateway key list", "gateway key new", "gateway key revoke", "held", "held allow", "held block", "held ignore", "held list", "identity", "identity allow", "identity deny", "identity export", "identity new", "identity register", "identity show", "identity sign", "inbox", "listing", "listing create", "listing delete", "listing delist", "listing get", "listing list", "listing publish", "listing set-policy", "listing set-visibility", "login", "logout", "org", "org create", "org list", "peers", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse", "register", "relay", "request", "search", "send", "serve", "tailscale", "tailscale disable", "tailscale enable", "tailscale status", "tailscale up", "thread", "threads", "ui", "wait", "whoami"], slots: ["<unknown option>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.parserEscaped },
	{ commands: "*", slots: ["<unknown subcommand>"], forms: ["escaped"], channels: ["json-stderr", "stderr"], reason: WHY.parserEscaped },
	{ commands: ["(program)"], slots: ["<unknown command>"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.pr61 },
	{ commands: ["card", "config", "config list", "config path", "config set", "config show", "config use", "doctor", "domain", "domain add", "domain list", "domain remove", "domain verify", "gateway", "gateway key", "gateway key list", "gateway key new", "gateway key revoke", "held", "held allow", "held block", "held ignore", "held list", "identity", "identity allow", "identity deny", "identity export", "identity new", "identity register", "identity show", "identity sign", "inbox", "listing", "listing create", "listing delete", "listing delist", "listing get", "listing list", "listing publish", "listing set-policy", "listing set-visibility", "login", "logout", "org", "org create", "org list", "peers", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse", "register", "relay", "request", "search", "send", "serve", "tailscale", "tailscale disable", "tailscale enable", "tailscale status", "tailscale up", "thread", "threads", "ui", "wait", "whoami"], slots: ["<unknown option>"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.pr61 },
	{ commands: "*", slots: ["<unknown subcommand>"], forms: ["hex", "HEX"], channels: ["json-stderr", "stderr"], reason: WHY.pr61 },
	{ commands: ["config show", "doctor", "logout", "tailscale status"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stdout", "stdout"], reason: WHY.pr64_66 },
	{ commands: ["domain add", "domain list", "domain remove", "domain verify", "gateway", "identity export", "identity register", "identity show", "identity sign", "inbox", "listing create", "listing delete", "listing delist", "listing get", "listing list", "listing publish", "listing set-policy", "listing set-visibility", "org list", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse", "register", "request", "search", "send", "serve", "tailscale up", "ui", "wait"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.pr64_66 },
	{ commands: ["gateway key new", "held allow", "held block", "held ignore"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "file-name"], reason: WHY.pr64_66 },
	{ commands: ["identity allow"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["stdout"], reason: WHY.pr64_66 },
	{ commands: ["identity deny"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content"], reason: WHY.pr64_66 },
	{ commands: ["identity new", "login", "org create"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "file-name", "stdout"], reason: WHY.pr64_66 },
	{ commands: ["tailscale disable"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.pr64_66 },
	{ commands: ["tailscale enable"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "stdout"], reason: WHY.pr64_66 },
	{ commands: ["whoami"], slots: ["--profile"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "json-stdout", "stderr"], reason: WHY.pr64_66 },
	{ commands: ["config use"], slots: ["<profile>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "stdout"], reason: WHY.pr64_66 },
	{ commands: "*", slots: ["--peer"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.pr65 },
	{ commands: "*", slots: ["[listingId]"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "request"], reason: WHY.pr65 },
	{ commands: ["search"], slots: ["[query]"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.pr65 },
	{ commands: ["gateway (HTTP API)"], slots: ["DELETE /v1/subscriptions/:id", "GET /v1/agents/:peer", "GET /v1/subscriptions/:id", "POST /v1/messages peer", "POST /v1/subscriptions allowedPeers", "POST /v1/tasks peer"], forms: ["escaped"], channels: ["response"], reason: WHY.pr75 },
	{ commands: ["gateway (HTTP API)"], slots: ["GET /v1/agents/:peer ?capability", "POST /v1/messages contextId", "POST /v1/tasks capability"], forms: ["nsec", "ncryptsec", "nostr", "escaped", "sentence"], channels: ["response"], reason: WHY.pr75 },
	{ commands: ["gateway (HTTP API)"], slots: ["POST /v1/messages contextId"], forms: ["nsec", "ncryptsec", "nostr"], channels: ["file-content"], reason: WHY.pr75 },
	{ commands: ["gateway (HTTP API)"], slots: ["POST /v1/subscriptions capabilities", "POST /v1/subscriptions label"], forms: ["nsec", "ncryptsec", "nostr", "escaped", "sentence"], channels: ["file-content", "response"], reason: WHY.pr75 },
	{ commands: ["gateway (HTTP API)"], slots: ["POST /v1/subscriptions url"], forms: ["nsec", "ncryptsec", "escaped", "sentence"], channels: ["response"], reason: WHY.pr75 },
	{ commands: ["config show", "doctor", "logout", "tailscale status"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["json-stdout", "stdout"], reason: WHY.profileName },
	{ commands: ["domain add", "domain list", "domain remove", "domain verify", "gateway", "identity export", "identity register", "identity show", "identity sign", "inbox", "listing create", "listing delete", "listing delist", "listing get", "listing list", "listing publish", "listing set-policy", "listing set-visibility", "org list", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse", "register", "request", "search", "send", "serve", "tailscale up", "ui", "wait"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["json-stderr", "stderr"], reason: WHY.profileName },
	{ commands: ["gateway key new", "held allow", "held block", "held ignore"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["file-content", "file-name"], reason: WHY.profileName },
	{ commands: ["identity allow"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["stdout"], reason: WHY.profileName },
	{ commands: ["identity deny"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["file-content"], reason: WHY.profileName },
	{ commands: ["identity new", "login", "org create"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["file-content", "file-name", "stdout"], reason: WHY.profileName },
	{ commands: ["tailscale disable"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.profileName },
	{ commands: ["tailscale enable"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["file-content", "stdout"], reason: WHY.profileName },
	{ commands: ["whoami"], slots: ["--profile"], forms: ["hex", "HEX", "escaped"], channels: ["json-stderr", "json-stdout", "stderr"], reason: WHY.profileName },
	{ commands: ["config use"], slots: ["<profile>"], forms: ["hex", "HEX", "escaped"], channels: ["file-content", "stdout"], reason: WHY.profileName },
	{ commands: ["send"], slots: ["--context-id"], forms: "*", channels: ["file-content", "json-stdout", "stdout"], reason: WHY.sendDecision },
	{ commands: ["send"], slots: ["--subject", "<message>"], forms: "*", channels: ["file-content"], reason: WHY.sendDecision },
	{ commands: ["card", "config list", "config path", "config set", "config show", "config use", "doctor", "domain add", "domain list", "domain remove", "domain verify", "gateway key list", "gateway key new", "gateway key revoke", "held allow", "held block", "held ignore", "held list", "identity export", "identity new", "identity register", "identity show", "identity sign", "inbox", "listing create", "listing delete", "listing delist", "listing get", "listing list", "listing publish", "listing set-policy", "listing set-visibility", "login", "logout", "org create", "org list", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse", "register", "relay", "request", "search", "send", "serve", "tailscale disable", "tailscale enable", "tailscale status", "tailscale up", "thread", "threads", "ui", "wait", "whoami"], slots: ["<extra argument>"], forms: ["hex", "HEX", "escaped"], channels: ["json-stderr", "stderr"], reason: WHY.tooMany },
	{ commands: "*", slots: ["--api-base-url"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["search"], slots: ["--capability", "--category"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["serve"], slots: ["--capability"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["stdout"], reason: WHY.unchecked },
	{ commands: ["ui"], slots: ["--compose", "--idle"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["domain add"], slots: ["--handle"], forms: ["nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["serve"], slots: ["--handler"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["gateway"], slots: ["--host"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["connect", "json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["tailscale enable"], slots: ["--hostname", "--state-dir"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "stdout"], reason: WHY.unchecked },
	{ commands: ["gateway key new"], slots: ["--label"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "json-stdout", "stdout"], reason: WHY.unchecked },
	{ commands: ["peers allowlist"], slots: ["--name"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["tailscale enable"], slots: ["--oauth-api-base-url", "--oauth-client-id", "--oauth-scope", "--oauth-tailnet", "--oauth-url", "--tag"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content"], reason: WHY.unchecked },
	{ commands: ["domain add", "domain remove", "domain verify", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers list", "peers refuse"], slots: ["--org"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["domain list", "identity register", "listing list", "register", "search"], slots: ["--org"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request", "stdout"], reason: WHY.unchecked },
	{ commands: ["login"], slots: ["--org"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "request"], reason: WHY.unchecked },
	{ commands: ["gateway", "ui"], slots: ["--port"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: "*", slots: ["--reason"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["card"], slots: ["--relay"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["card"], slots: ["--relay"], forms: ["nsec", "ncryptsec"], channels: ["connect"], reason: WHY.unchecked },
	{ commands: ["org create"], slots: ["--slug", "<name>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content", "request"], reason: WHY.unchecked },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=apiBaseUrl)", "<key>", "[value] (key=apiBaseUrl)"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["config set"], slots: ["--stdin (stdin) (key=nip05)", "--stdin (stdin) (key=org)", "--stdin (stdin) (key=orgSlug)", "--stdin (stdin) (key=relays)", "[value] (key=nip05)", "[value] (key=org)", "[value] (key=orgSlug)", "[value] (key=relays)"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["file-content"], reason: WHY.unchecked },
	{ commands: ["listing create", "peers accept", "peers allowlist", "peers block", "peers ignore", "peers refuse"], slots: ["--team"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["peers list"], slots: ["--team"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request", "stdout"], reason: WHY.unchecked },
	{ commands: ["domain verify", "wait"], slots: ["--timeout"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["inbox"], slots: ["--wait"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["request"], slots: ["<capability>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stdout", "stdout"], reason: WHY.unchecked },
	{ commands: ["thread"], slots: ["<contextId>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["domain add"], slots: ["<domain>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: "*", slots: ["<domainId>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["request"], reason: WHY.unchecked },
	{ commands: ["gateway key revoke"], slots: ["<id>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stderr", "stderr"], reason: WHY.unchecked },
	{ commands: ["identity sign"], slots: ["<nonce>"], forms: ["nsec", "ncryptsec", "nostr", "sentence"], channels: ["json-stdout", "stdout"], reason: WHY.unchecked },
];

function tupleOf(command: string, slot: string, form: string, channel: string): string {
	return `${command} | ${slot} | ${form} | ${channel}`;
}

interface Universe {
	/** `command | slot` for every slot the canary probes. */
	slots: Set<string>;
	/** Commands that have a slot, for the "*" entries. */
	commandsWith: Map<string, string[]>;
}

function universeOf(nodes: CommandNode[]): Universe {
	const slots = new Set<string>();
	const commandsWith = new Map<string, string[]>();
	for (const plan of plansFor(nodes)) {
		slots.add(`${plan.command} | ${plan.slot}`);
	}
	for (const probe of HTTP_PROBES) {
		slots.add(`${GATEWAY_API} | ${probe.slot}`);
	}
	// Not a request: what the gateway leaves in its files once it has stopped.
	slots.add(`${GATEWAY_API} | ${AFTER_STOP}`);
	for (const entry of slots) {
		const [command, slot] = entry.split(" | ") as [string, string];
		commandsWith.set(slot, [...(commandsWith.get(slot) ?? []), command]);
	}
	return { slots, commandsWith };
}

/** Every combination the entries spell out, with the reason it is listed; and what is wrong with the entries themselves. */
function expand(entries: readonly KnownLeak[], universe: Universe): { tuples: Map<string, string>; problems: string[] } {
	const tuples = new Map<string, string>();
	const problems: string[] = [];
	for (const entry of entries) {
		const forms = entry.forms === ALL ? FORMS : entry.forms;
		for (const slot of entry.slots) {
			const commands = entry.commands === ALL ? (universe.commandsWith.get(slot) ?? []) : entry.commands;
			if (commands.length === 0) {
				problems.push(`"${slot}" is not a slot of any command (${entry.reason})`);
			}
			for (const command of commands) {
				if (!universe.slots.has(`${command} | ${slot}`)) {
					problems.push(`"${command}" has no slot "${slot}" that is probed (${entry.reason})`);
					continue;
				}
				for (const form of forms) {
					for (const channel of entry.channels) {
						const tuple = tupleOf(command, slot, form, channel);
						if (tuples.has(tuple)) {
							problems.push(`listed twice: ${tuple}`);
						}
						tuples.set(tuple, entry.reason);
					}
				}
			}
		}
	}
	return { tuples, problems };
}

/** `CANARY_ONLY=search,listing list` runs only the commands whose name starts with one of those texts. */
function inScopeName(text: string): boolean {
	const only = process.env.CANARY_ONLY;
	return !only || only.split(",").some((prefix) => text.startsWith(prefix.trim()));
}

/** What is listed, for the commands that are run (all of them unless `CANARY_ONLY` is set). */
function inScope(tuples: Map<string, string>): Map<string, string> {
	return new Map([...tuples].filter(([tuple]) => inScopeName(tuple)));
}

/** What the run found against what is listed; every line says what to do. */
function compare(found: ReadonlySet<string>, known: Map<string, string>, intended: Map<string, string>): string[] {
	const problems: string[] = [];
	for (const tuple of found) {
		if (!known.has(tuple) && !intended.has(tuple)) {
			problems.push(`new leak, not in KNOWN_LEAKS: ${tuple}`);
		}
	}
	for (const [tuple, reason] of known) {
		if (intended.has(tuple)) {
			problems.push(`in both KNOWN_LEAKS and INTENDED: ${tuple}`);
		}
		if (!found.has(tuple)) {
			problems.push(`no longer leaks, remove it from KNOWN_LEAKS: ${tuple} (${reason})`);
		}
	}
	for (const [tuple, reason] of intended) {
		if (!found.has(tuple)) {
			problems.push(`no longer stored or sent, remove it from INTENDED: ${tuple} (${reason})`);
		}
	}
	return problems;
}

// ================================================================== the controls

/** A program that echoes what it is given, on purpose, to every place the canary looks. */
function leakyProgram(): Command {
	const program = new Command("leaky").exitOverride().option("--json");
	program.configureOutput({ outputError: (text, write) => write(text) });
	const add = (name: string, action: (value: string) => void | Promise<void>): void => {
		program.command(`${name} <value>`).action(async (value: string) => {
			await action(value);
		});
	};
	const home = (): string => process.env.AGX_HOME as string;
	add("out", (value) => console.log(`you typed ${value}`));
	add("err", (value) => console.error(`you typed ${value}`));
	// A stretch of 12 characters from the middle: found by a 10-character window, missed by a 20-character one.
	add("part", (value) => console.log(value.slice(Math.floor(value.length / 2) - 6, Math.floor(value.length / 2) + 6)));
	add("request", async (value) => {
		await fetch(`${world.index.origin}/echo`, { method: "POST", body: JSON.stringify({ value }) });
	});
	add("relay", async (value) => {
		const socket = new WebSocket(world.relayUrl);
		await new Promise<void>((resolve, reject) => {
			socket.on("open", () => socket.send(JSON.stringify(["REQ", "control", { "#t": [value] }])));
			socket.on("message", () => resolve());
			socket.on("error", reject);
		});
		socket.close();
	});
	add("file-name", (value) => writeFileSync(join(home(), encodeURIComponent(value).slice(0, 200)), "x"));
	add("file-content", (value) => writeFileSync(join(home(), "note.txt"), `note: ${value}`));
	add("connect", async (value) => {
		await dns.promises.lookup(`${value}.invalid`).catch(() => undefined);
	});
	add("socket", (value) => new Promise<void>((resolve) => {
		const socket = net.connect({ host: `${value}.invalid`, port: 80 });
		socket.on("error", () => resolve());
	}));
	add("remember", (value) => rememberSecret(value));
	add("clean", () => console.log("all good"));
	return program;
}

async function runLeaky(args: string[]): Promise<number> {
	try {
		await leakyProgram().parseAsync(args, { from: "user" });
		return 0;
	} catch (error) {
		if (error instanceof CommanderError) {
			return error.exitCode;
		}
		throw error;
	}
}

/** One run of the leaky program through the same code the canary uses for `agx`. */
function observeLeaky(command: string, planted: Planted, json: boolean): Promise<Observed> {
	return runOnce((_home) => ({ args: [...(json ? ["--json"] : []), command, planted.value], stdin: null }), planted, json, { run: runLeaky });
}

// ===================================================================== the tests

const LONG = 900_000;

describe("the secret-key canary", () => {
	it("classifies every command, option and positional of the program", () => {
		expect(unclassified(walkProgram(buildProgram()))).toEqual([]);
	});

	it("names only slots that exist, each combination once", () => {
		const universe = universeOf(walkProgram(buildProgram()));
		expect(expand(KNOWN_LEAKS, universe).problems).toEqual([]);
		expect(expand(INTENDED, universe).problems).toEqual([]);
	});

	it("finds no leak that is not listed, and no listed leak that is gone", async () => {
		const result = await runMatrix();
		const universe = universeOf(walkProgram(buildProgram()));
		const known = expand(KNOWN_LEAKS, universe);
		const intended = expand(INTENDED, universe);
		const found = new Set(result.leaks.map((leak) => tupleOf(leak.command, leak.slot, leak.form, leak.channel)));
		expect(compare(found, inScope(known.tuples), inScope(intended.tuples))).toEqual([]);
	}, LONG);

	it("stays on this machine, ends every command and never throws", async () => {
		const result = await runMatrix();
		expect(result.forbidden).toEqual([]);
		expect(result.threw).toEqual([]);
		expect(homesMade.filter((home) => existsSync(home))).toEqual([]);
		expect(process.cwd()).toBe(startedIn);
	}, LONG);

	describe("the controls", () => {
		// Every place the canary looks, with a command that repeats its argument there on purpose.
		const CONTROLS: Array<{ command: string; forms: readonly Form[]; channel: "stdout" | "stderr" | Channel }> = [
			{ command: "out", forms: FORMS, channel: "stdout" },
			{ command: "err", forms: FORMS, channel: "stderr" },
			{ command: "part", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr"], channel: "stdout" },
			{ command: "request", forms: FORMS, channel: "request" },
			{ command: "relay", forms: FORMS, channel: "relay" },
			{ command: "file-name", forms: ["nsec", "ncryptsec", "hex", "HEX", "nostr"], channel: "file-name" },
			{ command: "file-content", forms: FORMS, channel: "file-content" },
			{ command: "connect", forms: ["nsec", "ncryptsec", "hex", "HEX"], channel: "connect" },
			{ command: "socket", forms: ["nsec", "ncryptsec", "hex", "HEX"], channel: "connect" },
		];
		const here = (channel: Channel, json: boolean): Channel =>
			json && channel === "stdout" ? "json-stdout" : json && channel === "stderr" ? "json-stderr" : channel;

		for (const control of CONTROLS) {
			it(`reports a key that \`${control.command}\` repeats, in every form`, async () => {
				const missed: string[] = [];
				for (const form of control.forms) {
					for (const json of [false, true]) {
						const planted = plant(form, `leaky ${control.command}`);
						const observed = await observeLeaky(control.command, planted, json);
						if (observed.threw || !observed.channels.has(here(control.channel, json))) {
							missed.push(`${control.command} | ${form} | ${json ? "--json" : "human"}: ${observed.threw ?? `not seen in ${here(control.channel, json)}`}`);
						}
					}
				}
				expect(missed).toEqual([]);
			}, LONG);
		}

		it("notices a program that teaches the redactor the key", async () => {
			const observed = await observeLeaky("remember", plant("nsec", "remember"), false);
			expect(observed.threw).toMatch(/remembered the planted key/);
		});

		it("notices a command, an option and a positional that the slot table does not list", () => {
			const program = buildProgram();
			program.command("throwaway <value>").option("--extra <text>").action(() => undefined);
			const search = program.commands.find((command) => command.name() === "search") as Command;
			search.option("--new-flag <text>").argument("[more]");
			const problems = unclassified(walkProgram(program));
			expect(problems).toContain('command "throwaway" is not in SLOT_TABLE');
			expect(problems).toContain('"search" --new-flag takes a value and has no class in SLOT_TABLE');
			expect(problems).toContain('"search" [more] takes a value and has no class in SLOT_TABLE');
		});

		it("notices a slot table entry that the program no longer has", () => {
			const smaller = new Command("agx");
			smaller.command("search [query]").action(() => undefined);
			const problems = unclassified(walkProgram(smaller));
			expect(problems).toContain('SLOT_TABLE lists command "login", which the program no longer has');
			expect(problems).toContain('SLOT_TABLE lists "search" --capability, which the program no longer has');
		});

		it("stays quiet for a command that repeats nothing", async () => {
			const noisy: string[] = [];
			for (const form of FORMS) {
				for (const json of [false, true]) {
					const observed = await observeLeaky("clean", plant(form, "clean"), json);
					if (observed.threw || observed.channels.size > 0) {
						noisy.push(`clean | ${form} | ${json ? "--json" : "human"}: ${observed.threw ?? [...observed.channels].join(", ")}`);
					}
				}
			}
			expect(noisy).toEqual([]);
		}, LONG);

		it("starts every command with the throwaway relay and not the stock one", async () => {
			const show = () => ({ args: ["config", "show"], stdin: null });
			const ours = await runOnce(show, { ...plant("nsec", "relay"), needles: [world.relayUrl] }, false);
			expect(ours.threw).toBeNull();
			expect([...ours.channels]).toContain("stdout");
			const stock = await runOnce(show, { ...plant("nsec", "relay"), needles: ["127.0.0.1:7447"] }, false);
			expect(stock.threw).toBeNull();
			expect([...stock.channels]).toEqual([]);
		}, LONG);

		it("stops a connection to a port that is never touched, and to any other machine", () => {
			expect(blockedReason("127.0.0.1", 7447)).toBe("port");
			expect(blockedReason("localhost", 53505)).toBe("port");
			expect(blockedReason("::1", 7447)).toBe("port");
			expect(blockedReason("relay.example.org", 7447)).toBe("port");
			expect(blockedReason("relay.example.org", 443)).toBe("name");
			expect(blockedReason("192.0.2.1", 80)).toBe("name");
			expect(blockedReason("127.0.0.1", 40123)).toBeNull();
			expect(blockedReason("localhost", null)).toBeNull();
		});

		it("tells which port a server is asked to listen on", () => {
			expect(listenPortOf([7447, "127.0.0.1"])).toBe(7447);
			expect(listenPortOf(["53505"])).toBe(53505);
			expect(listenPortOf([{ port: 7447, host: "::1" }])).toBe(7447);
			expect(listenPortOf([{ port: "0" }])).toBe(0);
			expect(listenPortOf([0, () => undefined])).toBe(0);
			expect(listenPortOf([{ path: "/tmp/a.sock" }, () => undefined])).toBeNull();
			expect(listenPortOf([() => undefined])).toBeNull();
			expect(listenPortOf([])).toBeNull();
		});

		it("sees a key in an HTTP answer and in the gateway's log", async () => {
			const box = sandbox();
			const lines: string[] = [];
			const echo = createServer((req, res) => {
				// What the gateway does with a path: take one level of escaping off before it uses it.
				const asked = decodeURIComponent(req.url ?? "");
				lines.push(`${req.method} ${asked}`);
				res.end(`you asked for ${asked}`);
			});
			await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
			try {
				const probe = HTTP_PROBES.find((candidate) => candidate.slot === "GET /v1/tasks/:id") as HttpProbe;
				const missed: string[] = [];
				for (const form of FORMS) {
					const planted = plant(form, "echo");
					const watch: HttpWatch = {
						url: `http://127.0.0.1:${(echo.address() as AddressInfo).port}`,
						key: "none",
						home: box.home,
						lines,
						skip: new Set(),
						tree: readTree(box.home),
					};
					const sent = await sendProbe(watch, probe, planted);
					for (const channel of ["response", "log"] as const) {
						if (!sent.channels.has(channel)) {
							missed.push(`${form}: not seen in ${channel}`);
						}
					}
				}
				expect(missed).toEqual([]);
			} finally {
				await new Promise<void>((resolve) => echo.close(() => resolve()));
				box.restore();
			}
		});
	});

	describe("the detector", () => {
		const planted = plant("nsec");
		const data = planted.value.slice("nsec1".length);

		it("finds a 10-character stretch of the key and not a 9-character one", () => {
			expect(holdsKey(`before ${data.slice(7, 17)} after`, planted.needles)).toBe(true);
			expect(holdsKey(`before ${data.slice(7, 16)} after`, planted.needles)).toBe(false);
		});

		it("finds it in either case", () => {
			expect(holdsKey(data.slice(3, 23).toUpperCase(), planted.needles)).toBe(true);
		});

		it("finds it after %xx decoding, behind a nostr: prefix, and in a sentence", () => {
			expect(holdsKey(percentEscapeAll(data.slice(3, 23)), planted.needles)).toBe(true);
			expect(holdsKey(`nostr:${planted.value}`, planted.needles)).toBe(true);
			expect(holdsKey(`my key is ${planted.value} and please keep it safe`, planted.needles)).toBe(true);
		});

		it("finds the profile's own key written as hex, nsec1… or npub1…", () => {
			const own = plant("hex");
			const bytes = hexToBytes(own.value);
			expect(holdsKey(own.value.toUpperCase(), own.needles)).toBe(true);
			expect(holdsKey(nip19.nsecEncode(bytes), own.needles)).toBe(true);
			expect(holdsKey(nip19.npubEncode(own.value), own.needles)).toBe(true);
		});

		it("does not take the prefix every key shares for a key", () => {
			for (const form of ["nsec", "ncryptsec"] as const) {
				expect(holdsKey("give an nsec1… or an ncryptsec1… key, or 64 hex characters", plant(form).needles)).toBe(false);
			}
		});

		it("holds every planted form's own value, in the shape it claims", () => {
			const shapes: Record<Form, RegExp> = {
				nsec: /^nsec1[0-9a-z]{58}$/,
				ncryptsec: /^ncryptsec1[0-9a-z]+$/,
				hex: /^[0-9a-f]{64}$/,
				HEX: /^[0-9A-F]{64}$/,
				nostr: /^nostr:nsec1[0-9a-z]{58}$/,
				escaped: /^(%[0-9A-F]{2}){63}$/,
				sentence: /^my key is nsec1[0-9a-z]{58} and please keep it safe$/,
			};
			for (const form of FORMS) {
				const value = plant(form);
				expect(value.value).toMatch(shapes[form]);
				expect(holdsKey(value.value, value.needles)).toBe(true);
				expect(holdsKey(mask(value.value), value.needles)).toBe(false);
			}
		});
	});
});
