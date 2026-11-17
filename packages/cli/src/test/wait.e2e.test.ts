import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningRelay, startRelay } from "../relay/server.js";

const AGX = fileURLToPath(new URL("../../dist/agx.js", import.meta.url));

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

let home: string;
let relay: RunningRelay;

function start(...args: string[]): { child: ChildProcess; done: Promise<Run> } {
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
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { child, done };
}

async function agx(...args: string[]): Promise<Run> {
	return start(...args).done;
}

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error("wait did not take the profile lock");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe.skipIf(!existsSync(AGX))("agx wait process signals", () => {
	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "agx-e2e-wait-"));
		relay = await startRelay({ port: 0 });
		expect((await agx("--profile", "receiver", "identity", "new")).code).toBe(0);
		expect((await agx("--profile", "receiver", "config", "set", "relays", `ws://127.0.0.1:${relay.port}`)).code).toBe(0);
	});

	afterEach(async () => {
		await relay.close();
		rmSync(home, { recursive: true, force: true });
	});

	it.each(["SIGINT", "SIGTERM"] as const)("%s exits 130 and releases the profile lock", async (signal) => {
		const waiting = start("--json", "--profile", "receiver", "wait", "--timeout", "30");
		const lock = join(home, "profiles", "receiver", "serve.lock");
		try {
			await until(() => existsSync(lock));
			waiting.child.kill(signal);
			const run = await waiting.done;
			expect(run).toMatchObject({ code: 130, stdout: "" });
			expect(existsSync(lock)).toBe(false);
			expect((await agx("--profile", "receiver", "inbox", "--wait", "1")).code).toBe(0);
		} finally {
			if (waiting.child.exitCode === null) {
				waiting.child.kill("SIGKILL");
			}
		}
	}, 10_000);
});
