import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Everything the CLI prints leaves through a few writers in `lib/output.ts`, and each of them scrubs a
// secret key out of the text first. This test reads the source and lists every place that writes to
// the terminal at all, so a new `console.log` or `process.stdout.write` somewhere else, which would go
// out unscrubbed, fails here instead of being found later by a leak.
//
// Not covered, on purpose: tests, the browser code under `ui-client`, and the web UI's and the
// gateway's HTTP answers (the gateway's `sendJson` is tested in `gateway/gateway-scrub.test.ts`).

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every non-test `.ts` file under `src`, as a path relative to it with `/` separators. */
function sources(dir = SRC): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "test" && entry.name !== "ui-client") {
				out.push(...sources(path));
			}
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
			out.push(relative(SRC, path).split(sep).join("/"));
		}
	}
	return out.sort();
}

/** Calls that write to the terminal: `console.<anything>(`, `process.stdout.write`, `process.stderr.write`. */
const WRITES = /\bconsole\.\w+\s*\(|\bprocess\.(?:stdout|stderr)\.write\b|\bprocess\.std(?:out|err)\b(?!\.isTTY)/g;

function writesIn(file: string): string[] {
	const text = readFileSync(join(SRC, file), "utf8");
	// A comment that names one of these is not a call.
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	return [...code.matchAll(WRITES)].map((match) => match[0].replace(/\s+/g, " "));
}

describe("the places the CLI writes to the terminal", () => {
	it("are the writers in output.ts, the one deliberate print of agx identity export, and one fixed sentence in lock.ts", () => {
		const found: Record<string, string[]> = {};
		for (const file of sources()) {
			const writes = writesIn(file);
			if (writes.length > 0) {
				found[file] = writes;
			}
		}
		const { "lib/output.ts": writers, ...elsewhere } = found;
		expect(writers?.length).toBeGreaterThan(0);
		expect(elsewhere).toEqual({
			"commands/identity.ts": ["console.log("],
			"lib/lock.ts": ["process.stderr.write"],
		});
	});

	it("has the deliberate print in the export command, after its own check for a terminal", () => {
		const text = readFileSync(join(SRC, "commands/identity.ts"), "utf8");
		const start = text.indexOf("export function identityExportCommand");
		const end = text.indexOf("export async function identitySignCommand");
		const body = text.slice(start, end);
		expect(body.indexOf("Refusing to print a secret key to a terminal")).toBeGreaterThan(-1);
		expect(body.indexOf("Refusing to print a secret key to a terminal")).toBeLessThan(body.indexOf("console.log("));
		expect(body.match(/console\.log\(/g)?.length).toBe(1);
	});

	it("keeps the fixed sentence in lock.ts free of anything a person or a peer typed", () => {
		const text = readFileSync(join(SRC, "lib/lock.ts"), "utf8");
		expect(text).toMatch(/process\.stderr\.write\("agx: lost the profile lock to another process; stopping so two writers do not overwrite each other\.\\n"\)/);
	});
});
