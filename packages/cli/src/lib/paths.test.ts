import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../test/helpers.js";
import { PrivateFileExistsError, writePrivateJson, writePrivateText } from "./paths.js";

// writePrivateText replaces what is there, by default. With `exclusive` it
// creates the file only if nothing is there when it is written, and says so with
// PrivateFileExistsError. The file is finished before it becomes visible, is
// private (0600), and no temporary file is left behind, whichever way it ends.

/** Lets a test make the link step fail the way a file system without hard links does. */
const link = vi.hoisted(() => ({ fail: undefined as undefined | NodeJS.ErrnoException }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: (from: string, to: string) => {
			if (link.fail) {
				throw link.fail;
			}
			return actual.linkSync(from, to);
		},
	};
});

let box: ReturnType<typeof sandbox>;
let target: string;
const folder = () => readdirSync(dirname(target)).sort();
const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
	box = sandbox();
	target = join(box.home, "profiles", "p", "secret.json");
});

afterEach(() => {
	link.fail = undefined;
	box.restore();
});

describe("an exclusive private write", () => {
	it("creates the file complete and private when nothing is there, and leaves no temporary file", () => {
		writePrivateText(target, "first\n", { exclusive: true });
		expect(readFileSync(target, "utf8")).toBe("first\n");
		expect(mode(target)).toBe(0o600);
		expect(mode(dirname(target))).toBe(0o700);
		expect(folder()).toEqual(["secret.json"]);
	});

	it("writes JSON the same way", () => {
		writePrivateJson(target, { a: 1 }, { exclusive: true });
		expect(readFileSync(target, "utf8")).toBe('{\n  "a": 1\n}\n');
		expect(mode(target)).toBe(0o600);
	});

	it("refuses when a file is there, with an error that names the path and nothing else", () => {
		const marker = randomBytes(16).toString("hex");
		writePrivateText(target, "old\n");
		let caught: unknown;
		try {
			writePrivateText(target, `new ${marker}\n`, { exclusive: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PrivateFileExistsError);
		expect((caught as PrivateFileExistsError).path).toBe(target);
		expect(String((caught as Error).stack).includes(marker)).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("old\n");
		expect(folder()).toEqual(["secret.json"]);
	});

	it("refuses when an empty file is there", () => {
		writePrivateText(target, "");
		expect(() => writePrivateText(target, "new\n", { exclusive: true })).toThrow(PrivateFileExistsError);
		expect(readFileSync(target, "utf8")).toBe("");
	});

	it("passes on a failure of the link that is not 'already exists', and writes nothing", () => {
		link.fail = Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
		let caught: unknown;
		try {
			writePrivateText(target, "new\n", { exclusive: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(link.fail);
		expect(caught).not.toBeInstanceOf(PrivateFileExistsError);
		expect(existsSync(target)).toBe(false);
		expect(folder()).toEqual([]);
	});
});

describe("a private write that is not exclusive", () => {
	it("still replaces what is there, privately", () => {
		writePrivateText(target, "old\n");
		writeFileSync(target, "old\n", { mode: 0o644 });
		writePrivateText(target, "new\n");
		expect(readFileSync(target, "utf8")).toBe("new\n");
		expect(mode(target)).toBe(0o600);
		expect(folder()).toEqual(["secret.json"]);
	});

	it("does not use the link step, so a file system without hard links is not affected", () => {
		link.fail = Object.assign(new Error("operation not permitted, link"), { code: "EPERM" });
		writePrivateText(target, "first\n");
		writePrivateText(target, "second\n");
		expect(readFileSync(target, "utf8")).toBe("second\n");
	});
});
