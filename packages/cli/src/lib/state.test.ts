import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../test/helpers.js";
import { AgxCliError, EXIT } from "./errors.js";
import { seenPath, statePath } from "./paths.js";
import { FileSeenStore, loadState, updateState } from "./state.js";

const DAY = 24 * 60 * 60;

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	box.restore();
});

describe("FileSeenStore", () => {
	it("forgets an id once the retention window has passed", () => {
		const seen = new FileSeenStore("default");
		seen.holdFor(Date.now() / 1000);
		seen.add("event-1");
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		seen.holdFor(Date.now() / 1000);
		expect(seen.has("event-1")).toBe(false);
	});

	it("keeps ids the poll can still return while the cursor is held back", () => {
		const start = Date.now() / 1000;
		const seen = new FileSeenStore("default");
		seen.holdFor(start);
		seen.add("event-1");
		// A relay has not answered for four days: the cursor stayed at `start`,
		// so polls still reach back to it and return event-1 again.
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		seen.add("event-2");
		expect(seen.has("event-1")).toBe(true);
		// Every relay answers again and the cursor moves on: it is let go.
		seen.holdFor(Date.now() / 1000);
		seen.add("event-3");
		expect(seen.has("event-1")).toBe(false);
	});

	it("starts from the cursor the profile saved, and survives a restart", () => {
		const start = Date.now() / 1000;
		updateState("default", { cursor: start });
		const first = new FileSeenStore("default");
		first.add("event-1");
		first.flush();
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		expect(new FileSeenStore("default").has("event-1")).toBe(true);
	});

	it("drops a failure count once the event is recorded", () => {
		const seen = new FileSeenStore("default");
		expect(seen.recordFailure("event-1")).toBe(1);
		seen.add("event-1");
		expect(seen.recordFailure("event-1")).toBe(1);
	});
});

describe("a state file the CLI cannot read", () => {
	// The state file holds the poll cursor and the seen file holds the replay
	// memory. Replacing either with an empty one on a read failure re-drains the
	// inbox and runs handlers again for messages already answered. The CLI must
	// stop and say which file is wrong, and leave the file as it found it.
	function plant(path: string, text: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}

	/** The CLI error, with the config exit code, that names the file. */
	function refusal(fn: () => unknown, path: string): AgxCliError {
		let caught: unknown;
		try {
			fn();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AgxCliError);
		const error = caught as AgxCliError;
		expect(error.exitCode).toBe(EXIT.config);
		expect(error.message).toContain(path);
		return error;
	}

	describe("state.json", () => {
		it("loads a valid file (control)", () => {
			plant(statePath("default"), JSON.stringify({ version: 1, cursor: 42 }));
			expect(loadState("default").cursor).toBe(42);
		});

		it("starts empty when there is no file yet (control)", () => {
			expect(loadState("default").cursor).toBe(0);
		});

		it("refuses a file that is not JSON, and names it", () => {
			plant(statePath("default"), "{ \"cursor\": 4");
			expect(() => loadState("default")).toThrow(statePath("default"));
		});

		it("refuses a file with the wrong shape instead of resetting the cursor", () => {
			plant(statePath("default"), JSON.stringify({ version: 1, cursor: "soon" }));
			expect(() => loadState("default")).toThrow(statePath("default"));
		});

		it("refuses a file written by a newer version", () => {
			plant(statePath("default"), JSON.stringify({ version: 2, cursor: 500 }));
			expect(() => loadState("default")).toThrow(statePath("default"));
		});

		it("leaves a newer file untouched when something tries to update it", () => {
			const text = JSON.stringify({ version: 2, cursor: 500 });
			plant(statePath("default"), text);
			expect(() => updateState("default", { cursor: 1 })).toThrow();
			expect(readFileSync(statePath("default"), "utf8")).toBe(text);
		});

		it("refuses a file with no version, which is not one of ours", () => {
			plant(statePath("default"), JSON.stringify({ cursor: 7 }));
			refusal(() => loadState("default"), statePath("default"));
			plant(statePath("default"), "{}");
			refusal(() => loadState("default"), statePath("default"));
		});

		it("still loads a version 1 file that carries extra keys (control)", () => {
			plant(
				statePath("default"),
				JSON.stringify({ version: 1, cursor: 9, addedLater: true }),
			);
			expect(loadState("default").cursor).toBe(9);
		});

		it("does not put the file's text in the error", () => {
			plant(statePath("default"), "CANARY not json");
			const error = refusal(() => loadState("default"), statePath("default"));
			expect(`${error.message}\n${error.remediation}`).not.toContain(
				"CANARY",
			);
		});

		it("tells a damaged file apart from one it cannot read, and says what moving it costs", () => {
			plant(statePath("default"), "{");
			const damaged = refusal(() => loadState("default"), statePath("default"));
			expect(damaged.remediation).toContain("agx inbox");
			expect(damaged.remediation).toContain("cursor 0");

			// A directory where the file should be: access problem, not damage.
			rmSync(statePath("default"));
			mkdirSync(statePath("default"));
			const access = refusal(() => loadState("default"), statePath("default"));
			expect(access.remediation).not.toContain("mv ");
		});
	});

	describe("seen.json", () => {
		it("loads a version 2 file (control)", () => {
			plant(
				seenPath("default"),
				JSON.stringify({
					version: 2,
					entries: [{ id: "event-1", seenAt: Math.floor(Date.now() / 1000) }],
					failures: {},
				}),
			);
			expect(new FileSeenStore("default").has("event-1")).toBe(true);
		});

		it("still reads the older version 1 file (control)", () => {
			plant(seenPath("default"), JSON.stringify({ version: 1, ids: ["event-1"] }));
			expect(new FileSeenStore("default").has("event-1")).toBe(true);
		});

		it("refuses a file that is not JSON, and names it", () => {
			plant(seenPath("default"), "{ \"version\": 2, \"entries\": [");
			expect(() => new FileSeenStore("default")).toThrow(seenPath("default"));
		});

		it("refuses a file with the wrong shape instead of forgetting every id", () => {
			plant(
				seenPath("default"),
				JSON.stringify({ version: 2, entries: "event-1" }),
			);
			expect(() => new FileSeenStore("default")).toThrow(seenPath("default"));
		});

		it("refuses a file written by a newer version, and leaves it alone", () => {
			const text = JSON.stringify({ version: 3, entries: [{ id: "event-1" }] });
			plant(seenPath("default"), text);
			expect(() => new FileSeenStore("default")).toThrow(seenPath("default"));
			expect(readFileSync(seenPath("default"), "utf8")).toBe(text);
		});

		it("refuses a file that holds null", () => {
			plant(seenPath("default"), "null");
			refusal(() => new FileSeenStore("default"), seenPath("default"));
		});

		it("refuses entries with no version instead of reading them as an empty v1 store", () => {
			plant(
				seenPath("default"),
				JSON.stringify({ entries: [{ id: "event-1", seenAt: 1 }], failures: {} }),
			);
			refusal(() => new FileSeenStore("default"), seenPath("default"));
		});

		it("refuses a version 2 file with no entries list", () => {
			plant(seenPath("default"), JSON.stringify({ version: 2 }));
			refusal(() => new FileSeenStore("default"), seenPath("default"));
		});

		it("says moving it aside means answered requests are answered again, and names the safer order", () => {
			plant(seenPath("default"), "{");
			const error = refusal(
				() => new FileSeenStore("default"),
				seenPath("default"),
			);
			expect(error.remediation).toContain("agx inbox");
			expect(error.remediation).toContain("answered again");
		});
	});
});
