import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { bundledBinaryPath, ensureExecutable, startBundledTailscale } from "./launcher";

const posix = process.platform !== "win32";
const supportedPlatforms = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-x64",
]);
const platform = `${process.platform}-${process.arch}`;
const binaryName = process.platform === "win32" ? "agx-tailscale.exe" : "agx-tailscale";
const hasBundledBinary =
	posix &&
	supportedPlatforms.has(platform) &&
	existsSync(fileURLToPath(new URL(`../bin/${platform}/${binaryName}`, import.meta.url)));

async function fakeBinary(source: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(path, source, { mode: 0o755 });
	await chmod(path, 0o755);
	return { dir, path };
}

/** A launcher that reports a proxy and then waits for stdin to close, like the real one. */
const RUNNING = "echo socks5://agx:secret@127.0.0.1:43220\nexec cat >/dev/null\n";

/**
 * Reports a proxy, then ends the way `ending` says once the file `trigger`
 * exists. `<trigger>.gone` is written just before it ends.
 */
function endingTail(trigger: string, ending: string): string {
	return (
		"echo socks5://agx:secret@127.0.0.1:43230\n" +
		`while [ ! -e ${JSON.stringify(trigger)} ]; do sleep 0.05; done\n` +
		`: > ${JSON.stringify(`${trigger}.gone`)}\n` +
		`${ending}\n`
	);
}

/** Fail with `what` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not arrive within ${ms} ms`)), ms);
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Wait until `condition` holds, or fail after `timeoutMs`. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/**
 * A fake launcher that writes its arguments to `<dir>/args.<pid>`, then runs
 * `tail`. One file per launch, so two launches from one binary stay apart.
 */
async function recordingBinary(tail: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "agx-launcher-args-"));
	const path = join(dir, "fake-agx-tailscale");
	await writeFile(
		path,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(dir)}/args.$$\n${tail}`,
		{ mode: 0o755 },
	);
	await chmod(path, 0o755);
	return { dir, path };
}

/** The arguments of each launch a recording binary saw. */
async function recordedLaunches(dir: string): Promise<string[][]> {
	const names = (await readdir(dir)).filter((name) => name.startsWith("args.")).sort();
	return Promise.all(
		names.map(async (name) =>
			(await readFile(join(dir, name), "utf8")).split("\n").filter(Boolean),
		),
	);
}

/** The arguments of the one launch a recording binary saw, once it has written them. */
async function firstLaunch(dir: string): Promise<string[]> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const [launch] = await recordedLaunches(dir);
		if (launch) return launch;
		if (Date.now() > deadline) throw new Error("the launcher never recorded its arguments");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function stateDirArg(args: string[]): string {
	const flag = args.indexOf("--state-dir");
	expect(flag, `no --state-dir in ${JSON.stringify(args)}`).toBeGreaterThanOrEqual(0);
	return args[flag + 1]!;
}

describe("bundledBinaryPath", () => {
	it.skipIf(!hasBundledBinary)("resolves the binary for the current platform", () => {
		const binary = bundledBinaryPath();
		expect(binary).toContain(join("bin", platform));
		expect(binary).toMatch(/agx-tailscale(\.exe)?$/);
	});
});

describe("ensureExecutable", () => {
	it.skipIf(!posix)("restores the executable bit a packed launcher lost", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		try {
			const path = join(dir, "agx-tailscale");
			await writeFile(path, "#!/bin/sh\n", { mode: 0o644 });
			await chmod(path, 0o644);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o755);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("leaves an executable launcher as it is", async () => {
		const { dir, path } = await fakeBinary("#!/bin/sh\n");
		try {
			await chmod(path, 0o700);
			ensureExecutable(path);
			expect((await stat(path)).mode & 0o777).toBe(0o700);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("startBundledTailscale", () => {
	it.skipIf(!posix)("starts a child and reports its authenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://agx:secret@127.0.0.1:43210\nexec cat >/dev/null\n",
		);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			expect(proxy).toMatchObject({
				url: "socks5://agx:secret@127.0.0.1:43210",
				address: "127.0.0.1:43210",
				host: "127.0.0.1",
				port: 43210,
			});
			await proxy.stop();
			await proxy.stop();
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes the auth key through the environment", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-test-"));
		const keyFile = join(dir, "key.txt");
		const fake = await fakeBinary(
			'#!/bin/sh\nprintf "%s" "$TS_AUTHKEY" > ' + JSON.stringify(keyFile) +
				"\necho socks5://agx:secret@127.0.0.1:43211\nexec cat >/dev/null\n",
		);
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(keyFile, "utf8")).toBe("tskey-auth-test-value");
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not pass the parent environment to the launcher", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-env-test-"));
		const marker = join(dir, "parent-env-marker");
		const fake = await fakeBinary(
			`#!/bin/sh\nprintf '%s' "$AGX_TEST_PARENT_SECRET" > ${JSON.stringify(marker)}\necho socks5://agx:secret@127.0.0.1:43213\nexec cat >/dev/null\n`,
		);
		const previous = process.env.AGX_TEST_PARENT_SECRET;
		process.env.AGX_TEST_PARENT_SECRET = "parent-secret";
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({
				binary: fake.path,
				authKey: "tskey-auth-test-value",
				timeoutMs: 5_000,
			});
			expect(await readFile(marker, "utf8")).toBe("");
		} finally {
			if (previous === undefined) delete process.env.AGX_TEST_PARENT_SECRET;
			else process.env.AGX_TEST_PARENT_SECRET = previous;
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("rejects an unauthenticated SOCKS5 URL", async () => {
		const fake = await fakeBinary(
			"#!/bin/sh\necho socks5://127.0.0.1:43212\nexec cat >/dev/null\n",
		);
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/unauthenticated SOCKS5/);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it("rejects an empty auth key", async () => {
		await expect(startBundledTailscale({ authKey: "" })).rejects.toThrow(
			/authKey must not be empty/,
		);
	});
});

describe("the default state directory", () => {
	it.skipIf(!posix)(
		"gives two handles started with defaults different state directories",
		async () => {
			const fake = await recordingBinary(RUNNING);
			const proxies: Awaited<ReturnType<typeof startBundledTailscale>>[] = [];
			try {
				proxies.push(await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }));
				proxies.push(await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }));
				const dirs = (await recordedLaunches(fake.dir)).map(stateDirArg);
				expect(dirs).toHaveLength(2);
				expect(new Set(dirs).size).toBe(2);
				for (const dir of dirs) {
					expect(dir.startsWith(tmpdir())).toBe(true);
				}
			} finally {
				for (const proxy of proxies) await proxy.stop();
				await rm(fake.dir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!posix)("is private while the handle runs and deleted when it stops", async () => {
		const fake = await recordingBinary(RUNNING);
		const proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
		try {
			const dir = stateDirArg(await firstLaunch(fake.dir));
			expect(existsSync(dir)).toBe(true);
			expect((await stat(dir)).mode & 0o777).toBe(0o700);

			await proxy.stop();
			expect(existsSync(dir)).toBe(false);
			await proxy.stop();
		} finally {
			await proxy.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher exits before it reports an address", async () => {
		const fake = await recordingBinary("exit 3\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/exited before reporting/);
			expect(existsSync(stateDirArg(await firstLaunch(fake.dir)))).toBe(false);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher does not report an address in time", async () => {
		const fake = await recordingBinary("exec cat >/dev/null\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 1_000 }),
			).rejects.toThrow(/did not report/);
			const dir = stateDirArg(await firstLaunch(fake.dir));
			// The launcher is told to stop, and the directory goes once it has.
			await until(() => !existsSync(dir));
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher reports an unauthenticated address", async () => {
		const fake = await recordingBinary("echo socks5://127.0.0.1:43221\nexec cat >/dev/null\n");
		try {
			await expect(
				startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 }),
			).rejects.toThrow(/unauthenticated SOCKS5/);
			const dir = stateDirArg(await firstLaunch(fake.dir));
			await until(() => !existsSync(dir));
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher cannot be started", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-tmpdir-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			await expect(
				startBundledTailscale({ binary: join(scratch, "no-such-launcher"), timeoutMs: 5_000 }),
			).rejects.toThrow(/could not start/);
			expect(await readdir(scratch)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is deleted when the launcher process cannot even be created", async () => {
		const fake = await recordingBinary(RUNNING);
		const scratch = await mkdtemp(join(tmpdir(), "agx-launcher-tmpdir-"));
		const previous = process.env.TMPDIR;
		process.env.TMPDIR = scratch;
		try {
			// A NUL byte in an argument makes spawn() itself throw.
			await expect(
				startBundledTailscale({
					binary: fake.path,
					hostname: `bad${String.fromCharCode(0)}name`,
					timeoutMs: 5_000,
				}),
			).rejects.toThrow();
			expect(await readdir(scratch)).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previous;
			await rm(fake.dir, { recursive: true, force: true });
			await rm(scratch, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("passes a directory the caller names through, and keeps it", async () => {
		const fake = await recordingBinary(RUNNING);
		const named = await mkdtemp(join(tmpdir(), "agx-launcher-named-state-"));
		try {
			const proxy = await startBundledTailscale({
				binary: fake.path,
				stateDir: named,
				timeoutMs: 5_000,
			});
			expect(stateDirArg(await firstLaunch(fake.dir))).toBe(named);
			await proxy.stop();
			expect(existsSync(named)).toBe(true);
		} finally {
			await rm(fake.dir, { recursive: true, force: true });
			await rm(named, { recursive: true, force: true });
		}
	});
});

describe("the exit notice", () => {
	it.skipIf(!posix)("gives a listener the exit code when the launcher exits on its own", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const exit = new Promise<unknown>((resolve) => proxy.onExit(resolve));
			await writeFile(trigger, "");
			expect(await within(exit, "the exit notice")).toEqual({ code: 7, signal: null });
			// The handle is still safe to stop afterwards.
			await proxy.stop();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("gives a listener the signal when the launcher is killed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "kill -KILL $$"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const exit = new Promise<unknown>((resolve) => proxy.onExit(resolve));
			await writeFile(trigger, "");
			expect(await within(exit, "the exit notice")).toEqual({ code: null, signal: "SIGKILL" });
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("tells a listener that subscribes after the launcher already ended", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 9"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			await writeFile(trigger, "");
			await until(() => existsSync(`${trigger}.gone`));
			await new Promise((resolve) => setTimeout(resolve, 500));
			const exit = new Promise<unknown>((resolve) => proxy.onExit(resolve));
			expect(await within(exit, "the exit notice")).toEqual({ code: 9, signal: null });
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("does not call a listener that was removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await fakeBinary("#!/bin/sh\n" + endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const removed = vi.fn();
			const off = proxy.onExit(removed);
			const kept = new Promise<unknown>((resolve) => proxy.onExit(resolve));
			off();
			await writeFile(trigger, "");
			// The second listener was added after the first, so it has been called by
			// the time this resolves; the first never is.
			await within(kept, "the exit notice");
			expect(removed).not.toHaveBeenCalled();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("is not given when stop() ended the launcher", async () => {
		const fake = await fakeBinary("#!/bin/sh\n" + RUNNING);
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const listener = vi.fn();
			proxy.onExit(listener);
			await proxy.stop();
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(listener).not.toHaveBeenCalled();
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!posix)("comes after the launcher's own state directory has been deleted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agx-launcher-exit-"));
		const trigger = join(dir, "go");
		const fake = await recordingBinary(endingTail(trigger, "exit 7"));
		let proxy: Awaited<ReturnType<typeof startBundledTailscale>> | undefined;
		try {
			proxy = await startBundledTailscale({ binary: fake.path, timeoutMs: 5_000 });
			const stateDir = stateDirArg(await firstLaunch(fake.dir));
			const seenByListener = new Promise<boolean>((resolve) =>
				proxy.onExit(() => resolve(existsSync(stateDir))),
			);
			expect(existsSync(stateDir)).toBe(true);
			await writeFile(trigger, "");
			expect(await within(seenByListener, "the exit notice")).toBe(false);
		} finally {
			await proxy?.stop();
			await rm(fake.dir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	});
});
