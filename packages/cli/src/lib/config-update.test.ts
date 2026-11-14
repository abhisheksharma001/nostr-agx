import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProfile, migrateLegacyKeysNow, updateProfile } from "./config.js";
import { createIdentity } from "./identity.js";
import { configPath } from "./paths.js";

let home: string;
let previous: string | undefined;
let holder: ChildProcess | undefined;

/** The lock file sits next to config.json; written out here so this file does not depend on the lock module. */
const lockFile = () => `${configPath()}.lock`;

const A = createIdentity().publicKey;
const B = createIdentity().publicKey;
const C = createIdentity().publicKey;

beforeEach(() => {
	previous = process.env.AGX_HOME;
	home = mkdtempSync(join(tmpdir(), "agx-config-update-"));
	process.env.AGX_HOME = home;
});

afterEach(() => {
	holder?.kill("SIGKILL");
	holder = undefined;
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

/**
 * Another agx process that holds the config lock for `ms`, then (optionally) adds `peer` to the
 * default profile's allowlist and lets go. Resolves once the lock is held.
 */
async function otherWriterHoldsLock(ms: number, peer?: string): Promise<void> {
	const script = [
		'const fs = require("fs"), os = require("os");',
		"const [lock, config, peer] = process.argv.slice(1);",
		'fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "other-writer" }) + "\\n");',
		`setTimeout(() => {`,
		"  if (peer) {",
		'    const c = JSON.parse(fs.readFileSync(config, "utf8"));',
		"    c.profiles.default.allow.push(peer);",
		"    fs.writeFileSync(config, JSON.stringify(c));",
		"  }",
		"  fs.rmSync(lock);",
		`}, ${ms});`,
		"setTimeout(() => {}, 10000);",
	].join("\n");
	holder = spawn(process.execPath, ["-e", script, lockFile(), configPath(), peer ?? ""], { stdio: "ignore" });
	const deadline = Date.now() + 5_000;
	while (!existsSync(lockFile())) {
		if (Date.now() > deadline) {
			throw new Error("the helper process never took the lock");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("updateProfile with an updater function", () => {
	it("hands the updater the profile as it is on disk when it runs, not an earlier copy", () => {
		updateProfile("default", { allow: [A] });
		const earlierRead = getProfile("default");
		// Another writer lands after that read.
		updateProfile("default", { allow: [A, B] });
		expect(earlierRead.allow).toEqual([A]);

		updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(getProfile("default").allow).toEqual([A, B, C]);
	});

	it("holds the config lock while the updater runs, and lets go afterwards", () => {
		let heldDuring = false;
		updateProfile("default", (current) => {
			heldDuring = existsSync(lockFile());
			return { allow: [...current.allow, A] };
		});
		expect(heldDuring).toBe(true);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("reads the profile only after it holds the lock, so a change made while it waited is kept", async () => {
		updateProfile("default", { allow: [A] });
		await otherWriterHoldsLock(400, B);

		const saved = updateProfile("default", (current) => ({ allow: [...current.allow, C] }));

		expect(saved.allow).toEqual([A, B, C]);
		expect(getProfile("default").allow).toEqual([A, B, C]);
	});

	it("a plain patch is also applied over what is on disk once the lock is held", async () => {
		updateProfile("default", { allow: [A] });
		await otherWriterHoldsLock(400, B);

		updateProfile("default", { orgSlug: "acme" });

		expect(getProfile("default").allow).toEqual([A, B]);
		expect(getProfile("default").orgSlug).toBe("acme");
	});

	it("returns the profile it saved", () => {
		updateProfile("default", { allow: [A] });
		const saved = updateProfile("default", (current) => ({ allow: [...current.allow, B] }));
		expect(saved.allow).toEqual([A, B]);
		expect(getProfile("default").allow).toEqual([A, B]);
	});

	it("leaves the file as it was, and no lock behind, when the updater throws", () => {
		updateProfile("default", { allow: [A] });
		expect(() =>
			updateProfile("default", () => {
				throw new Error("bad entry");
			}),
		).toThrow("bad entry");
		expect(getProfile("default").allow).toEqual([A]);
		expect(existsSync(lockFile())).toBe(false);
	});

	it("still accepts a plain patch, and leaves no lock behind", () => {
		const saved = updateProfile("default", { allow: [A], orgSlug: "acme" });
		expect(saved.allow).toEqual([A]);
		expect(getProfile("default").orgSlug).toBe("acme");
		expect(existsSync(lockFile())).toBe(false);
	});
});

describe("migrateLegacyKeysNow", () => {
	it("waits for the config lock before it rewrites config.json", async () => {
		writeFileSync(
			configPath(),
			JSON.stringify({
				version: 1,
				currentProfile: "default",
				profiles: { default: { apiBaseUrl: "http://localhost:3000", apiKey: "ela_OLD", orgSlug: "acme" } },
			}),
		);
		await otherWriterHoldsLock(400);
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const started = Date.now();
		try {
			migrateLegacyKeysNow();
		} finally {
			spy.mockRestore();
		}
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect(readFileSync(configPath(), "utf8")).not.toContain("ela_OLD");
	});
});
