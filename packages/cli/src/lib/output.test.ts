import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capture } from "../test/helpers.js";
import { json, setJsonMode } from "./output.js";

beforeEach(() => {
	setJsonMode(true);
});

afterEach(() => {
	setJsonMode(false);
});

/** U+007F (DEL), U+0085 (NEL), U+009B (CSI in some terminals), U+2028, U+2029. */
const RAW = ["\u007f", "\u0085", "\u009b", "\u2028", "\u2029"];

describe("json()", () => {
	it("escapes C1 controls, DEL and line separators and stays lossless", async () => {
		const payload = {
			org: "Acme\u009b31mRED",
			nested: [{ description: "a\u007fb\u0085c\u2028d\u2029e" }],
			"key\u009b": "plain",
			plain: "ünïcödé — ok",
		};

		const { stdout } = await capture(async () => json(payload));

		for (const ch of RAW) {
			expect(stdout).not.toContain(ch);
		}
		expect(stdout).toContain("\\u009b");
		expect(JSON.parse(stdout)).toEqual(payload);
	});
});
