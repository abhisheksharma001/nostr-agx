import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfile, updateProfile } from "./config.js";
import { createIdentity } from "./identity.js";
import { configPath } from "./paths.js";

let home: string;
let previous: string | undefined;

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
	if (previous === undefined) {
		delete process.env.AGX_HOME;
	} else {
		process.env.AGX_HOME = previous;
	}
	rmSync(home, { recursive: true, force: true });
});

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
