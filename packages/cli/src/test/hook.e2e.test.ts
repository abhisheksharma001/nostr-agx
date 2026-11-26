import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

/**
 * The BUILT CLI (`dist/agx.js`) as real processes: `agx hook` is run the way a
 * coding agent's hook configuration runs it, next to a long-running `agx serve`
 * that holds the profile lock. The hook must read what serve has stored, say it
 * once, never show what a peer wrote, and always end quickly with exit 0.
 *
 *   pnpm build && E2E=1 pnpm exec vitest run src/test/hook.e2e.test.ts
 *
 * Not part of `test:unit`: it needs a fresh build.
 */

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

/** The hook's own time cap is 3 s; a host must never be kept waiting longer than 5 s. */
const LONGEST_ALLOWED_MS = 5000;

/** Thread ids as agx makes them. */
const THREAD_A = "00000000-0000-4000-8000-00000000000a";
const THREAD_B = "00000000-0000-4000-8000-00000000000b";
const THREAD_C = "00000000-0000-4000-8000-00000000000c";
const THREAD_D = "00000000-0000-4000-8000-00000000000d";

/** What each host sends to a stop hook at the end of an ordinary turn, and in a turn it is already continuing. */
const ORDINARY: Record<string, string> = {
	claude: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
	codex: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }),
	cursor: JSON.stringify({ status: "completed", loop_count: 0 }),
};

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	ms: number;
}

interface Started {
	child: ChildProcess;
	done: Promise<Run>;
	output: () => string;
}

let home: string;
let relay: RunningRelay;
let serve: Started | undefined;

function start(args: string[], options: { stdin?: "ignore" | "pipe"; home?: string } = {}): Started {
	const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
	for (const key of Object.keys(env)) {
		if (key.startsWith("AGX_")) {
			delete env[key];
		}
	}
	env.AGX_HOME = options.home ?? home;
	const began = Date.now();
	const child = spawn(process.execPath, [AGX, ...args], { env, stdio: [options.stdin ?? "ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const done = new Promise<Run>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - began }));
	});
	return { child, done, output: () => stdout };
}

async function agx(...args: string[]): Promise<Run> {
	return start(args).done;
}

async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error(`not met in time: ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

async function unread(profile: string): Promise<number> {
	const run = await agx("--json", "--profile", profile, "inbox", "--summary");
	expect(run.code, run.stderr).toBe(0);
	return (JSON.parse(run.stdout) as { unread: number }).unread;
}

async function newProfile(name: string): Promise<string> {
	expect((await agx("--profile", name, "identity", "new")).code).toBe(0);
	expect((await agx("--profile", name, "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	const npub = /npub1[0-9a-z]+/.exec((await agx("--profile", name, "identity", "show")).stdout)?.[0];
	if (!npub) {
		throw new Error(`no npub for ${name}`);
	}
	return npub;
}

/** Runs a hook and feeds it `stdin` the way a host does, then closes the pipe. */
async function hook(profile: string, event: string, host: string, stdin?: string): Promise<Run> {
	// A stop hook is always given its input; the others are not.
	stdin ??= event === "stop" ? ORDINARY[host] : undefined;
	const running = start(["--profile", profile, "hook", event, "--host", host], { stdin: "pipe" });
	if (stdin !== undefined) {
		running.child.stdin?.write(stdin);
	}
	running.child.stdin?.end();
	return running.done;
}

describe.skipIf(!existsSync(AGX))("agx hook next to a running agx serve", () => {
	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-hook-"));
		relay = await startRelay({ port: 0 });
	});

	afterAll(async () => {
		// Only the process this file started.
		if (serve && serve.child.exitCode === null) {
			serve.child.kill("SIGKILL");
		}
		await relay?.close();
		rmSync(home, { recursive: true, force: true });
	});

	it("says each new message once while serve holds the lock, shows no peer text, and ends within the time cap", async () => {
		const sender = await newProfile("sender");
		const receiver = await newProfile("receiver");
		await newProfile("stranger");
		expect((await agx("--profile", "receiver", "identity", "allow", sender)).code).toBe(0);

		serve = start(["--profile", "receiver", "serve", "--no-reply", "--no-tasks", "--allowed-only", "--poll-interval", "300"]);
		await eventually(async () => serve?.output().includes("watching for messages") === true, "serve to start watching");

		// Nothing stored yet: silent, exit 0.
		const quiet = await hook("receiver", "stop", "claude");
		expect(quiet.code).toBe(0);
		expect(quiet.stdout).toBe("");
		expect(quiet.stderr).toBe("");

		expect((await agx("--profile", "sender", "send", "--context-id", THREAD_A, "--", receiver, "REQUEST-TEXT-6204 first")).code).toBe(0);
		expect((await agx("--profile", "sender", "send", "--context-id", THREAD_B, "--", receiver, "REQUEST-TEXT-6204 second")).code).toBe(0);
		await eventually(async () => (await unread("receiver")) === 2, "two unread messages stored by serve");

		// Claude Code: the turn is kept going once, with counts and thread ids only.
		const first = await hook("receiver", "stop", "claude", JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false }));
		expect(first.code).toBe(0);
		expect(first.stderr).toBe("");
		const nudge = JSON.parse(first.stdout) as { decision: string; reason: string };
		expect(first.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(nudge.decision).toBe("block");
		expect(nudge.reason).toContain("agx --profile receiver thread <id>");
		expect(nudge.reason).toMatch(/2 unread messages/);
		expect(nudge.reason).toContain(THREAD_A);
		expect(nudge.reason).toContain(THREAD_B);
		expect(first.stdout).not.toMatch(/REQUEST-TEXT-6204|npub1/);

		// The same mail does not nudge again, from either turn-end or prompt hook.
		for (const event of ["stop", "prompt"]) {
			const again = await hook("receiver", event, "claude");
			expect(again.code).toBe(0);
			expect(again.stdout).toBe("");
		}

		// Cursor has its own mark and its own shape.
		const cursor = await hook("receiver", "stop", "cursor", JSON.stringify({ status: "completed", loop_count: 0 }));
		expect(cursor.code).toBe(0);
		expect(Object.keys(JSON.parse(cursor.stdout) as object)).toEqual(["followup_message"]);

		// A sender off the allowlist is held, and never nudges or appears.
		expect((await agx("--profile", "stranger", "send", "--", receiver, "STRANGER-TEXT-6204")).code).toBe(0);
		await eventually(async () => {
			const run = await agx("--json", "--profile", "receiver", "inbox", "--summary");
			return (JSON.parse(run.stdout) as { held: number }).held === 1;
		}, "one held sender");
		const afterHeld = await hook("receiver", "stop", "claude");
		expect(afterHeld.code).toBe(0);
		expect(afterHeld.stdout).toBe("");

		// A new message nudges again, and serve was never disturbed.
		expect((await agx("--profile", "sender", "send", "--context-id", THREAD_C, "--", receiver, "REQUEST-TEXT-6204 third")).code).toBe(0);
		await eventually(async () => (await unread("receiver")) === 3, "three unread messages");
		const third = await hook("receiver", "stop", "claude");
		expect(third.code).toBe(0);
		expect((JSON.parse(third.stdout) as { reason: string }).reason).toMatch(new RegExp(`1 new message \\(3 unread in all\\)\\. Threads with new messages: ${THREAD_C}\\.`));

		// A turn the host is already continuing because of a stop hook is left alone, and the
		// mail is not marked as announced: the next ordinary turn end says it.
		expect((await agx("--profile", "sender", "send", "--context-id", THREAD_D, "--", receiver, "REQUEST-TEXT-6204 fourth")).code).toBe(0);
		await eventually(async () => (await unread("receiver")) === 4, "four unread messages");
		for (const [host, input] of [
			["claude", JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true })],
			["codex", JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true })],
			["cursor", JSON.stringify({ status: "completed", loop_count: 1 })],
		] as const) {
			const continued = await hook("receiver", "stop", host, input);
			expect(continued.code).toBe(0);
			expect(continued.stdout).toBe("");
			expect(continued.stderr).toBe("");
		}
		const fourth = await hook("receiver", "stop", "claude");
		expect((JSON.parse(fourth.stdout) as { reason: string }).reason).toMatch(new RegExp(`1 new message \\(4 unread in all\\)\\. Threads with new messages: ${THREAD_D}\\.`));

		// Mail from a sender taken off the allowlist after it arrived does not nudge; put back, it does.
		expect((await agx("--profile", "sender", "send", "--context-id", THREAD_A, "--", receiver, "REQUEST-TEXT-6204 fifth")).code).toBe(0);
		await eventually(async () => (await unread("receiver")) === 5, "five unread messages");
		expect((await agx("--profile", "receiver", "identity", "deny", sender)).code).toBe(0);
		const denied = await hook("receiver", "stop", "claude");
		expect(denied.code).toBe(0);
		expect(denied.stdout).toBe("");
		expect((await agx("--profile", "receiver", "identity", "allow", sender)).code).toBe(0);
		const allowedAgain = await hook("receiver", "stop", "claude");
		expect((JSON.parse(allowedAgain.stdout) as { reason: string }).reason).toMatch(/1 new message \(5 unread in all\)/);

		expect(serve.child.exitCode).toBeNull();
		expect(existsSync(join(home, "profiles", "receiver", "serve.lock"))).toBe(true);
	}, 120_000);

	it("ends on its own within the time cap when the host never closes stdin, and when the folder is not usable", async () => {
		// A host that leaves the pipe open: the process still ends, silent, exit 0.
		const open = start(["--profile", "receiver", "hook", "stop", "--host", "cursor"], { stdin: "pipe" });
		const result = await open.done;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.ms).toBeLessThan(LONGEST_ALLOWED_MS + 3000);

		// Claude Code's stop input is read too, under the same cap.
		const stop = start(["--profile", "receiver", "hook", "stop", "--host", "claude"], { stdin: "pipe" });
		const stopped = await stop.done;
		expect(stopped.code).toBe(0);
		expect(stopped.stdout).toBe("");
		expect(stopped.ms).toBeLessThan(LONGEST_ALLOWED_MS + 3000);

		// Session start and prompt never read the host's input: an open pipe costs nothing.
		for (const event of ["session-start", "prompt"]) {
			const claude = start(["--profile", "receiver", "hook", event, "--host", "claude"], { stdin: "pipe" });
			const quick = await claude.done;
			expect(quick.code).toBe(0);
			expect(quick.ms).toBeLessThan(3000);
		}

		// A broken config.json: still exit 0 and no output, so the host carries on.
		const broken = mkdtempSync(join(tmpdir(), "agx-e2e-hook-broken-"));
		try {
			writeFileSync(join(broken, "config.json"), "{ not json");
			const run = await start(["hook", "stop", "--host", "codex"], { home: broken }).done;
			expect(run.code).toBe(0);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe("");
		} finally {
			rmSync(broken, { recursive: true, force: true });
		}
	}, 60_000);
});
