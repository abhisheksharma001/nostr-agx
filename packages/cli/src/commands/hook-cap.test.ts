import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIME_CAP_MS } from "../lib/hook.js";
import { profileDir } from "../lib/paths.js";
import { MessageStore } from "../lib/store/message-store.js";
import { capture, sandbox } from "../test/helpers.js";
import { hookCommand } from "./hook.js";

/**
 * A hook runs inside the host's turn, so it must give up quickly and quietly:
 * after a fixed time cap it prints nothing and returns, whatever it was waiting
 * for. The only thing it can wait for is the host's own input on stdin.
 */

const PEER = toNpub("11".repeat(32));

let box: ReturnType<typeof sandbox>;

beforeEach(() => {
	box = sandbox();
	const store = new MessageStore(profileDir("default"));
	store.addInbound({ id: "in-1", peer: PEER, subject: null, contextId: "thread-a", text: "BODY-MARKER-5512", at: new Date().toISOString() });
	store.flush();
});

afterEach(() => {
	process.exitCode = undefined;
	box.restore();
});

/** A stream that never produces data and never ends, as a host that keeps the pipe open would. */
function silentStream(): Readable {
	return new Readable({ read() {} });
}

const markPath = (): string => join(profileDir("default"), "hook-nudged-cursor.json");

describe("agx hook: the time cap", () => {
	it("is a short fixed number of milliseconds", () => {
		expect(Number.isInteger(HOOK_TIME_CAP_MS)).toBe(true);
		expect(HOOK_TIME_CAP_MS).toBeGreaterThanOrEqual(500);
		expect(HOOK_TIME_CAP_MS).toBeLessThanOrEqual(5000);
	});

	it("gives up on a host that never closes stdin: no output, no mark, no exit code, and the stream is released", async () => {
		const stream = silentStream();
		const started = Date.now();
		const { stdout, stderr } = await capture(() => hookCommand("stop", { host: "cursor" }, { stdin: stream, capMs: 60 }));
		expect(Date.now() - started).toBeLessThan(2000);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
		expect(existsSync(markPath())).toBe(false);
		expect(process.exitCode).toBeUndefined();
		expect(stream.destroyed).toBe(true);
	});

	it("gives up on a host that keeps sending data without ever finishing", async () => {
		const stream = silentStream();
		const timer = setInterval(() => stream.push(" "), 10);
		try {
			const started = Date.now();
			const { stdout } = await capture(() => hookCommand("stop", { host: "cursor" }, { stdin: stream, capMs: 60 }));
			expect(Date.now() - started).toBeLessThan(2000);
			expect(stdout).toBe("");
		} finally {
			clearInterval(timer);
			stream.destroy();
		}
		expect(existsSync(markPath())).toBe(false);
	});

	it("does not nudge or record anything when the input finishes only after the cap", async () => {
		const stream = silentStream();
		setTimeout(() => {
			stream.push(JSON.stringify({ status: "completed", loop_count: 0 }));
			stream.push(null);
		}, 250);
		const { stdout } = await capture(async () => {
			await hookCommand("stop", { host: "cursor" }, { stdin: stream, capMs: 60 });
			await new Promise((done) => setTimeout(done, 500));
		});
		expect(stdout).toBe("");
		expect(existsSync(markPath())).toBe(false);
	});

	it("still nudges when the input arrives before the cap", async () => {
		const stream = Readable.from([Buffer.from(JSON.stringify({ status: "completed", loop_count: 0 }))]);
		const { stdout } = await capture(() => hookCommand("stop", { host: "cursor" }, { stdin: stream, capMs: 5000 }));
		expect(JSON.parse(stdout)).toHaveProperty("followup_message");
	});

	it("does not wait for stdin at all for a host whose hook ignores it", async () => {
		const stream = silentStream();
		const started = Date.now();
		const { stdout } = await capture(() => hookCommand("stop", { host: "claude" }, { stdin: stream, capMs: 5000 }));
		expect(Date.now() - started).toBeLessThan(1500);
		expect(JSON.parse(stdout)).toMatchObject({ decision: "block" });
		stream.destroy();
	});
});
