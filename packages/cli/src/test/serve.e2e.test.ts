import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The BUILT CLI (`dist/agx.js`) as real processes: an `agx serve` responder
 * and an `agx request` asker over an in-process relay, then SIGINT lands
 * while a task's handler is mid-run. Checks what the in-process unit tests
 * cannot — that serve's shutdown DRAINS in-flight handlers and publishes
 * their result before exiting, so the requester is answered instead of
 * waiting out its timeout on a responder that went away.
 *
 *   pnpm build && pnpm --filter @nostr-agx/cli test:e2e:serve
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let relay: RunningRelay;

/** Start the built CLI; `done` settles when it exits, `output()` reads its
 * stdout so far, so a test can choreograph around what it has printed. */
function start(...args: string[]): {
	child: ChildProcess;
	done: Promise<Run>;
	output: () => string;
} {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = home;
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const done = new Promise<Run>((resolve, reject) => {
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done, output: () => stdout };
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("condition not met in time");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** A fresh profile keyed to the in-process relay; returns its npub. */
async function newAgentProfile(name: string): Promise<string> {
	await agx("--profile", name, "identity", "new");
	await agx("--profile", name, "config", "set", "relays", `ws://127.0.0.1:${relay.port}`);
	const show = await agx("--profile", name, "identity", "show");
	const npub = /npub1[0-9a-z]+/.exec(show.stdout)?.[0];
	if (!npub) {
		throw new Error(`no npub in \`identity show\` output:\n${show.stdout}`);
	}
	return npub;
}

describe.skipIf(!existsSync(AGX))("serve Ctrl-C drain", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-serve-"));
		relay = await startRelay({ port: 0 });
	});

	afterAll(async () => {
		await relay?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("SIGINT mid-handler still delivers the running task's result", async () => {
		const responder = await newAgentProfile("responder");
		await newAgentProfile("asker");

		// Slow enough that SIGINT lands inside the handler, not around it.
		const handler = join(home, "slow-handler.mjs");
		writeFileSync(
			handler,
			[
				"const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
				"export default {",
				"	'slow.echo': async (payload) => {",
				"		await sleep(2500);",
				"		return { slow: true, got: payload };",
				"	},",
				"};",
			].join("\n"),
		);

		const serve = start(
			"--profile",
			"responder",
			"serve",
			"--allow-all",
			"--handler",
			handler,
			"--poll-interval",
			"500",
		);
		await until(() => serve.output().includes("watching for messages"), 10_000);

		const request = start(
			"--profile",
			"asker",
			"request",
			responder,
			"slow.echo",
			"--payload",
			'{"hi":1}',
			"--timeout",
			"20000",
		);
		await until(() => serve.output().includes("TASK"), 10_000);
		// The handler is ~300ms into its 2500ms sleep here.
		await new Promise((r) => setTimeout(r, 300));
		serve.child.kill("SIGINT");

		const [serveRun, requestRun] = await Promise.all([serve.done, request.done]);

		// The asker got its answer instead of timing out on a dead responder.
		expect(requestRun.code, requestRun.stderr).toBe(0);
		expect(requestRun.stdout).toContain('"slow": true');
		// Serve took its own shutdown path, waited for the handler, and
		// published AFTER "stopping…" — the drain, not a lucky finish.
		expect(serveRun.code, serveRun.stderr).toBe(0);
		const out = serveRun.stdout;
		expect(out.indexOf("stopping")).toBeGreaterThanOrEqual(0);
		expect(out.indexOf('"slow":true')).toBeGreaterThan(out.indexOf("stopping"));
	}, 30_000);
});
